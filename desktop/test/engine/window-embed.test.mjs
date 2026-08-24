import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

// The module calls into user32 and kernel32, so it only means anything on Windows.
const opts = process.platform === 'win32' ? { timeout: 30_000 } : { skip: 'Win32 only' };
const W = process.platform === 'win32' ? loadDist('engine/window-embed.js') : {};

test('a process tree always contains its own root', opts, () => {
  const pids = W.descendantPids(process.pid);
  assert.ok(pids.has(process.pid));
});

test('a child process is found in the tree', opts, async () => {
  // This is the whole reason the tree search exists: emulator.exe is a launcher that spawns a
  // separate qemu process, and the guest window belongs to that child, not to the pid we started.
  // Searching only the launched pid finds nothing at all.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  await new Promise((r) => setTimeout(r, 500));

  try {
    const pids = W.descendantPids(process.pid);
    assert.ok(pids.has(child.pid), `child ${child.pid} missing from the tree`);
  } finally {
    child.kill();
  }
});

test('a pid that does not exist yields just itself, without throwing', opts, () => {
  const pids = W.descendantPids(999_999);
  assert.deepEqual([...pids], [999_999]);
});

test('no window is found for a pid that owns none', opts, () => {
  assert.equal(W.findMainWindowForPid(999_999), null);
  assert.equal(W.findMainWindowForProcessTree(999_999), null);
});

test('waiting for a window that never appears times out rather than hanging', opts, async () => {
  const started = Date.now();
  const hwnd = await W.waitForWindow(999_999, 400, 100);

  assert.equal(hwnd, null);
  assert.ok(Date.now() - started < 5_000, 'returned promptly');
});

test('operations on a null handle fail closed instead of throwing', opts, () => {
  // A guest can exit at any moment, so every one of these can legitimately be handed a dead
  // handle — and crashing the main process over it would take the whole app down.
  assert.equal(W.isLiveWindow(null), false);
  assert.equal(W.moveWindow(null, { x: 0, y: 0, width: 10, height: 10 }), false);
  assert.equal(W.setWindowVisible(null, true), false);
  assert.equal(W.clientSize(null), null);
});
