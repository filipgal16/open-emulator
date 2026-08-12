const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const steps = ["welcome", "host", "fetch", "avd", "shortcut", "done"];
let index = 0;

function invoke(channel, payload) {
  return window.oe.invoke(channel, payload);
}

function showStep(next) {
  index = next;
  const ids = ["step-welcome", "step-host", "step-fetch", "step-avd", "step-shortcut", "step-done"];
  ids.forEach((id, i) => {
    $(`#${id}`).hidden = i !== index;
  });
  $$("#step-dots li").forEach((li, i) => {
    li.classList.toggle("active", i === index);
    li.classList.toggle("done", i < index);
  });
}

function appendLog(selector, line) {
  const node = $(selector);
  node.textContent = `${node.textContent}\n${line}`.replace(/^Waiting…\n/, "").replace(/^Checking…\n/, "");
  node.scrollTop = node.scrollHeight;
}

async function runHost() {
  showStep(1);
  $("#host-log").textContent = "Checking…";
  $("#host-next").disabled = true;
  try {
    const result = await invoke("setup-run", "host");
    $("#host-log").textContent = result.output || JSON.stringify(result, null, 2);
    $("#host-next").disabled = false;
  } catch (err) {
    $("#host-log").textContent = err.message || String(err);
  }
}

async function runFetch() {
  $("#fetch-log").textContent = "Starting fetch…\n";
  $("#fetch-run").disabled = true;
  const stop = window.oe.onSetupLog((payload) => {
    if (payload.step === "fetch") appendLog("#fetch-log", payload.line);
  });
  try {
    const result = await invoke("setup-run", "fetch");
    if (result.skipped) appendLog("#fetch-log", "Skipped — SDK already on disk.");
    appendLog("#fetch-log", "SDK step finished.");
    $("#fetch-next").disabled = false;
  } catch (err) {
    appendLog("#fetch-log", err.message || String(err));
  } finally {
    stop();
    $("#fetch-run").disabled = false;
  }
}

async function runAvd() {
  $("#avd-log").textContent = "Creating isolated machine…\n";
  $("#avd-run").disabled = true;
  const stop = window.oe.onSetupLog((payload) => {
    if (payload.step === "avd") appendLog("#avd-log", payload.line);
  });
  try {
    await invoke("setup-run", "avd");
    appendLog("#avd-log", "Machine main is registered.");
    $("#avd-next").disabled = false;
  } catch (err) {
    appendLog("#avd-log", err.message || String(err));
  } finally {
    stop();
    $("#avd-run").disabled = false;
  }
}

async function finish() {
  const wantShortcut = $("#want-shortcut").checked;
  if (wantShortcut) {
    try {
      const result = await invoke("setup-run", "shortcut");
      $("#shortcut-log").textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      $("#shortcut-log").textContent = err.message || String(err);
    }
  }
  await invoke("setup-complete", { shortcut: wantShortcut });
  if ($("#start-now").checked) {
    invoke("start", { instance: "main", async: true }).catch(() => {});
  }
  await invoke("open-shell");
}

window.addEventListener("DOMContentLoaded", async () => {
  const status = await invoke("setup-status");
  if (status.sdk) {
    $("#fetch-log").textContent = "SDK already present.";
    $("#fetch-next").disabled = false;
  }
  if (status.avd) {
    $("#avd-log").textContent = "AVD already present.";
    $("#avd-next").disabled = false;
  }

  $("#begin").addEventListener("click", runHost);
  $("#host-next").addEventListener("click", () => showStep(2));
  $("#fetch-run").addEventListener("click", runFetch);
  $("#fetch-next").addEventListener("click", () => showStep(3));
  $("#avd-run").addEventListener("click", runAvd);
  $("#avd-next").addEventListener("click", () => showStep(4));
  $("#shortcut-next").addEventListener("click", () => showStep(5));
  $("#finish").addEventListener("click", finish);
});
