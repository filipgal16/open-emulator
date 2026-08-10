const express = require("express");
const multer = require("multer");
const path = require("path");
const openemu = require("./lib/openemu");

const PORT = Number(process.env.OPEN_EMULATOR_DESKTOP_PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const upload = multer({ dest: openemu.UPLOAD_DIR });
const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function ok(res, payload) {
  res.json(payload);
}

app.get("/api/status", asyncRoute(async (_req, res) => {
  ok(res, await openemu.status());
}));

app.post("/api/start", asyncRoute(async (req, res) => {
  ok(res, await openemu.start(req.body || {}));
}));

app.post("/api/stop", asyncRoute(async (_req, res) => {
  ok(res, await openemu.stop());
}));

app.post("/api/install", upload.any(), asyncRoute(async (req, res) => {
  const uploaded = Array.isArray(req.files) && req.files.length ? req.files[0].path : null;
  const apkPath = uploaded || req.body.path;
  ok(res, await openemu.install(apkPath));
}));

app.get("/api/screenshot", asyncRoute(async (_req, res) => {
  res.type("png");
  try {
    res.send(await openemu.screenshot());
  } catch (err) {
    res.set("X-open-emulator-warning", encodeURIComponent(err.message));
    res.send(err.placeholder || openemu.PLACEHOLDER_PNG);
  }
}));

app.get("/api/keymap", asyncRoute(async (_req, res) => {
  ok(res, await openemu.keymap());
}));

app.put("/api/keymap", asyncRoute(async (req, res) => {
  ok(res, await openemu.saveKeymap(req.body));
}));

app.post("/api/keymap/fire", asyncRoute(async (req, res) => {
  ok(res, await openemu.fireKey(req.body.key));
}));

app.get("/api/instances", asyncRoute(async (_req, res) => {
  ok(res, await openemu.instances());
}));

app.post("/api/instances", asyncRoute(async (req, res) => {
  ok(res, await openemu.createInstance(req.body));
}));

app.post("/api/instances/:name/start", asyncRoute(async (req, res) => {
  ok(res, await openemu.startInstance(req.params.name));
}));

app.post("/api/instances/:name/stop", asyncRoute(async (req, res) => {
  ok(res, await openemu.stopInstance(req.params.name));
}));

app.post("/api/instances/:name/clone", asyncRoute(async (req, res) => {
  ok(res, await openemu.cloneInstance(req.params.name, req.body && req.body.name));
}));

app.get("/api/macros", asyncRoute(async (_req, res) => {
  ok(res, await openemu.macros());
}));

app.post("/api/macros", asyncRoute(async (req, res) => {
  ok(res, await openemu.saveMacro(req.body));
}));

app.post("/api/macros/:name/run", asyncRoute(async (req, res) => {
  ok(res, await openemu.runMacro(req.params.name, req.body && req.body.loop));
}));

app.get("/api/performance", asyncRoute(async (_req, res) => {
  ok(res, await openemu.performance());
}));

app.post("/api/performance", asyncRoute(async (req, res) => {
  ok(res, await openemu.performance(req.body || {}));
}));

app.post("/api/files/push", asyncRoute(async (req, res) => {
  ok(res, await openemu.sharePush(req.body.local, req.body.remote));
}));

app.post("/api/files/pull", asyncRoute(async (req, res) => {
  ok(res, await openemu.sharePull(req.body.remote, req.body.local));
}));

app.post("/api/gps", asyncRoute(async (req, res) => {
  ok(res, await openemu.gps(req.body.lat, req.body.lng));
}));

app.post("/api/display", asyncRoute(async (req, res) => {
  ok(res, await openemu.display(req.body || {}));
}));

app.post("/api/audio", asyncRoute(async (req, res) => {
  ok(res, await openemu.audio(req.body || {}));
}));

app.post("/api/network", asyncRoute(async (req, res) => {
  ok(res, await openemu.network(req.body || {}));
}));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json(openemu.errorPayload(err));
});

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`open-emulator desktop server listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
