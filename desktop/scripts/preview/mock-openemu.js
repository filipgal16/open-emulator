/* Fake `window.openEmu` for viewing the renderer in an ordinary browser.
 *
 * Plain script: no modules, no build step, no inline use, no fetch/XHR (the page's CSP forbids
 * them). Served by scripts/preview-renderer.mjs next to the real bundle.
 *
 * Query string:  ?scene=<name>  &theme=dark|light|system  &speed=<number>
 *
 * @scenes splash setup setup-fail idle idle-error first-start starting booting waiting running apps-loading apps-empty apps store-loading store settings
 */
(function () {
  'use strict';

  var SCENES = [
    'splash', 'setup', 'setup-fail', 'idle', 'idle-error', 'first-start', 'starting', 'booting',
    'waiting', 'running', 'apps-loading', 'apps-empty', 'apps', 'store-loading', 'store', 'settings',
  ];

  var params = new URLSearchParams(location.search);
  var scene = params.get('scene') || 'idle';
  if (SCENES.indexOf(scene) < 0) {
    console.warn('[preview] unknown scene "' + scene + '", using "idle". Known: ' + SCENES.join(', '));
    scene = 'idle';
  }
  var theme = params.get('theme');
  if (theme !== 'light' && theme !== 'system') theme = 'dark';
  var speed = Number(params.get('speed'));
  if (!(speed > 0)) speed = 1;

  function T(ms) { return ms / speed; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, T(ms)); }); }
  function never() { return new Promise(function () {}); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  var now = Date.now();

  // ── Listeners ────────────────────────────────────────────────────────────────────────────────
  var listeners = { setup: [], log: [], frame: [], device: [], job: [], installed: [], index: [] };
  function emit(kind, value) {
    listeners[kind].slice().forEach(function (cb) {
      try { cb(value); } catch (err) { console.error('[preview] listener threw', err); }
    });
  }
  function on(kind) { return function (cb) { if (typeof cb === 'function') listeners[kind].push(cb); }; }

  // ── Scene flags ──────────────────────────────────────────────────────────────────────────────
  var LONG_SETUP = scene === 'setup' || scene === 'setup-fail';
  var isStore = scene === 'store' || scene === 'store-loading';
  var isApps = scene === 'apps' || scene === 'apps-empty' || scene === 'apps-loading';
  var NAV_TARGET = isApps ? 'Apps' : isStore ? 'Store' : scene === 'settings' ? 'Settings' : null;

  // ── Setup ────────────────────────────────────────────────────────────────────────────────────
  // ids/labels: acceleration, extractor, sdk, provisioned are real (setup-steps.ts, native engine).
  // "rom" is a stand-in for the ROM build, which the native engine does inside the sdk step.
  var STEP_DEFS = [
    { id: 'acceleration', label: 'Hardware acceleration', blocking: false, working: 'Checking Windows Hypervisor Platform…', done: 'Windows Hypervisor Platform is on' },
    { id: 'extractor', label: 'Archive support', blocking: true, working: '', done: 'Present' },
    { id: 'sdk', label: 'Android system image', blocking: true, working: 'Downloading Android. This is the long one, and it only happens once.', done: 'Downloaded' },
    { id: 'rom', label: 'Building open-emulator Android', blocking: true, working: 'Building our own Android from the stock image.', done: 'open-emulator Android 14 (build 3)' },
    { id: 'provisioned', label: 'Preparing your device', blocking: false, working: 'Starting Android for the first time and saving a snapshot, so later launches are quick.', done: 'Ready' },
  ];
  var stepDefs = LONG_SETUP ? STEP_DEFS : STEP_DEFS.filter(function (s) { return s.id !== 'rom'; });
  var steps = stepDefs.map(function (s) {
    return { id: s.id, label: s.label, status: 'pending', detail: '', blocking: s.blocking };
  });

  function setStep(id, status, detail) {
    var step = steps.filter(function (s) { return s.id === id; })[0];
    if (!step) return null;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    emit('setup', clone(step));
    return step;
  }

  var logTimer = null;
  function stopLogs() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }
  function startDownloadLog() {
    stopLogs();
    var pct = 12;
    emit('log', { stream: 'stdout', line: '3 packages, 1.2 GB total' });
    emit('log', { stream: 'stdout', line: 'Downloading system-images;android-34;google_apis;x86_64' });
    logTimer = setInterval(function () {
      var mb = Math.round(1229 * pct / 100);
      emit('log', { stream: 'stdout', line: 'system-images;android-34;google_apis;x86_64  ' + mb + ' MB / 1229 MB  ' + pct + '%' });
      if (pct < 97) pct += 1;
    }, T(400));
  }

  var setupRun = null;
  var setupParked = null;
  function runSetup() {
    if (setupParked) return setupParked;
    if (setupRun) return setupRun;
    setupRun = (async function () {
      await sleep(60);
      var splash = scene === 'splash';
      var pause = splash ? 1500 / (steps.length * 2) : LONG_SETUP ? 500 : 15;
      for (var i = 0; i < stepDefs.length; i++) {
        var def = stepDefs[i];
        if (steps[i].status === 'pass') continue;
        setStep(def.id, 'running', def.working);
        if (LONG_SETUP && def.id === 'sdk') {
          startDownloadLog();
          if (scene === 'setup') { setupRun = null; setupParked = never(); return setupParked; }
          await sleep(3000);
          stopLogs();
          emit('log', { stream: 'stderr', line: 'Error: connection reset by peer while downloading system-images;android-34;google_apis;x86_64' });
          setStep(def.id, 'fail', 'The download stopped partway: the connection was reset by the server after 340 MB of 1.2 GB. Check your internet connection and try again.');
          setupRun = null;
          return clone(steps);
        }
        await sleep(pause);
        setStep(def.id, 'pass', def.done);
        await sleep(pause);
      }
      setupRun = null;
      return clone(steps);
    })();
    return setupRun;
  }

  // ── Device ───────────────────────────────────────────────────────────────────────────────────
  var device = {
    profile: 'openemu', phase: 'stopped', avd: 'open-emulator', androidVersion: '14', api: 34,
    bootCompleted: false, provisioned: true, snapshot: true, busy: false, error: null,
  };
  if (scene === 'idle-error') device.error = 'The emulator exited before Android finished starting (exit code 1). Hardware acceleration may be off.';
  if (scene === 'first-start') { device.provisioned = false; device.snapshot = false; device.androidVersion = null; device.api = null; device.avd = null; }
  if (scene === 'starting') { device.phase = 'starting'; device.busy = true; }
  if (scene === 'booting') { device.phase = 'running'; }
  if (scene === 'waiting' || scene === 'running' || isApps || isStore) { device.phase = 'running'; device.bootCompleted = true; }

  function pushDevice(patch) {
    if (patch) for (var k in patch) device[k] = patch[k];
    emit('device', clone(device));
    if (device.phase === 'running' && device.bootCompleted) maybeFrame();
    return clone(device);
  }

  var timers = [];
  function later(ms, fn) { timers.push(setTimeout(fn, T(ms))); }
  function cancelTimers() { timers.forEach(clearTimeout); timers = []; }

  function deviceStart() {
    if (device.phase === 'running' || device.phase === 'starting') return clone(device);
    cancelTimers();
    var first = pushDevice({ phase: 'starting', busy: true, error: null });
    if (scene === 'first-start') return first; // stays there
    later(3000, function () { pushDevice({ phase: 'running', bootCompleted: false, busy: false }); });
    later(6000, function () {
      pushDevice({
        phase: 'running', bootCompleted: true, busy: false, provisioned: true, snapshot: true,
        androidVersion: device.androidVersion || '14', api: device.api || 34, avd: device.avd || 'open-emulator',
      });
    });
    return first;
  }
  function deviceStop() {
    if (device.phase === 'stopped') return clone(device);
    cancelTimers();
    var first = pushDevice({ phase: 'stopping', busy: true });
    later(1500, function () { pushDevice({ phase: 'stopped', bootCompleted: false, busy: false }); });
    return first;
  }

  // ── Frames ───────────────────────────────────────────────────────────────────────────────────
  // 1x1 PNG, used only where there is no canvas.
  var TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  function tinyBytes() {
    var bin = atob(TINY_PNG), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function canvasBlob(w, h, draw) {
    return new Promise(function (resolve) {
      try {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var g = c.getContext('2d');
        if (!g || !c.toBlob) return resolve(null);
        draw(g, w, h);
        c.toBlob(function (b) { resolve(b || null); }, 'image/png');
      } catch (e) { resolve(null); }
    });
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }
  function drawPhone(g, w, h) {
    var bg = g.createLinearGradient(0, 0, w * 0.4, h);
    bg.addColorStop(0, '#1b2433'); bg.addColorStop(1, '#0c1018');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e8edf5'; g.font = '600 56px sans-serif'; g.fillText('9:41', 64, 100);
    g.font = '200 220px sans-serif'; g.fillText('9:41', 64, 420);
    g.font = '400 52px sans-serif'; g.fillStyle = '#9aa7ba'; g.fillText('Thursday, 13 November', 72, 500);
    var colors = ['#4f8cff', '#35c28f', '#f2a33a', '#e0566f', '#8f6bff', '#2bb6d6'];
    for (var i = 0; i < 12; i++) {
      var col = i % 4, row = Math.floor(i / 4);
      var x = 90 + col * 240, y = 700 + row * 280;
      g.fillStyle = colors[i % colors.length]; rr(g, x, y, 170, 170, 44); g.fill();
      g.fillStyle = '#c9d3e2'; g.font = '400 36px sans-serif';
      g.fillText('App ' + (i + 1), x + 24, y + 226);
    }
    g.fillStyle = 'rgba(255,255,255,0.10)'; rr(g, 60, h - 420, w - 120, 220, 70); g.fill();
    for (var d = 0; d < 4; d++) { g.fillStyle = colors[(d + 2) % colors.length]; rr(g, 120 + d * 230, h - 380, 140, 140, 38); g.fill(); }
    g.fillStyle = '#e8edf5'; rr(g, w / 2 - 140, h - 70, 280, 12, 6); g.fill();
  }
  var framePromise = null;
  function frameBytes() {
    if (!framePromise) {
      framePromise = canvasBlob(1080, 1920, drawPhone).then(function (b) {
        return b && b.arrayBuffer ? b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); }) : tinyBytes();
      }).catch(tinyBytes);
    }
    return framePromise;
  }
  var mirroring = false;
  function sendFrame() {
    if (!mirroring || scene === 'waiting') return;
    if (!(device.phase === 'running' && device.bootCompleted)) return;
    frameBytes().then(function (bytes) { if (mirroring) emit('frame', bytes); });
  }
  function maybeFrame() { setTimeout(sendFrame, T(250)); }

  // ── Catalogue ────────────────────────────────────────────────────────────────────────────────
  var DAY = 86400000;
  function mk(source, pkg, name, summary, o) {
    o = o || {};
    return {
      id: source + ':' + pkg, source: source, packageName: pkg, name: name, summary: summary, iconUrl: null,
      versionName: o.v || '1.0.0', versionCode: o.vc || 100, sizeBytes: o.size || 12 * 1048576,
      license: o.license === undefined ? 'GPL-3.0-only' : o.license, minSdk: o.minSdk || 21, abis: o.abis || [],
      categories: o.cats || ['Internet'], lastUpdated: now - (o.days || 3) * DAY, antiFeatures: o.anti || [],
    };
  }
  var CATALOGUE = [
    mk('fdroid', 'org.fdroid.fdroid', 'F-Droid', 'The app store that respects freedom and privacy.', { v: '1.21.1', vc: 1021001, size: 11 * 1048576, days: 1, cats: ['System'] }),
    mk('fdroid', 'org.mozilla.fennec_fdroid', 'Fennec F-Droid', 'Privacy-friendly browser built from Firefox sources.', { v: '131.0.0', vc: 1310000, size: 78 * 1048576, license: 'MPL-2.0', abis: ['arm64-v8a', 'x86_64'], days: 2, cats: ['Internet'] }),
    mk('fdroid', 'org.videolan.vlc', 'VLC', 'Plays almost any video and audio file, and network streams.', { v: '3.6.4', vc: 13060400, size: 46 * 1048576, license: 'GPL-2.0-or-later', abis: ['arm64-v8a', 'x86_64', 'armeabi-v7a'], days: 5, cats: ['Multimedia'] }),
    mk('fdroid', 'org.schabi.newpipe', 'NewPipe', 'A lightweight, privacy-respecting way to watch and listen to online media.', { v: '0.27.2', vc: 1010, size: 11 * 1048576, days: 4, cats: ['Multimedia'], anti: ['NonFreeNet'] }),
    mk('fdroid', 'com.termux', 'Termux', 'Terminal emulator with packages for a full Linux userland.', { v: '0.118.1', vc: 118, size: 108 * 1048576, abis: ['arm64-v8a', 'x86_64'], days: 9, cats: ['System', 'Development'] }),
    mk('fdroid', 'de.danoeh.antennapod', 'AntennaPod', 'A podcast manager and player that gives you instant access to millions of free and paid podcasts.', { v: '3.5.0', vc: 3050000, size: 22 * 1048576, license: 'GPL-3.0-or-later', days: 12, cats: ['Multimedia'] }),
    mk('fdroid', 'net.osmand.plus', 'OsmAnd~', 'Offline maps and navigation based on OpenStreetMap.', { v: '4.8.8', vc: 4808, size: 62 * 1048576, license: 'GPL-3.0-only', abis: ['arm64-v8a', 'x86_64'], days: 15, cats: ['Navigation'], anti: ['NonFreeNet'] }),
    mk('fdroid', 'org.kde.kdeconnect_tp', 'KDE Connect', 'Connect your phone with your computer: share files, clipboard and notifications.', { v: '1.30.1', vc: 13001, size: 9 * 1048576, days: 20, cats: ['Connectivity'] }),
    mk('fdroid', 'org.example.pixelhunt', 'Pixel Hunt', 'A tiny puzzle game that needs a recent Android.', { v: '2.0.0', vc: 20, size: 31 * 1048576, license: 'MIT', minSdk: 35, days: 6, cats: ['Games'], anti: ['Ads', 'Tracking'] }),
    mk('local', 'sideload-retro-racer.apk', 'retro-racer.apk', 'Local APK from android/apps/', { v: '0.9', vc: 9, size: 145 * 1048576, license: null, abis: ['arm64-v8a'], days: 0, cats: [] }),
    mk('local', 'sideload-notes.apk', 'notes.apk', 'Local APK from android/apps/', { v: '1.4', vc: 14, size: 6 * 1048576, license: null, days: 0, cats: [] }),
    mk('play', 'com.google.android.apps.maps', 'Google Maps', 'Opens in the Play tab.', { v: '', vc: 0, size: 0, license: null, minSdk: 0, days: 30, cats: ['Navigation'] }),
  ];
  var DESCRIPTION = 'A longer description for this app. It explains what the app does, who it is for and what it deliberately does not do.\n\nFeatures include offline use, no account requirement, and a settings screen that is easy to find. The preview uses placeholder text.';

  var iconUrls = null;
  function ensureIcons() {
    if (iconUrls) return iconUrls;
    var palette = ['#4f8cff', '#35c28f', '#f2a33a', '#e0566f', '#8f6bff', '#2bb6d6'];
    iconUrls = Promise.all(CATALOGUE.map(function (app, i) {
      if (i % 2 === 1 || !window.URL || !URL.createObjectURL) return Promise.resolve(null);
      return canvasBlob(96, 96, function (g, w, h) {
        g.fillStyle = palette[i % palette.length]; rr(g, 0, 0, w, h, 22); g.fill();
        g.fillStyle = '#fff'; g.font = '600 52px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(app.name.charAt(0).toUpperCase(), w / 2, h / 2 + 3);
      }).then(function (b) { return b ? URL.createObjectURL(b) : null; });
    })).then(function (urls) {
      CATALOGUE.forEach(function (app, i) { app.iconUrl = urls[i]; });
      return true;
    }).catch(function () { return false; });
    return iconUrls;
  }
  var shotUrls = null;
  function ensureShots() {
    if (shotUrls) return shotUrls;
    if (!window.URL || !URL.createObjectURL) { shotUrls = Promise.resolve([]); return shotUrls; }
    shotUrls = Promise.all([0, 1, 2].map(function (n) {
      return canvasBlob(360, 640, function (g, w, h) {
        var bg = g.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, ['#243b64', '#1f4d3f', '#4a2a55'][n]); bg.addColorStop(1, '#0c1018');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,0.14)';
        for (var i = 0; i < 6; i++) { rr(g, 24, 70 + i * 86, w - 48, 66, 14); g.fill(); }
      }).then(function (b) { return b ? URL.createObjectURL(b) : null; });
    })).then(function (urls) { return urls.filter(Boolean); }).catch(function () { return []; });
    return shotUrls;
  }

  var installed = [
    { packageName: 'org.fdroid.fdroid', label: 'F-Droid' },
    { packageName: 'org.videolan.vlc', label: 'VLC' },
    { packageName: 'com.termux', label: 'Termux' },
  ];
  var APPS_12 = [
    ['org.fdroid.fdroid', 'F-Droid'], ['org.mozilla.fennec_fdroid', 'Fennec F-Droid'], ['org.videolan.vlc', 'VLC'],
    ['org.schabi.newpipe', 'NewPipe'], ['com.termux', 'Termux'], ['de.danoeh.antennapod', 'AntennaPod'],
    ['net.osmand.plus', 'OsmAnd~'], ['org.kde.kdeconnect_tp', 'KDE Connect'], ['com.android.settings', 'Settings'],
    ['com.android.chrome', 'Chrome'], ['org.proninyaroslav.libretorrent', 'LibreTorrent'], ['com.android.calculator2', 'Calculator'],
  ].map(function (p) { return { packageName: p[0], label: p[1] }; });
  if (scene === 'apps') installed = APPS_12.slice();
  if (scene === 'apps-empty') installed = [];

  var storeState = {
    indexReady: scene !== 'store-loading', indexUpdatedAt: now - 3 * 3600000, indexAppCount: scene === 'store-loading' ? 0 : 4213,
    guestSdk: scene === 'store-loading' ? null : 34, playAvailable: false, identitySpoofed: false,
  };
  function storeStateNow() {
    var s = clone(storeState);
    if (!isStore) s.guestSdk = device.phase === 'running' && device.bootCompleted ? 34 : null;
    return s;
  }

  var jobs = [];
  var jobSeq = 1;
  function makeJob(app) {
    return {
      id: 'job-' + (jobSeq++), packageName: app.packageName, resolvedPackage: null, label: app.name, source: app.source,
      state: 'downloading', bytesDone: 0, bytesTotal: app.sizeBytes || 20 * 1048576, error: null, startedAt: Date.now(),
    };
  }
  function pushJob(job) { emit('job', clone(job)); }
  if (scene === 'store') {
    var stuck = makeJob(CATALOGUE[1]);
    stuck.bytesDone = Math.round(stuck.bytesTotal * 0.18);
    jobs.push(stuck);
    setInterval(function () {
      if (stuck.bytesDone < stuck.bytesTotal * 0.97) {
        stuck.bytesDone = Math.min(Math.round(stuck.bytesTotal * 0.97), stuck.bytesDone + Math.round(stuck.bytesTotal * 0.012));
        pushJob(stuck);
      }
    }, T(500));
  }
  function runQuickInstall(job, app) {
    var total = job.bytesTotal, n = 8, i = 0;
    var t = setInterval(function () {
      i++;
      if (i <= n) { job.state = 'downloading'; job.bytesDone = Math.round(total * i / n); }
      else if (i === n + 1) { job.state = 'verifying'; }
      else if (i === n + 2) { job.state = 'installing'; }
      else {
        job.state = 'done'; job.resolvedPackage = app.packageName; job.bytesDone = total;
        clearInterval(t);
        if (!installed.some(function (a) { return a.packageName === app.packageName; })) installed.push({ packageName: app.packageName, label: app.name });
        pushJob(job);
        emit('installed', app.packageName);
        return;
      }
      pushJob(job);
    }, T(450));
  }

  // ── Account ──────────────────────────────────────────────────────────────────────────────────
  var profile = { displayName: 'Alex', email: 'alex.example@gmail.com', hasStoredPassword: true, autoFill: false, createdAt: now - 20 * DAY };
  function accountNow() {
    var up = device.phase === 'running' && device.bootCompleted;
    return {
      profile: clone(profile),
      guest: up
        ? { state: 'signed-in', accounts: profile.email ? [{ name: profile.email, type: 'com.google' }] : [], checkedAt: Date.now(), avd: device.avd }
        : { state: 'guest-unavailable', accounts: [], checkedAt: Date.now(), avd: device.avd },
      vaultAvailable: true,
    };
  }

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────
  var settings = { theme: theme, downloadRoot: null, device: 'generic', cores: null, ramMb: null };
  var storage = { root: 'C:\\Users\\Alex\\AppData\\Local\\open-emulator', totalBytes: 9.4 * 1073741824, reclaimableBytes: 1.3 * 1073741824 };
  var lastMessage;
  function settingsNow() {
    var s = {
      settings: clone(settings),
      tuning: { cores: 4, ramMb: 4096, gpuMode: 'host', accelerated: true, accelerationDetail: 'Windows Hypervisor Platform is on', hostCpus: 12, hostRamMb: 32768 },
      storage: clone(storage), engine: 'sdk',
    };
    if (lastMessage) s.lastMessage = lastMessage;
    return s;
  }
  var defender = 'not-excluded';

  // ── The API ──────────────────────────────────────────────────────────────────────────────────
  function search(query, source, limit) {
    var q = String(query || '').trim().toLowerCase();
    var out = CATALOGUE.filter(function (a) {
      if (source && a.source !== source) return false;
      if (!source && a.source === 'play') return false;
      return !q || (a.name + ' ' + a.summary + ' ' + a.packageName).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return b.lastUpdated - a.lastUpdated; });
    return clone(out.slice(0, limit || 60));
  }
  function statusCmd() {
    return { code: 0, signal: null, stdout: ['state=' + device.phase, 'provisioned_at=' + new Date(now).toISOString()], stderr: [] };
  }

  var rotation = 0;
  var api = {
    runStatus: function () { return Promise.resolve(statusCmd()); },
    getSetupSteps: function () { return Promise.resolve(clone(steps)); },
    runSetupChecks: function () { return Promise.resolve(clone(steps)); },
    runSetupAuto: function () { return runSetup(); },
    runSetupFix: function (id) {
      var step = steps.filter(function (s) { return s.id === id; })[0];
      return Promise.resolve(clone(step || { id: id, label: id, status: 'pass', detail: '', blocking: false }));
    },
    onSetupStep: on('setup'),
    onLog: on('log'),
    startMirror: function () { mirroring = true; maybeFrame(); },
    stopMirror: function () { mirroring = false; },
    onFrame: on('frame'),
    reportViewport: function () { return Promise.resolve(false); },
    screenshot: function () {
      if (!(device.phase === 'running' && device.bootCompleted)) return Promise.resolve(null);
      return frameBytes();
    },
    rotateDevice: function () { rotation = (rotation + 1) % 4; return Promise.resolve(rotation); },
    tap: function () {},
    swipe: function () {},
    key: function () {},
    typeText: function () { return Promise.resolve(true); },
    listApps: function () { return scene === 'apps-loading' ? never() : Promise.resolve(clone(installed)); },
    launchApp: function () { return sleep(600).then(function () { return true; }); },

    deviceState: function () { return Promise.resolve(clone(device)); },
    deviceStart: function () { return Promise.resolve(deviceStart()); },
    deviceStop: function () { return Promise.resolve(deviceStop()); },
    devicePrepare: function () {
      var first = pushDevice({ busy: true, error: null });
      later(2500, function () { pushDevice({ busy: false, provisioned: true, snapshot: true, androidVersion: '14', api: 34, avd: 'open-emulator' }); });
      return Promise.resolve(first);
    },
    deviceSetProfile: function (id) {
      if (device.phase === 'running' || device.phase === 'starting') {
        var refused = clone(device);
        refused.error = 'Stop the device before switching Android versions.';
        return Promise.resolve(refused);
      }
      return Promise.resolve(pushDevice({ profile: id, error: null }));
    },
    onDeviceState: on('device'),

    storeState: function () { return Promise.resolve(storeStateNow()); },
    storeProbeGuest: function () { return Promise.resolve(storeStateNow()); },
    storeRefreshIndex: function () { return Promise.resolve(storeStateNow()); },
    storeSearch: function (query, source, limit) {
      if (scene === 'store-loading') return never();
      return ensureIcons().then(function () { return search(query, source, limit); });
    },
    storeDetail: function (source, packageName) {
      var app = CATALOGUE.filter(function (a) { return a.source === source && a.packageName === packageName; })[0];
      if (!app) return Promise.resolve(null);
      return Promise.all([ensureIcons(), ensureShots()]).then(function (r) {
        var d = clone(app);
        d.description = DESCRIPTION;
        d.webSite = 'https://example.org/' + app.packageName.split('.').pop();
        d.sourceCode = 'https://git.example.org/' + app.packageName.split('.').pop() + '/app';
        d.screenshotUrls = source === 'fdroid' ? r[1] : [];
        d.otherVersions = source === 'fdroid' ? [
          { versionName: '0.9.4', versionCode: app.versionCode - 10, sizeBytes: Math.round(app.sizeBytes * 0.95), minSdk: 21, added: now - 60 * DAY },
          { versionName: '0.9.0', versionCode: app.versionCode - 20, sizeBytes: Math.round(app.sizeBytes * 0.9), minSdk: 19, added: now - 140 * DAY },
          { versionName: '1.0.0-beta', versionCode: app.versionCode - 5, sizeBytes: Math.round(app.sizeBytes * 1.05), minSdk: 35, added: now - 20 * DAY },
        ] : [];
        return d;
      });
    },
    storeInstall: function (source, packageName) {
      var app = CATALOGUE.filter(function (a) { return a.source === source && a.packageName === packageName; })[0];
      if (!app) return Promise.resolve(null);
      var existing = jobs.filter(function (j) { return j.packageName === packageName && j.source === source && j.state !== 'failed'; })[0];
      if (existing) return Promise.resolve(clone(existing));
      var job = makeJob(app);
      jobs.unshift(job);
      setTimeout(function () { runQuickInstall(job, app); }, T(300));
      return Promise.resolve(clone(job));
    },
    storeJobs: function () { return Promise.resolve(clone(jobs)); },
    storeImportApk: function () { return Promise.resolve(true); },
    onStoreJob: on('job'),
    onStoreInstalled: on('installed'),
    onStoreIndexUpdated: on('index'),
    pathForFile: function () { return null; },

    playOpen: function () { return Promise.resolve(true); },
    playSearch: function () { return Promise.resolve(true); },
    playDetails: function () { return Promise.resolve(true); },
    playBack: function () { return Promise.resolve(true); },

    accountState: function () { return Promise.resolve(accountNow()); },
    accountRefresh: function () { return Promise.resolve(accountNow()); },
    accountSetEmail: function (email) { profile.email = email || null; return Promise.resolve(accountNow()); },
    accountSetDisplayName: function (name) { profile.displayName = String(name || ''); return Promise.resolve(accountNow()); },
    accountSetPassword: function (password) {
      profile.hasStoredPassword = !!password;
      if (!password) profile.autoFill = false;
      return Promise.resolve(accountNow());
    },
    accountSetAutofill: function (enabled) { profile.autoFill = !!enabled; return Promise.resolve(accountNow()); },
    accountSignOut: function () {
      profile.email = null; profile.hasStoredPassword = false; profile.autoFill = false;
      return Promise.resolve(accountNow());
    },
    accountBeginSignIn: function () { return Promise.resolve({ ok: true, message: 'Opened the Google sign-in screen on the device.' }); },
    accountFill: function (field) { return Promise.resolve({ ok: true, message: 'Typed the ' + field + ' into the focused field.' }); },

    settingsState: function () { return Promise.resolve(settingsNow()); },
    settingsSet: function (patch) {
      patch = patch || {};
      if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system') settings.theme = patch.theme;
      if (patch.device === 'generic' || patch.device === 'pixel_5' || patch.device === 'redmi_note_11') settings.device = patch.device;
      if ('cores' in patch) settings.cores = patch.cores;
      if ('ramMb' in patch) settings.ramMb = patch.ramMb;
      if ('downloadRoot' in patch) settings.downloadRoot = patch.downloadRoot;
      lastMessage = undefined;
      return Promise.resolve(settingsNow());
    },
    settingsFreeSpace: function () {
      return sleep(700).then(function () {
        var freed = storage.reclaimableBytes;
        storage.totalBytes -= freed;
        storage.reclaimableBytes = 0;
        lastMessage = 'Freed ' + (freed / 1073741824).toFixed(1) + ' GB.';
        return settingsNow();
      });
    },
    settingsChooseDownloadFolder: function () {
      return sleep(700).then(function () {
        settings.downloadRoot = 'D:\\Android\\open-emulator';
        storage.root = settings.downloadRoot;
        lastMessage = 'Moved 9.4 GB to D:\\Android\\open-emulator. Restart to use it.';
        return settingsNow();
      });
    },
    settingsRestartApp: function () { return Promise.resolve(); },

    defenderState: function () { return Promise.resolve(defender); },
    defenderSetExcluded: function (enabled) {
      return sleep(800).then(function () { defender = enabled ? 'excluded' : 'not-excluded'; return { state: defender }; });
    },
  };

  window.openEmu = api;

  window.__preview = {
    scene: scene,
    scenes: SCENES.slice(),
    theme: theme,
    speed: speed,
    setDevice: function (partial) { return pushDevice(partial || {}); },
    pushStep: function (status) {
      status = status || {};
      var known = steps.filter(function (s) { return s.id === status.id; })[0];
      if (!known) return null;
      return setStep(status.id, status.status || known.status, status.detail);
    },
    log: function (line) { emit('log', { stream: 'stdout', line: String(line) }); },
  };

  // ── Start on the right tab ───────────────────────────────────────────────────────────────────
  // The app reads no query string; once its nav exists, click the matching button.
  if (NAV_TARGET && typeof document !== 'undefined') {
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      var items = document.querySelectorAll ? document.querySelectorAll('.nav-rail-item') : [];
      for (var i = 0; i < items.length; i++) {
        if ((items[i].textContent || '').trim() === NAV_TARGET) {
          clearInterval(poll);
          items[i].click();
          return;
        }
      }
      if (tries > 600) clearInterval(poll);
    }, 100);
  }
})();
