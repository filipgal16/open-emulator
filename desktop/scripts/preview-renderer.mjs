// Serves the built renderer in an ordinary browser with a fake `window.openEmu`, so every screen
// can be looked at without Electron, WSL or an emulator.
//
//   node scripts/preview-renderer.mjs [--port 5599] [--build]
//
// dist/renderer/index.html is read fresh on every request and gets one in-memory change: the mock
// is loaded just before bundle.js. The CSP meta tag is left exactly as it is, so the preview breaks
// the same way the app would if the mock (or the renderer) ever tried something the CSP forbids.

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');
const rendererDir = path.join(root, 'dist', 'renderer');
const mockDir = path.join(scriptsDir, 'preview');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 5599;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('preview: --port needs a number');
  process.exit(2);
}

if (args.includes('--build')) {
  for (const script of ['build-renderer.mjs', 'copy-static.mjs']) {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, script)], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`preview: ${script} failed`);
      process.exit(result.status ?? 1);
    }
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const MOCK_TAG = '<script src="/__mock/mock-openemu.js"></script>';

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** Resolves `rel` under `base`, or null if it would leave it. */
function inside(base, rel) {
  const target = path.resolve(base, rel);
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

async function serveFile(res, base, rel) {
  const target = inside(base, rel);
  if (!target) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  try {
    const body = await readFile(target);
    send(res, 200, TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream', body);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
}

async function serveIndex(res) {
  let html;
  try {
    html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  } catch {
    return send(
      res,
      500,
      'text/plain; charset=utf-8',
      'dist/renderer/index.html is missing. Run: node scripts/build-renderer.mjs && node scripts/copy-static.mjs (or start with --build).',
    );
  }
  const bundle = /<script\b[^>]*\bsrc=["']\.\/bundle\.js["'][^>]*>\s*<\/script>/i.exec(html);
  if (!bundle) return send(res, 500, 'text/plain; charset=utf-8', 'could not find the bundle.js script tag in index.html');
  html = html.slice(0, bundle.index) + MOCK_TAG + '\n    ' + html.slice(bundle.index);
  send(res, 200, TYPES['.html'], html);
}

/** Scene names come from the mock itself (its `@scenes` header), so there is one list. */
async function sceneNames() {
  try {
    const source = await readFile(path.join(mockDir, 'mock-openemu.js'), 'utf8');
    const match = /@scenes\s+([^\r\n*]+)/.exec(source);
    if (match) return match[1].trim().split(/\s+/);
  } catch {
    // fall through
  }
  return [];
}

async function serveScenes(res) {
  const scenes = await sceneNames();
  const rows = scenes
    .map(
      (scene) =>
        `<tr><td>${scene}</td>` +
        ['dark', 'light', 'system'].map((theme) => `<td><a href="/?scene=${scene}&amp;theme=${theme}">${theme}</a></td>`).join('') +
        '</tr>',
    )
    .join('\n');
  send(
    res,
    200,
    TYPES['.html'],
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>open-emulator preview scenes</title>` +
      `<body style="font-family:system-ui,sans-serif;margin:2rem;line-height:1.6">` +
      `<h1>Renderer preview</h1>` +
      `<p>Fake backend. Add <code>&amp;speed=4</code> to run timers faster. From the console: <code>__preview.setDevice({phase:'stopped'})</code>.</p>` +
      `<table cellpadding="6"><tr><th align="left">scene</th><th>dark</th><th>light</th><th>system</th></tr>${rows}</table></body>`,
  );
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'text/plain; charset=utf-8', 'bad request');

  if (pathname === '/' || pathname === '/index.html') return void serveIndex(res);
  if (pathname === '/__scenes') return void serveScenes(res);
  if (pathname === '/bundle.js' || pathname === '/bundle.js.map') return void serveFile(res, rendererDir, pathname.slice(1));
  if (pathname.startsWith('/__mock/')) return void serveFile(res, mockDir, pathname.slice('/__mock/'.length));
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.on('error', (err) => {
  console.error(`preview: ${err.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${server.address().port}/__scenes`);
});
