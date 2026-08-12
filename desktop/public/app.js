const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  keymap: null,
  selectedBinding: -1,
  selectedMacro: "",
  statusTimer: null,
  screenshotTimer: null,
  bootStartedAt: 0,
  bootTimer: null,
  activePanel: "runtime"
};

function invoke(channel, payload) {
  if (!window.oe || typeof window.oe.invoke !== "function") {
    return Promise.reject(new Error("Desktop shell is not available outside Electron."));
  }
  return window.oe.invoke(channel, payload);
}

function toast(message, tone = "ok") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${tone === "warn" || tone === "err" ? tone : ""}`;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.className = "toast";
  }, 3200);
}

function logTo(selector, value) {
  const node = $(selector);
  if (!node) return;
  node.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || "Working...";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function wireNavigation() {
  const activate = (panelName) => {
    state.activePanel = panelName;
    $$(".tool-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.panel === panelName));
    $$(".tool-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${panelName}`));
    $("#screen-frame").classList.toggle("keymap-mode", panelName === "keymap");
    renderDots();
    if (panelName === "keymap") refreshScreenshot();
  };

  $$(".tool-tab").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.panel));
  });
}

async function refreshStatus() {
  const status = await invoke("status");
  logTo("#status-output", status);
  const stage = status.stage || (status.running ? "booting" : "stopped");
  const running = stage === "ready" || stage === "booted" || status.running;
  $("#side-status").textContent = stage;
  $("#side-device").textContent = `adb: ${status.adbDevice || "none"}`;
  $("#runtime-pill").textContent = stage;
  $("#runtime-pill").classList.toggle("on", stage === "ready" || stage === "booted");
  $("#quick-start").textContent = running && stage !== "stopped" ? "Running" : "Start";
  updateBootOverlay(stage, status);
  return status;
}

function updateBootOverlay(stage, status) {
  const overlay = $("#boot-overlay");
  const readyStages = new Set(["ready", "booted"]);
  const booting = ["spawning", "adb", "booting", "hibernating"].includes(stage);
  if (!booting && readyStages.has(stage)) {
    overlay.hidden = true;
    stopBootTimer();
    return;
  }
  if (booting || (status && status.emulator === "running" && stage !== "ready")) {
    overlay.hidden = false;
    $("#boot-stage").textContent = stage;
    if (!state.bootStartedAt) state.bootStartedAt = Date.now();
    startBootTimer();
  } else {
    overlay.hidden = true;
    stopBootTimer();
  }
}

function startBootTimer() {
  if (state.bootTimer) return;
  state.bootTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.bootStartedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = String(elapsed % 60).padStart(2, "0");
    $("#boot-timer").textContent = `${m}:${s}`;
  }, 500);
}

function stopBootTimer() {
  if (state.bootTimer) {
    clearInterval(state.bootTimer);
    state.bootTimer = null;
  }
  state.bootStartedAt = 0;
}

async function refreshScreenshot() {
  const result = await invoke("screenshot");
  if (result && result.dataUrl) {
    $("#guest-screen").src = result.dataUrl;
  }
  renderDots();
}

function wireViewport() {
  $("#refresh-status").addEventListener("click", () => refreshStatus().catch(showError));
  $("#shot-now").addEventListener("click", () => refreshScreenshot().catch(showError));
  $("#quick-start").addEventListener("click", () => startEmulator($("#quick-start")));
  $("#quick-stop").addEventListener("click", () => stopEmulator($("#quick-stop")));
  $("#start-btn").addEventListener("click", () => startEmulator($("#start-btn")));
  $("#stop-btn").addEventListener("click", () => stopEmulator($("#stop-btn")));

  $("#screen-frame").addEventListener("click", (event) => {
    if (state.activePanel !== "keymap" || !state.keymap) return;
    if (event.target.classList.contains("binding-dot")) return;
    const rect = $("#screen-frame").getBoundingClientRect();
    const display = state.keymap.display || { width: 1080, height: 1920 };
    const x = Math.round(((event.clientX - rect.left) / rect.width) * display.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * display.height);
    state.selectedBinding = -1;
    $("#binding-x").value = x;
    $("#binding-y").value = y;
    $$(".tool-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.panel === "keymap"));
    $$(".tool-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-keymap"));
    $("#binding-key").focus();
    toast(`Placed point at ${x}, ${y}`);
  });
}

async function startEmulator(button) {
  setBusy(button, true, "Starting...");
  state.bootStartedAt = Date.now();
  $("#boot-overlay").hidden = false;
  $("#boot-stage").textContent = "spawning";
  try {
    const result = await invoke("start", { cold: $("#cold-start").checked, async: true });
    logTo("#status-output", result);
    toast(result.message || "Emulator start requested");
    await refreshStatus();
    refreshScreenshot();
    const poll = setInterval(async () => {
      try {
        const s = await refreshStatus();
        if (s.stage === "ready" || s.stage === "booted") clearInterval(poll);
      } catch {
        clearInterval(poll);
      }
    }, 2000);
  } catch (err) {
    showError(err);
  } finally {
    setBusy(button, false);
  }
}

async function stopEmulator(button) {
  setBusy(button, true, "Stopping...");
  try {
    const result = await invoke("stop");
    logTo("#status-output", result);
    toast("Emulator stopped");
    await refreshStatus();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(button, false);
  }
}

function wireInstall() {
  $("#choose-apk").addEventListener("click", async () => {
    try {
      const path = await invoke("pick-apk");
      if (path) {
        $("#apk-path").value = path;
        await installApkPath(path);
      }
    } catch (err) {
      showError(err, "#install-log");
    }
  });
  $("#apk-input").addEventListener("change", () => {
    const file = $("#apk-input").files[0];
    if (file && file.path) {
      $("#apk-path").value = file.path;
      installApkPath(file.path);
    }
  });
  $("#install-apk").addEventListener("click", () => installApkPath($("#apk-path").value));

  const drop = $("#apk-drop");
  ["dragenter", "dragover"].forEach((eventName) => {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
    });
  });
  drop.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file && file.path) {
      $("#apk-path").value = file.path;
      installApkPath(file.path);
    }
  });
}

async function installApkPath(apkPath) {
  if (!apkPath) return toast("Enter an APK path first", "warn");
  logTo("#install-log", "Installing...");
  try {
    const result = await invoke("install", apkPath);
    logTo("#install-log", result);
    toast("APK install complete");
  } catch (err) {
    showError(err, "#install-log");
  }
}

function wireKeymap() {
  $("#reload-keymap").addEventListener("click", () => loadKeymap().catch(showError));
  $("#save-keymap").addEventListener("click", () => saveKeymap().catch(showError));
  $("#add-binding").addEventListener("click", addOrUpdateBinding);
}

async function loadKeymap() {
  state.keymap = await invoke("keymap-get");
  state.selectedBinding = -1;
  renderBindings();
  renderDots();
}

async function saveKeymap() {
  const saved = await invoke("keymap-save", state.keymap);
  state.keymap = saved;
  renderBindings();
  renderDots();
  toast("Keymap saved");
}

function addOrUpdateBinding() {
  if (!state.keymap) return;
  const binding = {
    key: $("#binding-key").value.trim(),
    label: $("#binding-label").value.trim() || $("#binding-key").value.trim(),
    type: $("#binding-type").value,
    x: Number($("#binding-x").value),
    y: Number($("#binding-y").value)
  };
  if (!binding.key) return toast("Key is required", "warn");
  if (!Number.isFinite(binding.x) || !Number.isFinite(binding.y)) return toast("Coordinates are required", "warn");
  const existing = state.keymap.bindings.findIndex((item) => item.key === binding.key);
  if (state.selectedBinding >= 0) {
    state.keymap.bindings[state.selectedBinding] = binding;
  } else if (existing >= 0) {
    state.keymap.bindings[existing] = binding;
  } else {
    state.keymap.bindings.push(binding);
  }
  state.selectedBinding = -1;
  renderBindings();
  renderDots();
  toast("Binding staged; save to persist");
}

function renderBindings() {
  const list = $("#binding-list");
  list.innerHTML = "";
  const bindings = state.keymap ? state.keymap.bindings || [] : [];
  bindings.forEach((binding, index) => {
    const row = document.createElement("div");
    row.className = "binding-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(binding.key)}</strong>
        <small>${escapeHtml(binding.label || binding.type)} · ${escapeHtml(binding.type)} · ${binding.x || "-"}, ${binding.y || "-"}</small>
      </div>
      <div class="row-actions">
        <button class="ghost small" data-action="edit">Edit</button>
        <button class="ghost small" data-action="fire">Fire</button>
        <button class="danger small" data-action="delete">Del</button>
      </div>`;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => selectBinding(index));
    row.querySelector('[data-action="fire"]').addEventListener("click", () => fireBinding(binding.key));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.keymap.bindings.splice(index, 1);
      state.selectedBinding = -1;
      renderBindings();
      renderDots();
    });
    if (index === state.selectedBinding) row.classList.add("active");
    list.appendChild(row);
  });
}

function selectBinding(index) {
  state.selectedBinding = index;
  const binding = state.keymap.bindings[index];
  $("#binding-key").value = binding.key || "";
  $("#binding-label").value = binding.label || "";
  $("#binding-type").value = binding.type || "tap";
  $("#binding-x").value = binding.x || "";
  $("#binding-y").value = binding.y || "";
  renderBindings();
  renderDots();
}

async function fireBinding(key) {
  try {
    await invoke("keymap-fire", key);
    toast(`Fired ${key}`);
  } catch (err) {
    showError(err);
  }
}

function renderDots() {
  const frame = $("#screen-frame");
  frame.querySelectorAll(".binding-dot").forEach((node) => node.remove());
  if (state.activePanel !== "keymap" || !state.keymap) return;
  const display = state.keymap.display || { width: 1080, height: 1920 };
  (state.keymap.bindings || []).forEach((binding, index) => {
    if (!Number.isFinite(binding.x) || !Number.isFinite(binding.y)) return;
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "binding-dot";
    dot.textContent = String(binding.key || "?").slice(0, 2);
    dot.style.left = `${(binding.x / display.width) * 100}%`;
    dot.style.top = `${(binding.y / display.height) * 100}%`;
    if (index === state.selectedBinding) dot.classList.add("active");
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      selectBinding(index);
    });
    frame.appendChild(dot);
  });
}

function wireInstances() {
  $("#create-instance").addEventListener("click", async () => {
    try {
      await invoke("instance-create", { name: $("#instance-name").value });
      toast("Instance created");
      await loadInstances();
    } catch (err) {
      showError(err);
    }
  });
  $("#refresh-instances").addEventListener("click", () => loadInstances().catch(showError));
}

async function loadInstances() {
  const instances = await invoke("instances");
  const list = $("#instance-list");
  list.innerHTML = "";
  instances.forEach((instance) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(instance.name)}</strong>
        <small>${escapeHtml(instance.status || "stopped")} · base ${escapeHtml(instance.base || "main")}</small>
      </div>
      <div class="row-actions">
        <button class="ghost small" data-action="start">Start</button>
        <button class="ghost small" data-action="stop">Stop</button>
        <button class="ghost small" data-action="clone">Clone</button>
      </div>`;
    row.querySelector('[data-action="start"]').addEventListener("click", () => instanceAction(instance.name, "start"));
    row.querySelector('[data-action="stop"]').addEventListener("click", () => instanceAction(instance.name, "stop"));
    row.querySelector('[data-action="clone"]').addEventListener("click", () => cloneInstance(instance.name));
    list.appendChild(row);
  });
}

async function instanceAction(name, action) {
  try {
    await invoke(action === "start" ? "instance-start" : "instance-stop", name);
    toast(`${action} ${name}`);
    await loadInstances();
    await refreshStatus();
  } catch (err) {
    showError(err);
  }
}

async function cloneInstance(name) {
  const target = `${name}-clone`;
  try {
    await invoke("instance-clone", { name, target });
    toast(`Cloned ${name} → ${target}`);
    await loadInstances();
  } catch (err) {
    showError(err);
  }
}

function wireMacros() {
  $("#refresh-macros").addEventListener("click", () => loadMacros().catch(showError));
  $("#run-macro").addEventListener("click", async () => {
    const name = $("#macro-name").value.trim() || state.selectedMacro;
    if (!name) return toast("Select or enter a macro", "warn");
    try {
      logTo("#macro-log", "Running...");
      const result = await invoke("macro-run", { name, loop: $("#macro-loop").value });
      logTo("#macro-log", result);
      toast(`Macro ${name} finished`);
    } catch (err) {
      showError(err, "#macro-log");
    }
  });
}

async function loadMacros() {
  const macros = await invoke("macros");
  const list = $("#macro-list");
  list.innerHTML = "";
  macros.forEach((macro) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(macro.name)}</strong>
        <small>${escapeHtml(macro.description || "")}</small>
      </div>`;
    row.addEventListener("click", () => {
      state.selectedMacro = macro.name;
      $("#macro-name").value = macro.name;
      $$(".table-row").forEach((node) => node.classList.remove("selected"));
      row.classList.add("selected");
    });
    list.appendChild(row);
  });
}

function wirePerformance() {
  $("#save-performance").addEventListener("click", async () => {
    const perf = {
      cores: $("#perf-cores").value,
      memory: $("#perf-memory").value,
      gpu: $("#perf-gpu").value,
      fps: $("#perf-fps").value
    };
    try {
      const result = await invoke("performance-set", perf);
      logTo("#device-log", result);
      toast("Performance profile saved");
    } catch (err) {
      showError(err, "#device-log");
    }
  });
  $("#apply-display").addEventListener("click", () => deviceAction("display", { preset: $("#display-preset").value }));
  $("#apply-audio").addEventListener("click", () => deviceAction("audio", { action: $("#audio-action").value }));
  $("#apply-network").addEventListener("click", () => deviceAction("network", { action: $("#network-action").value }));
}

async function loadPerformance() {
  const perf = await invoke("performance-get");
  $("#perf-cores").value = perf.cores;
  $("#perf-memory").value = perf.memory;
  $("#perf-gpu").value = perf.gpu;
  $("#perf-fps").value = perf.fps;
}

async function deviceAction(channel, body) {
  try {
    const result = await invoke(channel, body);
    logTo("#device-log", result);
    toast(`${channel} command sent`);
  } catch (err) {
    showError(err, "#device-log");
  }
}

function wireFiles() {
  $("#push-file").addEventListener("click", () => fileAction("files-push", {
    local: $("#push-local").value,
    remote: $("#push-remote").value
  }));
  $("#pull-file").addEventListener("click", () => fileAction("files-pull", {
    remote: $("#pull-remote").value,
    local: $("#pull-local").value
  }));
}

async function fileAction(channel, body) {
  try {
    logTo("#files-log", "Transferring...");
    const result = await invoke(channel, body);
    logTo("#files-log", result);
    toast("File transfer complete");
  } catch (err) {
    showError(err, "#files-log");
  }
}

function wireLocation() {
  $("#send-gps").addEventListener("click", async () => {
    try {
      logTo("#gps-log", "Sending GPS fix...");
      const result = await invoke("gps", { lat: $("#gps-lat").value, lng: $("#gps-lng").value });
      logTo("#gps-log", result);
      toast(result.ok ? "GPS sent" : "GPS saved; emulator console unavailable", result.ok ? "ok" : "warn");
    } catch (err) {
      showError(err, "#gps-log");
    }
  });
}

function showError(err, logSelector) {
  toast(err.message || String(err), "err");
  if (logSelector) logTo(logSelector, err.message || String(err));
}

async function boot() {
  wireNavigation();
  wireViewport();
  wireInstall();
  wireKeymap();
  wireInstances();
  wireMacros();
  wirePerformance();
  wireFiles();
  wireLocation();

  await Promise.allSettled([
    refreshStatus(),
    loadKeymap(),
    loadInstances(),
    loadMacros(),
    loadPerformance()
  ]);
  refreshScreenshot();
  state.statusTimer = setInterval(() => refreshStatus().catch(() => {}), 3000);
  state.screenshotTimer = setInterval(() => refreshScreenshot().catch(() => {}), 9000);
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch(showError);
});
