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
  activePanel: "runtime",
  activeInstance: "main",
  instances: [],
  openTabs: ["main"],
  mirror: {
    active: false,
    instance: null,
    decoder: null,
    configuredCodec: null,
    configBytes: null,
    width: 0,
    height: 0,
    pointerDown: false,
    pointerId: 0
  }
};

function invoke(channel, payload) {
  if (!window.oe || typeof window.oe.invoke !== "function") {
    return Promise.reject(new Error("Desktop shell is not available outside Electron."));
  }
  return window.oe.invoke(channel, payload);
}

function activeName() {
  return state.activeInstance || "main";
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

function activatePanel(panelName) {
  state.activePanel = panelName;
  $$(".tool-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.panel === panelName));
  $$(".tool-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${panelName}`));
  $("#screen-frame").classList.toggle("keymap-mode", panelName === "keymap");
  renderDots();
  if (panelName === "keymap") refreshScreenshot();
  if (panelName === "gamecenter") loadGameCenter().catch(() => {});
}

function openGameCenter() {
  activatePanel("gamecenter");
}

function wireNavigation() {
  $$(".tool-tab").forEach((button) => {
    button.addEventListener("click", () => activatePanel(button.dataset.panel));
  });
}

async function refreshStatus() {
  const status = await invoke("status", activeName());
  logTo("#status-output", status);
  const stage = status.stage || (status.running ? "booting" : "stopped");
  const running = stage === "ready" || stage === "booted" || status.running;
  $("#side-status").textContent = `${activeName()} · ${stage}`;
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
    const wasHidden = overlay.hidden;
    overlay.hidden = false;
    $("#boot-stage").textContent = status && status.bootPath ? `${stage} · ${status.bootPath}` : stage;
    if (!state.bootStartedAt) state.bootStartedAt = Date.now();
    startBootTimer();
    if (wasHidden) showBootAd().catch(() => {});
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
  const result = await invoke("screenshot", activeName());
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
    const result = await invoke("start", { cold: $("#cold-start").checked, async: true, instance: activeName() });
    if (result && result.code === "ENTITLEMENT_LIMIT") {
      $("#boot-overlay").hidden = true;
      toast(result.error, "warn");
      openGameCenter();
      return;
    }
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
    const result = await invoke("stop", activeName());
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
    const result = await invoke("install", { path: apkPath, instance: activeName() });
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
    await invoke("keymap-fire", { key, instance: activeName() });
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

function findInstance(name) {
  return state.instances.find((item) => item.name === name);
}

function openTab(name) {
  if (state.mirror.active && state.mirror.instance !== name) {
    stopLiveMirror().catch(() => {});
  }
  if (!state.openTabs.includes(name)) state.openTabs.push(name);
  state.activeInstance = name;
  renderTabs();
  refreshStatus().catch(() => {});
  refreshScreenshot().catch(() => {});
}

function renderTabs() {
  const strip = $("#tab-strip");
  strip.innerHTML = "";
  state.openTabs.forEach((name) => {
    const inst = findInstance(name) || { name, status: "stopped" };
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `machine-tab${name === state.activeInstance ? " active" : ""}`;
    tab.setAttribute("role", "tab");
    tab.innerHTML = `
      <span>
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(inst.lastApp || inst.status || "stopped")}</small>
      </span>
      <span class="tab-close" data-close="${escapeHtml(name)}" title="Close tab">×</span>`;
    tab.addEventListener("click", (event) => {
      if (event.target.dataset.close) {
        event.stopPropagation();
        closeTab(event.target.dataset.close);
        return;
      }
      openTab(name);
    });
    strip.appendChild(tab);
  });
}

function closeTab(name) {
  if (state.mirror.active && state.mirror.instance === name) {
    stopLiveMirror().catch(() => {});
  }
  state.openTabs = state.openTabs.filter((item) => item !== name);
  if (!state.openTabs.length) state.openTabs = ["main"];
  if (state.activeInstance === name) {
    state.activeInstance = state.openTabs[0];
  }
  renderTabs();
  refreshStatus().catch(() => {});
  refreshScreenshot().catch(() => {});
}

function fillSourceSelect() {
  const select = $("#new-machine-source");
  select.innerHTML = "";
  const names = state.instances.length ? state.instances.map((item) => item.name) : ["main"];
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
}

function wireTabs() {
  $("#tab-add").addEventListener("click", () => {
    fillSourceSelect();
    $("#new-machine-name").value = "";
    $("#new-machine-modal").hidden = false;
    $("#new-machine-name").focus();
    loadModalAd().catch(() => {});
  });
  $("#new-machine-cancel").addEventListener("click", () => {
    $("#new-machine-modal").hidden = true;
  });
  $("#new-machine-create").addEventListener("click", async () => {
    const name = $("#new-machine-name").value.trim();
    const source = $("#new-machine-source").value || "main";
    if (!name) return toast("Name is required", "warn");
    try {
      await invoke("instance-clone", { name: source, target: name });
      $("#new-machine-modal").hidden = true;
      toast(`Created isolated machine ${name}`);
      await loadInstances();
      openTab(name);
    } catch (err) {
      showError(err);
    }
  });
}

function wireInstances() {
  $("#create-instance").addEventListener("click", async () => {
    try {
      const name = $("#instance-name").value;
      await invoke("instance-create", { name });
      toast("Isolated machine created");
      await loadInstances();
      openTab(name);
    } catch (err) {
      showError(err);
    }
  });
  $("#refresh-instances").addEventListener("click", () => loadInstances().catch(showError));
}

async function loadInstances() {
  const instances = await invoke("instances");
  state.instances = Array.isArray(instances) ? instances : [];
  if (!state.openTabs.length) state.openTabs = ["main"];
  const known = new Set(state.instances.map((item) => item.name));
  if (known.size) {
    state.openTabs = state.openTabs.filter((name) => known.has(name));
    if (!state.openTabs.length) state.openTabs = [state.instances[0].name];
    if (!known.has(state.activeInstance)) state.activeInstance = state.openTabs[0];
  }
  renderTabs();
  const list = $("#instance-list");
  list.innerHTML = "";
  state.instances.forEach((instance) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(instance.name)}</strong>
        <small>${escapeHtml(instance.status || "stopped")} · ${escapeHtml(instance.avd || "")} · port ${escapeHtml(instance.consolePort || "")}</small>
      </div>
      <div class="row-actions">
        <button class="ghost small" data-action="open">Tab</button>
        <button class="ghost small" data-action="start">Start</button>
        <button class="ghost small" data-action="stop">Stop</button>
        <button class="ghost small" data-action="clone">Clone</button>
        <button class="danger small" data-action="delete">Del</button>
      </div>`;
    row.querySelector('[data-action="open"]').addEventListener("click", () => openTab(instance.name));
    row.querySelector('[data-action="start"]').addEventListener("click", () => instanceAction(instance.name, "start"));
    row.querySelector('[data-action="stop"]').addEventListener("click", () => instanceAction(instance.name, "stop"));
    row.querySelector('[data-action="clone"]').addEventListener("click", () => cloneInstance(instance.name));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteMachine(instance.name));
    list.appendChild(row);
  });
}

async function instanceAction(name, action) {
  try {
    await invoke(action === "start" ? "instance-start" : "instance-stop", name);
    toast(`${action} ${name}`);
    openTab(name);
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
    openTab(target);
  } catch (err) {
    showError(err);
  }
}

async function deleteMachine(name) {
  if (name === "main") return toast("The main machine cannot be deleted", "warn");
  try {
    await invoke("instance-delete", name);
    closeTab(name);
    toast(`Deleted ${name}`);
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
    remote: $("#push-remote").value,
    instance: activeName()
  }));
  $("#pull-file").addEventListener("click", () => fileAction("files-pull", {
    remote: $("#pull-remote").value,
    local: $("#pull-local").value,
    instance: activeName()
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
      const result = await invoke("gps", {
        lat: $("#gps-lat").value,
        lng: $("#gps-lng").value,
        instance: activeName()
      });
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

async function checkForUpdate() {
  try {
    const result = await invoke("update-check");
    if (!result || !result.available) return;
    const note = $("#update-note");
    note.textContent = `Update available — v${result.latest}`;
    note.hidden = false;
    note.onclick = () => invoke("open-external", result.url).catch(() => {});
  } catch {
    /* update checks are best-effort and silent */
  }
}

// --- Ads / entitlement ---------------------------------------------------
// Creatives are rendered as plain text/attributes only (textContent, img
// src) — never innerHTML from a remote string. See desktop/lib/ads.js for
// why: no third-party HTML/JS ever runs inside this window.

async function applyAdAction(result, { onDismiss } = {}) {
  if (!result) return;
  if (result.action === "dismiss" && onDismiss) onDismiss();
  if (result.action === "panel") activatePanel(result.panel);
  if (result.action === "upgrade") invoke("upgrade-open").catch(() => {});
  if (result.action === "rewarded") {
    toast("Unlocked a 3rd running machine for today.");
    loadGameCenter().catch(() => {});
  }
  // "external": the main process already opened it via shell.openExternal.
}

async function clickAd(slot, creative, onDismiss) {
  try {
    const result = await invoke("ads-click", { slot, id: creative.id, clickUrl: creative.clickUrl });
    await applyAdAction(result, { onDismiss });
  } catch (err) {
    showError(err);
  }
}

async function refreshAdRail() {
  try {
    const result = await invoke("ads-get", "rail");
    const rail = $("#ad-rail");
    if (!result || !result.creative) {
      rail.hidden = true;
      return;
    }
    const { creative } = result;
    $("#ad-rail-title").textContent = creative.title;
    $("#ad-rail-body").textContent = creative.body;
    $("#ad-rail-cta").textContent = creative.cta;
    const thumb = $("#ad-rail-thumb");
    thumb.hidden = !creative.imageUrl;
    if (creative.imageUrl) thumb.src = creative.imageUrl;
    rail.hidden = false;
    invoke("ads-event", { slot: "rail", id: creative.id }).catch(() => {});
    $("#ad-rail-cta").onclick = () => clickAd("rail", creative);
    $("#ad-rail-dismiss").onclick = async () => {
      await invoke("ads-dismiss", { slot: "rail", hours: 24 }).catch(() => {});
      rail.hidden = true;
    };
  } catch {
    $("#ad-rail").hidden = true;
  }
}

async function showBootAd() {
  const result = await invoke("ads-get", "boot");
  const card = $("#boot-ad");
  if (!result || !result.creative) {
    card.hidden = true;
    return;
  }
  const { creative } = result;
  $("#boot-ad-title").textContent = creative.title;
  $("#boot-ad-body").textContent = creative.body;
  $("#boot-ad-cta").textContent = creative.cta;
  card.hidden = false;
  invoke("ads-event", { slot: "boot", id: creative.id }).catch(() => {});
  $("#boot-ad-cta").onclick = () => clickAd("boot", creative);
}

async function loadModalAd() {
  try {
    const result = await invoke("ads-get", "modal");
    const card = $("#modal-ad");
    if (!result || !result.creative) {
      card.hidden = true;
      return;
    }
    const { creative } = result;
    $("#modal-ad-body").textContent = `${creative.title} — ${creative.body}`;
    $("#modal-ad-cta").textContent = creative.cta;
    card.hidden = false;
    invoke("ads-event", { slot: "modal", id: creative.id }).catch(() => {});
    $("#modal-ad-cta").onclick = () => clickAd("modal", creative, () => (card.hidden = true));
  } catch {
    $("#modal-ad").hidden = true;
  }
}

function renderTierCard(entitlement) {
  const badge = $("#tier-badge");
  badge.textContent = entitlement.tier;
  badge.classList.toggle("pro", entitlement.tier === "pro");
  $("#tier-summary").textContent =
    entitlement.tier === "pro"
      ? "No ads, no instance cap. Thank you for supporting the project."
      : `Free tier: ${entitlement.maxInstances === Infinity ? "unlimited" : entitlement.maxInstances} running machine(s) at once${entitlement.rewardedUntil ? " (today's unlock active)" : ""}.`;
  $("#tier-upgrade").hidden = entitlement.tier === "pro";
  $("#tier-activate").hidden = entitlement.tier === "pro";
}

function renderGameCenterOffers(creatives) {
  const list = $("#gamecenter-list");
  list.innerHTML = "";
  for (const creative of creatives) {
    const row = document.createElement("div");
    row.className = "gamecenter-offer";
    const title = document.createElement("strong");
    title.textContent = creative.title;
    const body = document.createElement("p");
    body.textContent = creative.body;
    const cta = document.createElement("button");
    cta.className = "primary small";
    cta.textContent = creative.cta;
    cta.addEventListener("click", () => clickAd("gamecenter", creative));
    row.append(title, body, cta);
    list.appendChild(row);
    invoke("ads-event", { slot: "gamecenter", id: creative.id }).catch(() => {});
  }
  if (!creatives.length) {
    const empty = document.createElement("p");
    empty.className = "panel-hint";
    empty.textContent = "No offers configured yet.";
    list.appendChild(empty);
  }
}

async function loadGameCenter() {
  try {
    const entitlement = await invoke("license-get");
    renderTierCard(entitlement);

    const consent = await invoke("consent-get");
    $("#consent-inline").hidden = consent !== false;

    const rewardedCard = $("#rewarded-card");
    if (entitlement.tier === "free" && !entitlement.rewardedUntil && consent === true) {
      const rewarded = await invoke("ads-get", "rewarded");
      if (rewarded && rewarded.creative) {
        $("#rewarded-title").textContent = rewarded.creative.title;
        $("#rewarded-body").textContent = rewarded.creative.body;
        $("#rewarded-cta").textContent = rewarded.creative.cta;
        $("#rewarded-cta").onclick = () => clickAd("rewarded", rewarded.creative);
        rewardedCard.hidden = false;
      } else {
        rewardedCard.hidden = true;
      }
    } else {
      rewardedCard.hidden = true;
    }

    if (consent === true && entitlement.adsEnabled) {
      const offers = await invoke("ads-list", "gamecenter");
      renderGameCenterOffers((offers && offers.creatives) || []);
    } else {
      renderGameCenterOffers([]);
    }
  } catch (err) {
    showError(err);
  }
}

function wireGameCenter() {
  $("#tier-upgrade").addEventListener("click", () => invoke("upgrade-open").catch(() => {}));
  $("#tier-activate").addEventListener("click", () => {
    const row = $("#activate-row");
    row.hidden = !row.hidden;
  });
  $("#activate-submit").addEventListener("click", async () => {
    const key = $("#activate-license").value.trim();
    if (!key) return;
    try {
      const entitlement = await invoke("license-activate", key);
      toast(`Activated — tier: ${entitlement.tier}`);
      $("#activate-row").hidden = true;
      $("#activate-license").value = "";
      renderTierCard(entitlement);
      loadGameCenter().catch(() => {});
      refreshAdRail().catch(() => {});
    } catch (err) {
      showError(err);
    }
  });
  $("#consent-inline-enable").addEventListener("click", async () => {
    await invoke("consent-set", true).catch(() => {});
    loadGameCenter().catch(() => {});
    refreshAdRail().catch(() => {});
  });
}

async function wireConsentModal() {
  const consent = await invoke("consent-get").catch(() => null);
  if (consent !== null) return; // already decided — via the wizard, or previously in-app
  $("#consent-modal").hidden = false;
  $("#consent-modal-accept").addEventListener("click", async () => {
    await invoke("consent-set", true).catch(() => {});
    $("#consent-modal").hidden = true;
    refreshAdRail().catch(() => {});
  });
  $("#consent-modal-decline").addEventListener("click", async () => {
    await invoke("consent-set", false).catch(() => {});
    $("#consent-modal").hidden = true;
    invoke("upgrade-open").catch(() => {});
  });
}

// --- Live mirror (scrcpy protocol) ---------------------------------------
// Opt-in alternative to the screenshot-polling loop above. See
// desktop/lib/mirror.js for the wire-protocol side; this is purely the
// WebCodecs decode + canvas render + pointer/keyboard capture side.

const ANDROID_KEYCODES = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  " ": 62,
  ArrowLeft: 21,
  ArrowRight: 22,
  ArrowUp: 19,
  ArrowDown: 20
};

function androidKeycodeFor(event) {
  if (/^Key[A-Z]$/.test(event.code)) return 29 + (event.code.charCodeAt(3) - 65); // KEYCODE_A..Z
  if (/^Digit[0-9]$/.test(event.code)) return 7 + (event.code.charCodeAt(5) - 48); // KEYCODE_0..9
  return ANDROID_KEYCODES[event.key] ?? null;
}

function findAnnexBNals(data) {
  const nals = [];
  let i = 0;
  while (i < data.length - 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      nals.push({ offset: i, headerLen: 4, type: data[i + 4] & 0x1f });
      i += 4;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nals.push({ offset: i, headerLen: 3, type: data[i + 3] & 0x1f });
      i += 3;
    } else {
      i += 1;
    }
  }
  return nals;
}

function deriveH264CodecString(configBytes) {
  const sps = findAnnexBNals(configBytes).find((n) => n.type === 7);
  if (!sps) return null;
  const p = configBytes.subarray(sps.offset + sps.headerLen + 1, sps.offset + sps.headerLen + 4);
  return `avc1.${Array.from(p).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function ensureMirrorDecoder(codecString) {
  const m = state.mirror;
  if (m.decoder && m.configuredCodec === codecString) return m.decoder;
  if (m.decoder) {
    try {
      m.decoder.close();
    } catch {
      /* already closed */
    }
  }
  const canvas = $("#guest-canvas");
  m.decoder = new VideoDecoder({
    output: (frame) => {
      canvas.getContext("2d").drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error: (err) => {
      console.error("mirror decode error", err);
      stopLiveMirror().catch(() => {});
      toast("Live mirror decode error — falling back to screenshots", "warn");
    }
  });
  m.decoder.configure({ codec: codecString, avc: { format: "annexb" } });
  m.configuredCodec = codecString;
  return m.decoder;
}

function onMirrorEvent(payload) {
  const m = state.mirror;
  if (!m.active || payload.instance !== m.instance) return;

  if (payload.kind === "session") {
    m.width = payload.width;
    m.height = payload.height;
    const canvas = $("#guest-canvas");
    canvas.width = payload.width;
    canvas.height = payload.height;
    return;
  }

  if (payload.kind === "error") {
    toast(payload.error || "Live mirror error", "warn");
    stopLiveMirror().catch(() => {});
    return;
  }

  if (payload.kind === "close") {
    stopLiveMirror().catch(() => {});
    return;
  }

  if (payload.kind !== "frame") return;

  const data = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
  if (payload.config) {
    m.configBytes = data;
    return;
  }
  if (!m.configBytes) return; // wait for the config packet before decoding anything

  let decoder;
  try {
    const codecString = deriveH264CodecString(m.configBytes) || "avc1.42e01f";
    decoder = ensureMirrorDecoder(codecString);
  } catch (err) {
    console.error("codec setup failed", err);
    return;
  }
  if (decoder.state !== "configured") return;

  const chunkData = payload.keyFrame ? concatBytes(m.configBytes, data) : data;
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: payload.keyFrame ? "key" : "delta",
        timestamp: payload.pts || 0,
        data: chunkData
      })
    );
  } catch (err) {
    console.error("decode() threw", err);
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function canvasToVideoCoords(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function wireMirrorInput() {
  const canvas = $("#guest-canvas");
  const send = (body) => invoke("mirror-input", { instance: state.mirror.instance, ...body }).catch(() => {});

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.mirror.active) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    state.mirror.pointerDown = true;
    const { x, y } = canvasToVideoCoords(canvas, event);
    send({ type: "touch-down", x, y, width: state.mirror.width, height: state.mirror.height });
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.mirror.active || !state.mirror.pointerDown) return;
    const { x, y } = canvasToVideoCoords(canvas, event);
    send({ type: "touch-move", x, y, width: state.mirror.width, height: state.mirror.height });
  });
  const release = (event) => {
    if (!state.mirror.active || !state.mirror.pointerDown) return;
    state.mirror.pointerDown = false;
    const { x, y } = canvasToVideoCoords(canvas, event);
    send({ type: "touch-up", x, y, width: state.mirror.width, height: state.mirror.height });
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (event) => {
    if (!state.mirror.active) return;
    event.preventDefault();
    const { x, y } = canvasToVideoCoords(canvas, event);
    send({
      type: "scroll",
      x,
      y,
      width: state.mirror.width,
      height: state.mirror.height,
      hscroll: -event.deltaX / 100,
      vscroll: -event.deltaY / 100
    });
  });
  canvas.addEventListener("keydown", (event) => {
    if (!state.mirror.active) return;
    event.preventDefault();
    if (event.key === "Escape") {
      send({ type: "back" });
      return;
    }
    const keycode = androidKeycodeFor(event);
    if (keycode != null) send({ type: "key", action: 0, keycode });
  });
  canvas.addEventListener("keyup", (event) => {
    if (!state.mirror.active) return;
    event.preventDefault();
    if (event.key === "Escape") return;
    const keycode = androidKeycodeFor(event);
    if (keycode != null) send({ type: "key", action: 1, keycode });
  });
}

async function startLiveMirror() {
  const name = activeName();
  try {
    await invoke("mirror-start", name);
    state.mirror.active = true;
    state.mirror.instance = name;
    $("#guest-screen").hidden = true;
    $("#guest-canvas").hidden = false;
    $("#live-toggle").textContent = "Live: on";
    $("#live-toggle").classList.add("on");
    if (state.screenshotTimer) {
      clearInterval(state.screenshotTimer);
      state.screenshotTimer = null;
    }
  } catch (err) {
    showError(err);
  }
}

async function stopLiveMirror() {
  const name = state.mirror.instance || activeName();
  state.mirror.active = false;
  state.mirror.instance = null;
  state.mirror.configBytes = null;
  if (state.mirror.decoder) {
    try {
      state.mirror.decoder.close();
    } catch {
      /* already closed */
    }
    state.mirror.decoder = null;
    state.mirror.configuredCodec = null;
  }
  $("#guest-screen").hidden = false;
  $("#guest-canvas").hidden = true;
  $("#live-toggle").textContent = "Live: off";
  $("#live-toggle").classList.remove("on");
  if (!state.screenshotTimer) {
    state.screenshotTimer = setInterval(() => refreshScreenshot().catch(() => {}), 9000);
  }
  await invoke("mirror-stop", name).catch(() => {});
}

function wireLiveToggle() {
  if (typeof VideoDecoder === "undefined") {
    $("#live-toggle").hidden = true;
    return;
  }
  $("#live-toggle").addEventListener("click", () => {
    if (state.mirror.active) stopLiveMirror().catch(() => {});
    else startLiveMirror();
  });
  wireMirrorInput();
  if (window.oe && typeof window.oe.onMirrorEvent === "function") {
    window.oe.onMirrorEvent(onMirrorEvent);
  }
}

async function boot() {
  wireNavigation();
  wireViewport();
  wireInstall();
  wireKeymap();
  wireTabs();
  wireInstances();
  wireMacros();
  wirePerformance();
  wireFiles();
  wireLocation();
  wireGameCenter();
  wireLiveToggle();

  await Promise.allSettled([
    refreshStatus(),
    loadKeymap(),
    loadInstances(),
    loadMacros(),
    loadPerformance()
  ]);
  refreshScreenshot();
  checkForUpdate();
  wireConsentModal().catch(() => {});
  refreshAdRail().catch(() => {});
  state.adRailTimer = setInterval(() => refreshAdRail().catch(() => {}), 90000);
  state.statusTimer = setInterval(async () => {
    try {
      await loadInstances();
      await refreshStatus();
    } catch {
      /* ignore poll errors */
    }
  }, 3000);
  state.screenshotTimer = setInterval(() => refreshScreenshot().catch(() => {}), 9000);
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch(showError);
});
