const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const paths = require("./paths");
const { shortcutInstalled, installShortcut } = require("./shortcut");

const ANDROID_CODE_ROOT = paths.androidCodeRoot();
const SETUP_FILE = path.join(paths.desktopDataRoot(), "setup.json");
const OPEN_EMU = paths.openEmuBin();
const FETCH_SCRIPT = path.join(ANDROID_CODE_ROOT, "scripts", "fetch_android.sh");
const SETUP_AVD = path.join(ANDROID_CODE_ROOT, "scripts", "setup_avd.sh");
const SDK_LICENSE_URL = "https://developer.android.com/studio/terms";

function sdkPresent() {
  return fs.existsSync(path.join(paths.androidDataRoot(), "sdk", "emulator", "emulator"));
}

function avdPresent() {
  return fs.existsSync(path.join(paths.androidDataRoot(), "avd", "OpenEmulator_API30.avd"));
}

function readSetup() {
  try {
    return JSON.parse(fs.readFileSync(SETUP_FILE, "utf8"));
  } catch {
    return { completed: false };
  }
}

async function writeSetup(value) {
  await fsp.mkdir(path.dirname(SETUP_FILE), { recursive: true });
  await fsp.writeFile(SETUP_FILE, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function setupStatus() {
  const saved = readSetup();
  const sdk = sdkPresent();
  const avd = avdPresent();
  return {
    completed: Boolean(saved.completed) && sdk && avd,
    sdk,
    avd,
    sdkLicenseAccepted: Boolean(saved.sdkLicenseAccepted),
    sdkLicenseUrl: SDK_LICENSE_URL,
    shortcut: shortcutInstalled(),
    saved
  };
}

async function acceptSdkLicense(accepted) {
  const current = readSetup();
  const next = {
    ...current,
    sdkLicenseAccepted: Boolean(accepted),
    sdkLicenseAcceptedAt: accepted ? new Date().toISOString() : null
  };
  await writeSetup(next);
  return { ok: true, sdkLicenseAccepted: next.sdkLicenseAccepted };
}

function parseKv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function runScript(command, args, onLine, timeoutMs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: paths.resourcesRoot(),
      env: { ...process.env, ANDROID_HEADLESS: "1", ...paths.androidEnvOverrides(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const emit = (chunk, stream) => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onLine) onLine(line);
      }
    };
    child.stdout.on("data", (chunk) => emit(chunk, "stdout"));
    child.stderr.on("data", (chunk) => emit(chunk, "stderr"));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const err = new Error(`${path.basename(command)} timed out`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      const err = new Error(`${path.basename(command)} exited with ${code}`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function hostCheck(onLine) {
  const result = await runScript(OPEN_EMU, ["host-check"], onLine, 30000);
  return { ok: true, ...parseKv(result.stdout), output: result.stdout };
}

async function runStep(step, onLine) {
  if (step === "host") return hostCheck(onLine);
  if (step === "fetch") {
    if (!readSetup().sdkLicenseAccepted) {
      throw new Error(
        `Accept the Android SDK License Agreement first (${SDK_LICENSE_URL}).`
      );
    }
    if (sdkPresent()) {
      onLine && onLine("SDK already present — skipping download.");
      return { ok: true, skipped: true };
    }
    return runScript(FETCH_SCRIPT, [], onLine, 2 * 60 * 60 * 1000, {
      ANDROID_SDK_LICENSE_ACCEPTED: "1"
    });
  }
  if (step === "avd") {
    const result = await runScript(SETUP_AVD, [], onLine, 10 * 60 * 1000);
    await runScript(OPEN_EMU, ["instance", "ensure-main"], onLine, 30000);
    return result;
  }
  if (step === "shortcut") {
    onLine && onLine("Writing desktop shortcut…");
    return installShortcut({ desktop: true });
  }
  throw new Error(`unknown setup step: ${step}`);
}

async function complete(options = {}) {
  const next = {
    ...readSetup(),
    completed: true,
    completedAt: new Date().toISOString(),
    shortcut: Boolean(options.shortcut)
  };
  if (options.shortcut) {
    await installShortcut({ desktop: true });
  }
  await writeSetup(next);
  return next;
}

module.exports = {
  SETUP_FILE,
  SDK_LICENSE_URL,
  setupStatus,
  runStep,
  complete,
  acceptSdkLicense,
  sdkPresent,
  avdPresent
};
