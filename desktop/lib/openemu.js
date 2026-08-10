const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");
const OPEN_EMU = path.join(REPO_ROOT, "android", "bin", "open-emu");
const ANDROID_ROOT = path.join(REPO_ROOT, "android");
const ANDROID_STATE = path.join(ANDROID_ROOT, "state");
const ANDROID_KEYMAPS = path.join(ANDROID_ROOT, "config", "keymaps");
const DATA_DIR = path.join(DESKTOP_ROOT, "data");
const UPLOAD_DIR = path.join(DESKTOP_ROOT, "uploads");
const SCREENSHOT_FILE = path.join(DATA_DIR, "screen.png");
const PERFORMANCE_FILE = path.join(DATA_DIR, "performance.json");
const INSTANCES_FILE = path.join(DATA_DIR, "instances.json");
const MACROS_FILE = path.join(DATA_DIR, "macros.json");
const GPS_FILE = path.join(DATA_DIR, "gps.json");
const ACTIVE_KEYMAP = path.join(ANDROID_STATE, "active_keymap.json");
const CUSTOM_KEYMAP = path.join(ANDROID_STATE, "custom_keymap.json");
const DEFAULT_KEYMAP = path.join(ANDROID_KEYMAPS, "default.json");

const DEFAULT_PERFORMANCE = {
  cores: 2,
  memory: 3072,
  gpu: "swiftshader",
  fps: 60
};

const DEFAULT_INSTANCES = [
  {
    name: "main",
    status: "stopped",
    base: null,
    createdAt: new Date(0).toISOString()
  }
];

const DEFAULT_MACROS = [
  {
    name: "wake-and-home",
    description: "Wake the emulator and press Home.",
    steps: [
      { type: "keyevent", code: "KEYCODE_WAKEUP", delay: 250 },
      { type: "keyevent", code: "KEYCODE_HOME", delay: 250 }
    ]
  },
  {
    name: "center-tap",
    description: "Tap the center of a 1080x1920 display.",
    steps: [{ type: "tap", x: 540, y: 960, delay: 150 }]
  }
];

const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

ensureDirsSync();

function ensureDirsSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(ANDROID_STATE, { recursive: true });
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(ANDROID_STATE, { recursive: true });
}

function commandEnv(extra = {}) {
  const perf = readJsonSync(PERFORMANCE_FILE, DEFAULT_PERFORMANCE);
  const env = {
    ...process.env,
    ANDROID_CORES: String(perf.cores || DEFAULT_PERFORMANCE.cores),
    ANDROID_MEMORY_MB: String(perf.memory || DEFAULT_PERFORMANCE.memory),
    ANDROID_GPU_MODE: String(perf.gpu || DEFAULT_PERFORMANCE.gpu),
    ...extra
  };
  return env;
}

function runOpenEmu(args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    const child = spawn(OPEN_EMU, args, {
      cwd: REPO_ROOT,
      env: commandEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      const err = new Error(`open-emu ${args.join(" ")} timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ code, signal, stdout, stderr, lines: toLines(stdout) });
        return;
      }
      const err = new Error(`open-emu ${args.join(" ")} exited with ${code ?? signal}`);
      err.code = code;
      err.signal = signal;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function toLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseStatus(text) {
  const status = {
    ok: true,
    raw: text || "",
    running: false,
    emulator: "unknown",
    adbDevice: "none"
  };

  for (const line of toLines(text)) {
    if (line.startsWith("emulator=")) {
      status.emulator = line.slice("emulator=".length);
      status.running = status.emulator === "running";
    } else if (line.startsWith("adb_device=")) {
      status.adbDevice = line.slice("adb_device=".length);
    } else if (line.startsWith("avd=")) {
      status.avd = line.slice("avd=".length);
    } else if (line.startsWith("pid=")) {
      status.pid = line.slice("pid=".length);
    } else if (line.startsWith("boot_completed=")) {
      status.bootCompleted = line.slice("boot_completed=".length);
    } else if (line.startsWith("android=")) {
      status.android = line.slice("android=".length);
    } else if (line.startsWith("display=")) {
      status.display = line.slice("display=".length);
    } else if (line.startsWith("density=")) {
      status.density = line.slice("density=".length);
    } else if (line.startsWith("snapshot=")) {
      status.snapshot = line.slice("snapshot=".length);
    } else if (line.startsWith("profile=")) {
      status.profile = line.slice("profile=".length);
    }
  }

  return status;
}

function errorPayload(err) {
  return {
    ok: false,
    error: err.message,
    stdout: err.stdout || "",
    stderr: err.stderr || ""
  };
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDirs();
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function status() {
  await ensureDirs();
  try {
    const result = await runOpenEmu(["status"], { timeoutMs: 12000 });
    return parseStatus(result.stdout);
  } catch (err) {
    const parsed = parseStatus(err.stdout || "");
    return {
      ...parsed,
      ...errorPayload(err),
      running: parsed.running || false,
      emulator: parsed.emulator === "unknown" ? "unavailable" : parsed.emulator,
      adbDevice: parsed.adbDevice || "none"
    };
  }
}

async function start(options = {}) {
  const args = ["start"];
  if (options.cold) args.push("--cold");
  const result = await runOpenEmu(args, { timeoutMs: 30 * 60 * 1000 });
  return { ok: true, output: result.stdout, stderr: result.stderr, status: parseStatus(result.stdout) };
}

async function stop() {
  const result = await runOpenEmu(["stop"], { timeoutMs: 120000 });
  return { ok: true, output: result.stdout, stderr: result.stderr };
}

async function install(apkPath) {
  if (!apkPath) {
    throw new Error("APK path is required");
  }
  const resolved = path.resolve(apkPath);
  await fsp.access(resolved, fs.constants.R_OK);
  const result = await runOpenEmu(["install", resolved], { timeoutMs: 10 * 60 * 1000 });
  return { ok: true, apk: resolved, output: result.stdout, stderr: result.stderr };
}

async function screenshot() {
  await ensureDirs();
  try {
    await runOpenEmu(["screenshot", SCREENSHOT_FILE], { timeoutMs: 45000 });
    return await fsp.readFile(SCREENSHOT_FILE);
  } catch (err) {
    err.placeholder = PLACEHOLDER_PNG;
    throw err;
  }
}

async function keymap() {
  await ensureDirs();
  const active = await resolveActiveKeymap();
  const value = await readJson(active, await readJson(DEFAULT_KEYMAP, emptyKeymap()));
  return {
    ...value,
    source: active
  };
}

async function saveKeymap(value) {
  await ensureDirs();
  const next = normalizeKeymap(value);
  await writeJson(CUSTOM_KEYMAP, next);
  await linkActiveKeymap();
  return { ...next, source: CUSTOM_KEYMAP };
}

async function fireKey(key) {
  if (!key) throw new Error("key is required");
  const result = await runOpenEmu(["keymap", "fire", key], { timeoutMs: 5 * 60 * 1000 });
  return { ok: true, key, output: result.stdout, stderr: result.stderr };
}

async function resolveActiveKeymap() {
  try {
    const target = await fsp.realpath(ACTIVE_KEYMAP);
    await fsp.access(target, fs.constants.R_OK);
    return target;
  } catch {
    return DEFAULT_KEYMAP;
  }
}

async function linkActiveKeymap() {
  try {
    await fsp.unlink(ACTIVE_KEYMAP);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    await fsp.symlink(CUSTOM_KEYMAP, ACTIVE_KEYMAP);
  } catch {
    await fsp.copyFile(CUSTOM_KEYMAP, ACTIVE_KEYMAP);
  }
}

function normalizeKeymap(value = {}) {
  const display = value.display || {};
  return {
    name: value.name || "desktop-custom",
    description: value.description || "Created with the open-emulator desktop shell.",
    display: {
      width: Number(display.width) || 1080,
      height: Number(display.height) || 1920
    },
    bindings: Array.isArray(value.bindings)
      ? value.bindings.map((binding) => ({
          key: String(binding.key || "").trim(),
          type: binding.type || "tap",
          x: Number(binding.x) || 0,
          y: Number(binding.y) || 0,
          label: binding.label || binding.key || "Binding",
          ...(binding.code ? { code: binding.code } : {})
        })).filter((binding) => binding.key)
      : []
  };
}

function emptyKeymap() {
  return {
    name: "desktop-custom",
    description: "Created with the open-emulator desktop shell.",
    display: { width: 1080, height: 1920 },
    bindings: []
  };
}

async function instances() {
  const list = await readJson(INSTANCES_FILE, DEFAULT_INSTANCES);
  const current = await status();
  return list.map((instance) => ({
    ...instance,
    status: instance.name === "main" && current.running ? "running" : instance.status || "stopped"
  }));
}

async function createInstance(input = {}) {
  const name = cleanName(input.name);
  if (!name) throw new Error("instance name is required");
  const list = await instances();
  if (list.some((instance) => instance.name === name)) {
    throw new Error(`instance already exists: ${name}`);
  }
  const next = [
    ...list,
    {
      name,
      base: input.base || "main",
      status: "stopped",
      createdAt: new Date().toISOString()
    }
  ];
  await writeJson(INSTANCES_FILE, next);
  return next;
}

async function startInstance(name) {
  if (cleanName(name) !== "main") {
    await setInstanceStatus(name, "selected");
    return { ok: true, name, output: "open-emu currently runs one Android AVD; selected instance profile only." };
  }
  return start();
}

async function stopInstance(name) {
  if (cleanName(name) !== "main") {
    await setInstanceStatus(name, "stopped");
    return { ok: true, name, output: "instance profile stopped" };
  }
  return stop();
}

async function cloneInstance(name, target) {
  const list = await instances();
  const source = list.find((instance) => instance.name === cleanName(name));
  if (!source) throw new Error(`instance not found: ${name}`);
  return createInstance({ name: target || `${source.name}-clone`, base: source.name });
}

async function setInstanceStatus(name, nextStatus) {
  const clean = cleanName(name);
  const list = await instances();
  const next = list.map((instance) =>
    instance.name === clean ? { ...instance, status: nextStatus } : instance
  );
  await writeJson(INSTANCES_FILE, next);
  return next;
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function macros() {
  return readJson(MACROS_FILE, DEFAULT_MACROS);
}

async function saveMacro(input = {}) {
  const name = cleanName(input.name);
  if (!name) throw new Error("macro name is required");
  const list = await macros();
  const macro = {
    name,
    description: input.description || "Desktop macro",
    steps: Array.isArray(input.steps) ? input.steps : []
  };
  const next = [...list.filter((item) => item.name !== name), macro];
  await writeJson(MACROS_FILE, next);
  return macro;
}

async function runMacro(name, loop = 1) {
  const macro = (await macros()).find((item) => item.name === cleanName(name));
  if (!macro) throw new Error(`macro not found: ${name}`);
  const loops = Math.max(1, Math.min(Number(loop) || 1, 999));
  const output = [];
  for (let round = 0; round < loops; round += 1) {
    for (const step of macro.steps || []) {
      output.push(await runMacroStep(step));
      if (step.delay) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.delay), 5000)));
      }
    }
  }
  return { ok: true, name: macro.name, loop: loops, output };
}

async function runMacroStep(step = {}) {
  if (step.type === "keymap" && step.key) {
    return fireKey(step.key);
  }
  if (step.type === "keyevent" && step.code) {
    const result = await runOpenEmu(["shell", "input", "keyevent", String(step.code)], { timeoutMs: 30000 });
    return { type: "keyevent", code: step.code, output: result.stdout };
  }
  if (step.type === "text" && step.text) {
    const escaped = String(step.text).replace(/\s/g, "%s");
    const result = await runOpenEmu(["shell", "input", "text", escaped], { timeoutMs: 30000 });
    return { type: "text", text: step.text, output: result.stdout };
  }
  if (step.type === "swipe") {
    const result = await runOpenEmu(
      ["shell", "input", "swipe", String(step.x1), String(step.y1), String(step.x2), String(step.y2), String(step.duration || 300)],
      { timeoutMs: 30000 }
    );
    return { type: "swipe", output: result.stdout };
  }
  const result = await runOpenEmu(["shell", "input", "tap", String(step.x || 0), String(step.y || 0)], {
    timeoutMs: 30000
  });
  return { type: "tap", x: step.x || 0, y: step.y || 0, output: result.stdout };
}

async function performance(input) {
  if (!input) return readJson(PERFORMANCE_FILE, DEFAULT_PERFORMANCE);
  const next = {
    cores: clamp(input.cores, 1, 16, DEFAULT_PERFORMANCE.cores),
    memory: clamp(input.memory, 512, 32768, DEFAULT_PERFORMANCE.memory),
    gpu: String(input.gpu || DEFAULT_PERFORMANCE.gpu),
    fps: clamp(input.fps, 15, 240, DEFAULT_PERFORMANCE.fps)
  };
  await writeJson(PERFORMANCE_FILE, next);
  return next;
}

async function fps(value) {
  const current = await performance();
  return performance({ ...current, fps: value });
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

async function sharePush(local, remote) {
  if (!local || !remote) throw new Error("local and remote paths are required");
  const result = await runOpenEmu(["push", path.resolve(local), remote], { timeoutMs: 5 * 60 * 1000 });
  return { ok: true, local, remote, output: result.stdout, stderr: result.stderr };
}

async function sharePull(remote, local) {
  if (!local || !remote) throw new Error("remote and local paths are required");
  const result = await runOpenEmu(["pull", remote, path.resolve(local)], { timeoutMs: 5 * 60 * 1000 });
  return { ok: true, local, remote, output: result.stdout, stderr: result.stderr };
}

async function gps(lat, lng) {
  const next = { lat: Number(lat), lng: Number(lng), updatedAt: new Date().toISOString() };
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) {
    throw new Error("lat and lng must be numbers");
  }
  await writeJson(GPS_FILE, next);
  try {
    const output = await emulatorConsole([`geo fix ${next.lng} ${next.lat}`], 10000);
    return { ok: true, ...next, output };
  } catch (err) {
    return { ok: false, ...next, error: err.message };
  }
}

async function display(input = {}) {
  const preset = input.preset || input.size || (input.width && input.height ? `${input.width}x${input.height}` : "");
  const result = await runOpenEmu(["display", preset].filter(Boolean), { timeoutMs: 120000 });
  return { ok: true, preset, output: result.stdout, stderr: result.stderr };
}

async function audio(input = {}) {
  const action = input.test ? "test" : input.action || "";
  const result = await runOpenEmu(["audio", action].filter(Boolean), { timeoutMs: 120000 });
  return { ok: true, action: action || "status", output: result.stdout, stderr: result.stderr };
}

async function network(input = {}) {
  const args = ["network", input.action || "status"];
  if (input.spec) args.push(input.spec);
  const result = await runOpenEmu(args, { timeoutMs: 120000 });
  return { ok: true, action: input.action || "status", output: result.stdout, stderr: result.stderr };
}

async function emulatorConsole(commands, timeoutMs) {
  const tokenPath = path.join(process.env.HOME || "", ".emulator_console_auth_token");
  let token = "";
  try {
    token = (await fsp.readFile(tokenPath, "utf8")).trim();
  } catch {
    token = "";
  }
  const payload = [`auth ${token}`, ...commands, "quit"].join("\n") + "\n";
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 5554 });
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("emulator console timed out"));
    }, timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

module.exports = {
  DATA_DIR,
  UPLOAD_DIR,
  PLACEHOLDER_PNG,
  errorPayload,
  status,
  start,
  stop,
  install,
  screenshot,
  keymap,
  saveKeymap,
  fireKey,
  instances,
  createInstance,
  startInstance,
  stopInstance,
  cloneInstance,
  macros,
  saveMacro,
  runMacro,
  performance,
  fps,
  sharePush,
  sharePull,
  gps,
  display,
  audio,
  network
};
