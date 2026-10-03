#!/usr/bin/env node
// emu-compare.mjs — runs one identical measurement suite against any Android emulator over adb, so
// open-emulator and LDPlayer (or anything else) can be compared with the same definitions.
//
// Boot time is deliberately not measured here: android/scripts/bench.sh (open-emulator) and
// android/scripts/bench_ldplayer.ps1 (LDPlayer) already measure it with matching definitions.
//
// Usage:
//   node android/scripts/emu-compare.mjs --adb <adb path> --serial <serial> --label <name> [--apk ApiDemos-debug.apk]
//   node android/scripts/emu-compare.mjs --compare a.json b.json
//
// On Windows (PowerShell), run each emulator on its own with the other one closed:
//   node android/scripts/emu-compare.mjs --adb C:\LDPlayer\LDPlayer9\adb.exe --serial 127.0.0.1:5555 --label ldplayer --apk .\ApiDemos-debug.apk
//   node android/scripts/emu-compare.mjs --adb "$env:LOCALAPPDATA\open-emulator\sdk\platform-tools\adb.exe" --serial emulator-5554 --label open-emulator --apk .\ApiDemos-debug.apk
//   node android/scripts/emu-compare.mjs --compare ldplayer.json open-emulator.json
//
// The open-emulator line assumes the native runtime (OPEN_EMULATOR_ENGINE=sdk) and the default
// download folder; if Settings -> Storage points elsewhere, use that folder's sdk\platform-tools.
// For the WSL runtime, run this script inside the distro against android/sdk/platform-tools/adb.
// Let each guest sit idle for a minute after boot first, so background boot work doesn't skew it.
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

if (argv[0] === '--compare') {
  const [a, b] = argv.slice(1, 3).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const keys = [...new Set([...Object.keys(a.summary), ...Object.keys(b.summary)])];
  const w = Math.max(...keys.map((k) => k.length));
  console.log(`${'metric'.padEnd(w)}  ${a.label.padStart(14)}  ${b.label.padStart(14)}  ratio(${b.label}/${a.label})`);
  for (const k of keys) {
    const x = a.summary[k], y = b.summary[k];
    const r = Number.isFinite(x) && Number.isFinite(y) && x > 0 ? (y / x).toFixed(2) + 'x' : '';
    console.log(`${k.padEnd(w)}  ${String(x ?? '-').padStart(14)}  ${String(y ?? '-').padStart(14)}  ${r}`);
  }
  console.log('\nAll times in ms (lower is better) except *_fps and *_mb_s (higher is better).');
  console.log('oe_mirror_fps_* only describe open-emulator\'s screen mirror; LDPlayer renders its own window.');
  process.exit(0);
}

const ADB = opt('adb', 'adb');
const SERIAL = opt('serial');
const LABEL = opt('label', SERIAL ?? 'device');
const TRIALS = Number(opt('trials', '3'));
const APK = opt('apk');
const APK_COMPONENT = opt('component', 'io.appium.android.apis/.ApiDemos');
if (!SERIAL) {
  console.error('usage: node emu-compare.mjs --adb <adb> --serial <serial> --label <name> [--apk file.apk] [--trials 3]');
  process.exit(2);
}

/** Runs adb and resolves with its output and wall time. Never rejects: a failure is data here. */
function adb(args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    execFile(ADB, ['-s', SERIAL, ...args], { timeout: timeoutMs, maxBuffer: 64 << 20, encoding: 'buffer' },
      (err, stdout, stderr) => resolve({
        ok: !err, ms: Math.round(performance.now() - t0),
        out: stdout.toString('latin1').replace(/\r/g, ''), err: stderr.toString('utf8'), bytes: stdout.length,
      }));
  });
}
const sh = (cmd, timeoutMs) => adb(['shell', cmd], timeoutMs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const result = { label: LABEL, serial: SERIAL, when: new Date().toISOString(), facts: {}, raw: {}, summary: {} };
const put = (key, values) => { result.raw[key] = values; result.summary[key] = median(values); };

log(`== ${LABEL} (${SERIAL}) ==`);
for (const p of ['ro.build.version.release', 'ro.build.version.sdk', 'ro.product.model', 'ro.product.cpu.abi']) {
  result.facts[p] = (await sh(`getprop ${p}`)).out.trim();
}
result.facts.nproc = (await sh('nproc')).out.trim();
result.facts.memTotal = ((await sh('grep MemTotal /proc/meminfo')).out.match(/\d+/) ?? [''])[0] + ' kB';
log(result.facts);

// adb itself costs something per call; everything below includes it, as the desktop app pays it too.
const overhead = [];
for (let i = 0; i < 5; i++) overhead.push((await sh('true')).ms);
put('adb_roundtrip_ms', overhead);
log(`adb round trip: ${overhead.join(' ')} ms`);

const components = ['com.android.settings/.Settings'];
if (APK) {
  const pkg = APK_COMPONENT.split('/')[0];
  const size = statSync(APK).size;
  const times = [];
  for (let i = 0; i < TRIALS; i++) {
    await adb(['uninstall', pkg]);
    const r = await adb(['install', '-r', '-g', '-d', APK], 600_000);
    times.push(r.ok && /Success/.test(r.out) ? r.ms : NaN);
    log(`install ${path.basename(APK)} (${(size / 1e6).toFixed(1)} MB) #${i + 1}: ${r.ms} ms ${r.ok ? '' : r.err.trim()}`);
  }
  put('apk_install_ms', times);
  components.push(APK_COMPONENT);
}

for (const comp of components) {
  const pkg = comp.split('/')[0];
  const name = pkg.split('.').pop();
  const cold = [], coldWall = [], hot = [];
  for (let i = 0; i < TRIALS; i++) {
    await sh(`am force-stop ${pkg}`);
    await sleep(1000);
    let r = await sh(`am start -W -S -n ${comp}`);
    cold.push(Number((r.out.match(/TotalTime: (\d+)/) ?? [])[1])); coldWall.push(r.ms);
    await sleep(2000);
    await sh('input keyevent KEYCODE_HOME');
    await sleep(2000);
    r = await sh(`am start -W -n ${comp}`);
    hot.push(Number((r.out.match(/TotalTime: (\d+)/) ?? [])[1]));
    log(`launch ${comp} #${i + 1}: cold ${cold.at(-1)} ms (wall ${coldWall.at(-1)}), hot ${hot.at(-1)} ms`);
    await sleep(1000);
  }
  put(`launch_cold_${name}_ms`, cold);
  put(`launch_cold_wall_${name}_ms`, coldWall);
  put(`launch_hot_${name}_ms`, hot);
  await sh('input keyevent KEYCODE_HOME');
}

// The desktop app's Apps tab launches through monkey, which starts its own JVM first.
const monkey = [];
for (let i = 0; i < TRIALS; i++) {
  await sh('am force-stop com.android.settings');
  await sh('input keyevent KEYCODE_HOME');
  await sleep(1500);
  monkey.push((await sh('monkey -p com.android.settings -c android.intent.category.LAUNCHER 1')).ms);
}
put('launch_via_monkey_settings_ms', monkey);
log(`monkey launch: ${monkey.join(' ')} ms`);

const tap = [], key = [];
for (let i = 0; i < 8; i++) tap.push((await sh('input tap 5 5')).ms);
for (let i = 0; i < 8; i++) key.push((await sh('input keyevent KEYCODE_UNKNOWN')).ms);
put('input_tap_ms', tap);
put('input_keyevent_ms', key);
log(`input tap: ${tap.join(' ')} ms; keyevent: ${key.join(' ')} ms`);

await sh('am start -W -n com.android.settings/.Settings');
await sleep(2000);
const png = [], raw = [];
let pngBytes = 0;
for (let i = 0; i < 10; i++) { const r = await adb(['exec-out', 'screencap', '-p']); png.push(r.ms); pngBytes = r.bytes; }
for (let i = 0; i < 5; i++) raw.push((await adb(['exec-out', 'screencap'])).ms);
put('screencap_png_ms', png);
put('screencap_raw_ms', raw);
// What open-emulator's screen mirror can reach at this screencap cost. Only meaningful for
// open-emulator — LDPlayer draws its own window and never goes through screencap.
//   WSL runtime:    screencap -p, then a fixed 300 ms sleep (src/main/wsl/screen-mirror.ts)
//   native runtime: a 250 ms interval that skips ticks while a capture is in flight
//                   (src/main/engine/engine-mirror.ts), so at most 4 FPS
result.summary.oe_mirror_fps_wsl = +(1000 / (median(png) + 300)).toFixed(2);
result.summary.oe_mirror_fps_native = +(1000 / (Math.ceil(median(png) / 250) * 250)).toFixed(2);
log(`screencap -p: ${png.join(' ')} ms (${pngBytes} B); raw: ${raw.join(' ')} ms`);

await sh('dumpsys gfxinfo com.android.settings reset');
for (let i = 0; i < 5; i++) {
  await sh('input swipe 300 900 300 300 300');
  await sleep(700);
  await sh('input swipe 300 300 300 900 300');
  await sleep(700);
}
const gfx = (await sh('dumpsys gfxinfo com.android.settings')).out;
const num = (re) => Number((gfx.match(re) ?? [])[1]);
result.summary.ui_frames = num(/Total frames rendered: (\d+)/);
result.summary.ui_janky_pct = num(/Janky frames: \d+ \(([\d.]+)%\)/);
result.summary.ui_frame_p50_ms = num(/50th percentile: (\d+)ms/);
result.summary.ui_frame_p90_ms = num(/90th percentile: (\d+)ms/);
result.summary.ui_frame_p99_ms = num(/99th percentile: (\d+)ms/);
log(`UI: ${result.summary.ui_frames} frames, ${result.summary.ui_janky_pct}% janky, p50 ${result.summary.ui_frame_p50_ms} ms, p90 ${result.summary.ui_frame_p90_ms} ms`);
await sh('input keyevent KEYCODE_HOME');

// CPU and storage with tools every Android build has (toybox), so no binary needs pushing.
const hash = [], wr = [], rd = [];
for (let i = 0; i < TRIALS; i++) {
  hash.push((await sh('dd if=/dev/zero bs=1048576 count=128 2>/dev/null | md5sum >/dev/null')).ms);
  wr.push((await sh('dd if=/dev/zero of=/data/local/tmp/emu-compare.bin bs=1048576 count=256 2>/dev/null; sync')).ms);
  rd.push((await sh('dd if=/data/local/tmp/emu-compare.bin of=/dev/null bs=1048576 2>/dev/null')).ms);
  await sh('rm -f /data/local/tmp/emu-compare.bin');
}
put('cpu_md5_128MiB_ms', hash);
put('disk_write_256MiB_ms', wr);
put('disk_read_256MiB_cached_ms', rd);
result.summary.disk_write_mb_s = +(256 / (median(wr) / 1000)).toFixed(1);
log(`md5 128 MiB: ${hash.join(' ')} ms; write 256 MiB: ${wr.join(' ')} ms; read: ${rd.join(' ')} ms`);

const file = opt('out', `${LABEL}.json`);
writeFileSync(file, JSON.stringify(result, null, 2));
log(`\nsummary (medians):`);
for (const [k, v] of Object.entries(result.summary)) log(`  ${k.padEnd(34)} ${v}`);
log(`\nwrote ${file}`);
