const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  keymap: null,
  selectedBinding: -1,
  selectedMacro: "",
  statusTimer: null,
  screenshotTimer: null
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function toast(message, tone = "ok") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${tone}`;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.className = "toast";
  }, 3200);
}

function logTo(selector, value) {
  const node = $(selector);
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

function wireNavigation() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".nav-item").forEach((item) => item.classList.remove("active"));
      $$(".panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      $(`#panel-${button.dataset.panel}`).classList.add("active");
      if (button.dataset.panel === "keymap") {
        refreshScreenshot();
      }
    });
  });
}

async function refreshStatus() {
  const status = await api("/api/status");
  const pretty = JSON.stringify(status, null, 2);
  $("#status-output").textContent = pretty;
  $("#side-status").textContent = status.running ? "running" : status.emulator || "stopped";
  $("#side-device").textContent = `adb: ${status.adbDevice || "none"}`;
  $("#runtime-pill").textContent = status.running ? "running" : "stopped";
  $("#runtime-pill").classList.toggle("on", Boolean(status.running));
  $("#quick-start").textContent = status.running ? "Running" : "Start";
  return status;
}

function refreshScreenshot() {
  const stamp = Date.now();
  $("#home-screenshot").src = `/api/screenshot?t=${stamp}`;
  $("#keymap-screenshot").src = `/api/screenshot?t=${stamp}`;
}

function wireHome() {
  $("#refresh-status").addEventListener("click", () => refreshStatus().catch(showError));
  $("#shot-now").addEventListener("click", refreshScreenshot);
  $("#quick-start").addEventListener("click", () => startEmulator($("#quick-start")));
  $("#start-btn").addEventListener("click", () => startEmulator($("#start-btn")));
  $("#stop-btn").addEventListener("click", () => stopEmulator($("#stop-btn")));
  $("#choose-apk").addEventListener("click", () => $("#apk-input").click());
  $("#apk-input").addEventListener("change", () => {
    const file = $("#apk-input").files[0];
    if (file) installApkFile(file);
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
    if (file) installApkFile(file);
  });
}

async function startEmulator(button) {
  setBusy(button, true, "Starting...");
  try {
    const result = await api("/api/start", { method: "POST", body: { cold: $("#cold-start").checked } });
    logTo("#status-output", result);
    toast("Emulator start requested");
    await refreshStatus();
    refreshScreenshot();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(button, false);
  }
}

async function stopEmulator(button) {
  setBusy(button, true, "Stopping...");
  try {
    const result = await api("/api/stop", { method: "POST", body: {} });
    logTo("#status-output", result);
    toast("Emulator stopped");
    await refreshStatus();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(button, false);
  }
}

async function installApkPath(apkPath) {
  if (!apkPath) return toast("Enter an APK path first", "warn");
  logTo("#install-log", "Installing...");
  try {
    const result = await api("/api/install", { method: "POST", body: { path: apkPath } });
    logTo("#install-log", result);
    toast("APK install complete");
  } catch (err) {
    showError(err, "#install-log");
  }
}

async function installApkFile(file) {
  const form = new FormData();
  form.append("apk", file);
  logTo("#install-log", `Uploading ${file.name}...`);
  try {
    const result = await api("/api/install", { method: "POST", body: form });
    logTo("#install-log", result);
    toast("APK uploaded and install requested");
  } catch (err) {
    showError(err, "#install-log");
  }
}

function wireKeymap() {
  $("#reload-keymap").addEventListener("click", () => loadKeymap().catch(showError));
  $("#save-keymap").addEventListener("click", () => saveKeymap().catch(showError));
  $("#add-binding").addEventListener("click", addOrUpdateBinding);
  $("#keymap-stage").addEventListener("click", (event) => {
    if (event.target.classList.contains("binding-dot")) return;
    if (!state.keymap) return;
    const rect = $("#keymap-stage").getBoundingClientRect();
    const display = state.keymap.display || { width: 1080, height: 1920 };
    const x = Math.round(((event.clientX - rect.left) / rect.width) * display.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * display.height);
    state.selectedBinding = -1;
    $("#binding-x").value = x;
    $("#binding-y").value = y;
    $("#binding-key").focus();
    toast(`Placed point at ${x}, ${y}`);
  });
}

async function loadKeymap() {
  state.keymap = await api("/api/keymap");
  state.selectedBinding = -1;
  renderBindings();
  renderDots();
}

async function saveKeymap() {
  const saved = await api("/api/keymap", { method: "PUT", body: state.keymap });
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
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => selectBinding(index));
    row.querySelector('[data-action="fire"]').addEventListener("click", () => fireBinding(binding.key));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.keymap.bindings.splice(index, 1);
      renderBindings();
      renderDots();
    });
    list.appendChild(row);
  });
}

function renderDots() {
  const layer = $("#binding-layer");
  layer.innerHTML = "";
  if (!state.keymap) return;
  const display = state.keymap.display || { width: 1080, height: 1920 };
  (state.keymap.bindings || [])
    .filter((binding) => Number.isFinite(Number(binding.x)) && Number.isFinite(Number(binding.y)))
    .forEach((binding, index) => {
      const dot = document.createElement("button");
      dot.className = "binding-dot";
      dot.style.left = `${(Number(binding.x) / display.width) * 100}%`;
      dot.style.top = `${(Number(binding.y) / display.height) * 100}%`;
      dot.textContent = binding.key;
      dot.title = binding.label || binding.key;
      dot.addEventListener("click", (event) => {
        event.stopPropagation();
        selectBinding(index);
      });
      layer.appendChild(dot);
    });
}

function selectBinding(index) {
  const binding = state.keymap.bindings[index];
  state.selectedBinding = index;
  $("#binding-key").value = binding.key || "";
  $("#binding-label").value = binding.label || "";
  $("#binding-type").value = binding.type || "tap";
  $("#binding-x").value = binding.x || "";
  $("#binding-y").value = binding.y || "";
}

async function fireBinding(key) {
  try {
    toast(`Firing ${key}...`);
    await api("/api/keymap/fire", { method: "POST", body: { key } });
    toast(`Fired ${key}`);
  } catch (err) {
    showError(err);
  }
}

function wireInstances() {
  $("#refresh-instances").addEventListener("click", () => loadInstances().catch(showError));
  $("#create-instance").addEventListener("click", async () => {
    try {
      await api("/api/instances", { method: "POST", body: { name: $("#instance-name").value } });
      $("#instance-name").value = "";
      await loadInstances();
      toast("Instance created");
    } catch (err) {
      showError(err);
    }
  });
}

async function loadInstances() {
  const instances = await api("/api/instances");
  const list = $("#instance-list");
  list.innerHTML = "";
  instances.forEach((instance) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(instance.name)}</strong>
        <small>${escapeHtml(instance.status || "stopped")} · base ${escapeHtml(instance.base || "none")}</small>
      </div>
      <div class="row-actions">
        <button class="ghost small" data-action="start">Start</button>
        <button class="ghost small" data-action="stop">Stop</button>
        <button class="ghost small" data-action="clone">Clone</button>
      </div>
    `;
    row.querySelector('[data-action="start"]').addEventListener("click", () => instanceAction(instance.name, "start"));
    row.querySelector('[data-action="stop"]').addEventListener("click", () => instanceAction(instance.name, "stop"));
    row.querySelector('[data-action="clone"]').addEventListener("click", () => cloneInstance(instance.name));
    list.appendChild(row);
  });
}

async function instanceAction(name, action) {
  try {
    await api(`/api/instances/${encodeURIComponent(name)}/${action}`, { method: "POST", body: {} });
    await loadInstances();
    await refreshStatus();
    toast(`${name} ${action} requested`);
  } catch (err) {
    showError(err);
  }
}

async function cloneInstance(name) {
  const target = prompt("Clone name", `${name}-clone`);
  if (!target) return;
  try {
    await api(`/api/instances/${encodeURIComponent(name)}/clone`, { method: "POST", body: { name: target } });
    await loadInstances();
    toast("Instance cloned");
  } catch (err) {
    showError(err);
  }
}

function wireMacros() {
  $("#refresh-macros").addEventListener("click", () => loadMacros().catch(showError));
  $("#run-macro").addEventListener("click", () => runSelectedMacro().catch((err) => showError(err, "#macro-log")));
}

async function loadMacros() {
  const macros = await api("/api/macros");
  const list = $("#macro-list");
  list.innerHTML = "";
  macros.forEach((macro) => {
    const row = document.createElement("button");
    row.className = "table-row selectable";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(macro.name)}</strong>
        <small>${escapeHtml(macro.description || "")} · ${(macro.steps || []).length} steps</small>
      </div>
    `;
    row.addEventListener("click", () => {
      state.selectedMacro = macro.name;
      $("#macro-name").value = macro.name;
      $$("#macro-list .table-row").forEach((item) => item.classList.remove("selected"));
      row.classList.add("selected");
    });
    list.appendChild(row);
  });
}

async function runSelectedMacro() {
  const name = $("#macro-name").value || state.selectedMacro;
  if (!name) return toast("Choose a macro first", "warn");
  logTo("#macro-log", "Running macro...");
  const result = await api(`/api/macros/${encodeURIComponent(name)}/run`, {
    method: "POST",
    body: { loop: $("#macro-loop").value }
  });
  logTo("#macro-log", result);
  toast("Macro complete");
}

function wirePerformance() {
  $("#save-performance").addEventListener("click", savePerformance);
  $("#apply-display").addEventListener("click", () => deviceAction("/api/display", { preset: $("#display-preset").value }));
  $("#apply-audio").addEventListener("click", () => {
    const value = $("#audio-action").value;
    deviceAction("/api/audio", { action: value, test: value === "test" });
  });
  $("#apply-network").addEventListener("click", () => deviceAction("/api/network", { action: $("#network-action").value }));
}

async function loadPerformance() {
  const perf = await api("/api/performance");
  $("#perf-cores").value = perf.cores;
  $("#perf-memory").value = perf.memory;
  $("#perf-gpu").value = perf.gpu;
  $("#perf-fps").value = perf.fps;
}

async function savePerformance() {
  try {
    const perf = {
      cores: $("#perf-cores").value,
      memory: $("#perf-memory").value,
      gpu: $("#perf-gpu").value,
      fps: $("#perf-fps").value
    };
    const result = await api("/api/performance", { method: "POST", body: perf });
    toast("Performance profile saved");
    logTo("#device-log", result);
  } catch (err) {
    showError(err, "#device-log");
  }
}

async function deviceAction(path, body) {
  try {
    logTo("#device-log", "Sending command...");
    const result = await api(path, { method: "POST", body });
    logTo("#device-log", result);
    toast("Device command complete");
  } catch (err) {
    showError(err, "#device-log");
  }
}

function wireFiles() {
  $("#push-file").addEventListener("click", () => fileAction("/api/files/push", {
    local: $("#push-local").value,
    remote: $("#push-remote").value
  }));
  $("#pull-file").addEventListener("click", () => fileAction("/api/files/pull", {
    remote: $("#pull-remote").value,
    local: $("#pull-local").value
  }));
}

async function fileAction(path, body) {
  try {
    logTo("#files-log", "Transferring...");
    const result = await api(path, { method: "POST", body });
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
      const result = await api("/api/gps", {
        method: "POST",
        body: { lat: $("#gps-lat").value, lng: $("#gps-lng").value }
      });
      logTo("#gps-log", result);
      toast(result.ok ? "GPS sent" : "GPS saved; emulator console unavailable", result.ok ? "ok" : "warn");
    } catch (err) {
      showError(err, "#gps-log");
    }
  });
}

function showError(err, logSelector) {
  toast(err.message || String(err), "error");
  if (logSelector) logTo(logSelector, err.message || String(err));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function boot() {
  wireNavigation();
  wireHome();
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
  state.statusTimer = setInterval(() => refreshStatus().catch(() => {}), 6000);
  state.screenshotTimer = setInterval(refreshScreenshot, 9000);
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch(showError);
});
