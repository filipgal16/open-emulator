// Live screen mirroring over scrcpy's wire protocol, replacing the
// 9-second screenshot poll with a real H.264 stream, and adb-shell-per-key
// input with direct low-latency socket injection.
//
// scrcpy-server (Apache-2.0) is fetched from Genymobile's GitHub releases
// at setup time and pushed to the device per adb session — same
// fetch-never-bundle posture as the Android SDK itself (see docs/LEGAL.md)
// and legitimate here too since Apache-2.0 explicitly allows redistribution
// (unlike the SDK license), we just don't bundle a JVM binary into every
// install when it's a 700 KB one-time per-device push.
//
// Protocol reference (verified against the real v4.1 server, its
// checksum, and Genymobile/scrcpy's doc/develop.md + source at that tag —
// see the comments below and monetize/../docs for exact byte layouts):
//   https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md
//   https://github.com/Genymobile/scrcpy/blob/master/app/src/control_msg.c
//   https://github.com/Genymobile/scrcpy/blob/master/server/src/main/java/com/genymobile/scrcpy/device/DesktopConnection.java
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const paths = require("./paths");

const SCRCPY_VERSION = "4.1";
const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
// From that release's SHA256SUMS.txt — pinned so a corrupted or swapped
// download is rejected rather than silently pushed to a device.
const SCRCPY_SERVER_SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";

const DEVICE_META_LENGTH = 64;
const DEVICE_SOCKET_PATH = "/data/local/tmp/scrcpy-server.jar";

function mirrorRoot() {
  return path.join(paths.androidDataRoot(), "mirror");
}

function serverJarPath() {
  return path.join(mirrorRoot(), `scrcpy-server-v${SCRCPY_VERSION}.jar`);
}

function adbBin() {
  return path.join(paths.androidDataRoot(), "sdk", "platform-tools", "adb");
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function ensureServerJar(onLine) {
  const dest = serverJarPath();
  if (fs.existsSync(dest)) {
    if ((await sha256File(dest)) === SCRCPY_SERVER_SHA256) return dest;
    await fsp.unlink(dest).catch(() => {});
  }
  await fsp.mkdir(mirrorRoot(), { recursive: true });
  onLine && onLine(`Fetching scrcpy-server v${SCRCPY_VERSION}…`);
  const res = await fetch(SCRCPY_SERVER_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`scrcpy-server download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== SCRCPY_SERVER_SHA256) {
    throw new Error(`scrcpy-server checksum mismatch (got ${digest}) — refusing to push an unverified binary`);
  }
  const tmp = `${dest}.partial`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, dest);
  return dest;
}

function runAdb(serial, args, options = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = serial ? ["-s", serial, ...args] : args;
    const child = spawn(adbBin(), fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`adb ${args.join(" ")} timed out`));
        }, options.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`adb ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
  });
}

// ---------------------------------------------------------------------
// Control message encoding — app/src/control_msg.c, big-endian, verified
// byte-for-byte against that source at the v4.1 tag.
// ---------------------------------------------------------------------

const ControlType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4
};

const MotionAction = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };
const KeyAction = { DOWN: 0, UP: 1 };
// A dedicated synthetic pointer id for our single mouse-emulated touch.
// scrcpy's own client uses well-known sentinels for real mice/fingers, but
// any value used consistently across one DOWN..MOVE..UP sequence is valid
// to the Android input pipeline.
const POINTER_ID = 0n;

function writePosition(buf, offset, x, y, width, height) {
  buf.writeInt32BE(Math.round(x), offset);
  buf.writeInt32BE(Math.round(y), offset + 4);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(width))), offset + 8);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(height))), offset + 10);
}

function floatToU16Fp(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 0xffff);
}

function floatToI16Fp(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * 0x7fff);
}

function encodeTouch({ action, x, y, width, height, pointerId = POINTER_ID, pressure = 1, actionButton = 0, buttons = 0 }) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(ControlType.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigUInt64BE(BigInt(pointerId), 2);
  writePosition(buf, 10, x, y, width, height);
  buf.writeUInt16BE(floatToU16Fp(action === MotionAction.UP ? 0 : pressure), 22);
  buf.writeUInt32BE(actionButton, 24);
  buf.writeUInt32BE(buttons, 28);
  return buf;
}

function encodeScroll({ x, y, width, height, hscroll = 0, vscroll = 0, buttons = 0 }) {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(ControlType.INJECT_SCROLL_EVENT, 0);
  writePosition(buf, 1, x, y, width, height);
  buf.writeInt16BE(floatToI16Fp(Math.max(-16, Math.min(16, hscroll)) / 16), 13);
  buf.writeInt16BE(floatToI16Fp(Math.max(-16, Math.min(16, vscroll)) / 16), 15);
  buf.writeUInt32BE(buttons, 17);
  return buf;
}

function encodeKey({ action, keycode, repeat = 0, metastate = 0 }) {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(ControlType.INJECT_KEYCODE, 0);
  buf.writeUInt8(action, 1);
  buf.writeUInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeUInt32BE(metastate, 10);
  return buf;
}

function encodeBackOrScreenOn(action = KeyAction.DOWN) {
  return Buffer.from([ControlType.BACK_OR_SCREEN_ON, action]);
}

// ---------------------------------------------------------------------
// Video socket demuxer — doc/develop.md "Video and audio" section.
// Incremental/stateful so it tolerates TCP fragmentation: headers or
// payloads may arrive split across multiple `push()` calls.
// ---------------------------------------------------------------------

const SESSION_PACKET_FLAG = 0x80n << 56n; // byte 0 bit 7
const CONFIG_PACKET_FLAG = 0x40n << 56n; // byte 0 bit 6 (media packets only)
const KEY_FRAME_FLAG = 0x20n << 56n; // byte 0 bit 5 (media packets only)
const PTS_MASK = (1n << 61n) - 1n; // low 61 bits

class VideoDemuxer extends EventEmitter {
  constructor() {
    super();
    this._buffer = Buffer.alloc(0);
    this._codecRead = false;
  }

  push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    this._drain();
  }

  _drain() {
    for (;;) {
      if (!this._codecRead) {
        if (this._buffer.length < 4) return;
        const codecId = this._buffer.readUInt32BE(0);
        this._buffer = this._buffer.subarray(4);
        this._codecRead = true;
        this.emit("codec", { codecId, name: codecName(codecId) });
        continue;
      }
      if (this._buffer.length < 12) return;
      const header = this._buffer.readBigUInt64BE(0);
      const packetSize = this._buffer.readUInt32BE(8);

      if (header & SESSION_PACKET_FLAG) {
        const width = this._buffer.readUInt32BE(4);
        const height = this._buffer.readUInt32BE(8);
        // Session packets have no trailing payload — the 12-byte header
        // itself carries width/height in bytes 4-11 (packetSize here is
        // really the low half of height, per the doc's byte layout; both
        // interpretations agree because a session packet is exactly 12
        // bytes with nothing following).
        this._buffer = this._buffer.subarray(12);
        this.emit("session", { width, height, resized: Boolean(header & 1n) });
        continue;
      }

      if (this._buffer.length < 12 + packetSize) return; // wait for the rest of this frame
      const data = this._buffer.subarray(12, 12 + packetSize);
      this._buffer = this._buffer.subarray(12 + packetSize);
      const config = Boolean(header & CONFIG_PACKET_FLAG);
      const keyFrame = Boolean(header & KEY_FRAME_FLAG);
      const pts = config ? 0 : Number(header & PTS_MASK);
      this.emit("frame", { config, keyFrame, pts, data: Buffer.from(data) });
    }
  }
}

function codecName(codecId) {
  const map = { 0x68323634: "h264", 0x68323635: "h265", 0x00617631: "av1" };
  return map[codecId] || `0x${codecId.toString(16)}`;
}

// ---------------------------------------------------------------------
// Session orchestration: adb push/reverse, spawn the on-device server,
// accept the video + control sockets, wire the demuxer, expose input.
// ---------------------------------------------------------------------

class MirrorSession extends EventEmitter {
  constructor(serial) {
    super();
    this.serial = serial;
    this.scid = crypto.randomInt(0, 0x7fffffff);
    this.videoSocket = null;
    this.controlSocket = null;
    this.demuxer = new VideoDemuxer();
    this.deviceName = null;
    this.width = 0;
    this.height = 0;
    this._server = null;
    this._deviceProcess = null;
    this._stopped = false;
  }

  get scidHex() {
    return this.scid.toString(16).padStart(8, "0");
  }

  async start({ onLine, maxSize = 1280, maxFps = 30, videoBitRate = 8_000_000 } = {}) {
    const jar = await ensureServerJar(onLine);
    await runAdb(this.serial, ["push", jar, DEVICE_SOCKET_PATH], { timeoutMs: 30000 });

    const port = await this._listen();
    await runAdb(this.serial, ["reverse", `localabstract:scrcpy_${this.scidHex}`, `tcp:${port}`], {
      timeoutMs: 10000
    });

    const acceptFirstTwo = this._acceptSockets();

    this._deviceProcess = spawn(
      adbBin(),
      [
        "-s",
        this.serial,
        "shell",
        `CLASSPATH=${DEVICE_SOCKET_PATH}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        `scid=${this.scidHex}`,
        "log_level=info",
        "audio=false",
        "control=true",
        "tunnel_forward=false",
        `max_size=${maxSize}`,
        `max_fps=${maxFps}`,
        `video_bit_rate=${videoBitRate}`,
        "send_frame_meta=true",
        "send_device_meta=true",
        "send_dummy_byte=false"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this._deviceProcess.stderr.on("data", (chunk) => this.emit("serverlog", chunk.toString()));
    this._deviceProcess.on("exit", (code) => {
      if (!this._stopped) this.emit("error", new Error(`scrcpy-server exited unexpectedly (${code})`));
    });

    await acceptFirstTwo;
    this._wireVideo();
    return { deviceName: this.deviceName };
  }

  _listen() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer();
      this._server.on("error", reject);
      this._server.listen(0, "127.0.0.1", () => resolve(this._server.address().port));
    });
  }

  _acceptSockets() {
    let firstMetaConsumed = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for scrcpy-server to connect")), 15000);
      this._server.on("connection", async (socket) => {
        try {
          if (!this.videoSocket) {
            this.videoSocket = socket;
            if (!firstMetaConsumed) {
              firstMetaConsumed = true;
              const meta = await readExactly(socket, DEVICE_META_LENGTH);
              this.deviceName = meta.toString("utf8").replace(/\0+$/, "");
            }
          } else if (!this.controlSocket) {
            this.controlSocket = socket;
            clearTimeout(timer);
            this._server.close();
            resolve();
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  _wireVideo() {
    this.demuxer.on("codec", (info) => this.emit("codec", info));
    this.demuxer.on("session", (info) => {
      this.width = info.width;
      this.height = info.height;
      this.emit("session", info);
    });
    this.demuxer.on("frame", (frame) => this.emit("frame", frame));
    this.videoSocket.on("data", (chunk) => this.demuxer.push(chunk));
    this.videoSocket.on("error", (err) => this.emit("error", err));
    this.videoSocket.on("close", () => {
      if (!this._stopped) this.emit("close");
    });
  }

  _writeControl(buf) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    this.controlSocket.write(buf);
    return true;
  }

  sendTap(x, y, width, height) {
    this._writeControl(encodeTouch({ action: MotionAction.DOWN, x, y, width, height }));
    this._writeControl(encodeTouch({ action: MotionAction.UP, x, y, width, height }));
  }

  sendTouchDown(x, y, width, height, pointerId) {
    return this._writeControl(encodeTouch({ action: MotionAction.DOWN, x, y, width, height, pointerId }));
  }

  sendTouchMove(x, y, width, height, pointerId) {
    return this._writeControl(encodeTouch({ action: MotionAction.MOVE, x, y, width, height, pointerId }));
  }

  sendTouchUp(x, y, width, height, pointerId) {
    return this._writeControl(encodeTouch({ action: MotionAction.UP, x, y, width, height, pointerId }));
  }

  sendScroll(args) {
    return this._writeControl(encodeScroll(args));
  }

  sendKey(keycode, { action = KeyAction.DOWN, repeat = 0, metastate = 0 } = {}) {
    return this._writeControl(encodeKey({ action, keycode, repeat, metastate }));
  }

  sendBack() {
    this._writeControl(encodeBackOrScreenOn(KeyAction.DOWN));
    this._writeControl(encodeBackOrScreenOn(KeyAction.UP));
  }

  async stop() {
    this._stopped = true;
    try {
      if (this._server) this._server.close();
    } catch {
      /* already closed */
    }
    for (const socket of [this.videoSocket, this.controlSocket]) {
      if (socket) socket.destroy();
    }
    if (this._deviceProcess) {
      this._deviceProcess.kill("SIGTERM");
    }
    await runAdb(this.serial, ["shell", "pkill", "-f", "com.genymobile.scrcpy.Server"], { timeoutMs: 5000 }).catch(
      () => {}
    );
    await runAdb(this.serial, ["reverse", "--remove", `localabstract:scrcpy_${this.scidHex}`], {
      timeoutMs: 5000
    }).catch(() => {});
  }
}

function readExactly(socket, length) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= length) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        const exact = received.subarray(0, length);
        const rest = received.subarray(length);
        if (rest.length) socket.unshift(rest);
        resolve(exact);
      }
    };
    const onError = (err) => {
      socket.removeListener("data", onData);
      reject(err);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

// ---------------------------------------------------------------------
// Registry: one session per instance name, so multiple tabs can mirror
// concurrently.
// ---------------------------------------------------------------------

const sessions = new Map();

async function startMirror(instanceName, serial, options) {
  await stopMirror(instanceName);
  const session = new MirrorSession(serial);
  sessions.set(instanceName, session);
  session.on("close", () => sessions.delete(instanceName));
  session.on("error", () => sessions.delete(instanceName));
  await session.start(options);
  return session;
}

async function stopMirror(instanceName) {
  const existing = sessions.get(instanceName);
  if (!existing) return;
  sessions.delete(instanceName);
  await existing.stop();
}

function getMirror(instanceName) {
  return sessions.get(instanceName) || null;
}

async function stopAllMirrors() {
  await Promise.all([...sessions.keys()].map((name) => stopMirror(name)));
}

module.exports = {
  // orchestration
  startMirror,
  stopMirror,
  stopAllMirrors,
  getMirror,
  MirrorSession,
  ensureServerJar,
  SCRCPY_VERSION,
  SCRCPY_SERVER_SHA256,
  // protocol internals, exported for unit testing without adb/a device
  VideoDemuxer,
  encodeTouch,
  encodeScroll,
  encodeKey,
  encodeBackOrScreenOn,
  MotionAction,
  KeyAction,
  ControlType
};
