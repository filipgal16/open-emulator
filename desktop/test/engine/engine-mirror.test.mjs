import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { EngineMirror } = loadDist('engine/engine-mirror.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeEngine({ frames = [], delay = 0, fails = false } = {}) {
  const engine = { id: 'sdk', calls: 0, setProfile() {}, async displayHandle() { return null; } };
  engine.screencap = async () => {
    engine.calls += 1;
    if (delay) await wait(delay);
    if (fails) throw new Error('no running guest');
    return frames.shift() ?? Buffer.from([1, 2, 3]);
  };
  return engine;
}

test('frames are delivered on an interval', async () => {
  const engine = fakeEngine();
  const seen = [];
  const mirror = new EngineMirror(engine, 20);

  mirror.start((png) => seen.push(png), () => {});
  await wait(120);
  mirror.stop();

  assert.ok(seen.length >= 3, `expected several frames, got ${seen.length}`);
  assert.ok(Buffer.isBuffer(seen[0]));
});

test('a slow capture is skipped, not queued into a backlog', async () => {
  // A capture slower than the interval would otherwise build up requests that all return stale
  // frames, and the display would drift further behind the guest the longer it ran.
  const engine = fakeEngine({ delay: 120 });
  const mirror = new EngineMirror(engine, 10);

  mirror.start(() => {}, () => {});
  await wait(150);
  mirror.stop();

  assert.ok(engine.calls <= 3, `overlapping captures piled up: ${engine.calls} calls`);
});

test('an empty capture is not treated as a frame', async () => {
  // Normal while the guest is still coming up: nothing to show yet is not an error. Always empty,
  // rather than a short list — the interval fires more often than a fixed list has entries.
  const engine = fakeEngine();
  engine.screencap = async () => Buffer.alloc(0);
  const seen = [];
  const logs = [];
  const mirror = new EngineMirror(engine, 10);

  mirror.start((png) => seen.push(png), (_s, line) => logs.push(line));
  await wait(35);
  mirror.stop();

  assert.equal(seen.length, 0);
  assert.equal(logs.length, 0, 'and it is not logged as a failure');
});

test('a failing capture is reported once, not four times a second', async () => {
  const logs = [];
  const mirror = new EngineMirror(fakeEngine({ fails: true }), 10);

  mirror.start(() => {}, (_s, line) => logs.push(line));
  await wait(120);
  mirror.stop();

  assert.equal(logs.length, 1, `a dead guest should not flood the log: ${logs.length} lines`);
  assert.match(logs[0], /screen capture failed/);
});

test('stop halts capturing', async () => {
  const engine = fakeEngine();
  const mirror = new EngineMirror(engine, 10);

  mirror.start(() => {}, () => {});
  await wait(40);
  mirror.stop();
  const atStop = engine.calls;
  await wait(60);

  assert.equal(engine.calls, atStop, 'still capturing after stop');
  assert.equal(mirror.active, false);
});

test('an engine that cannot capture says so instead of silently showing nothing', async () => {
  const engine = { id: 'wsl', setProfile() {}, async displayHandle() { return null; } };
  const logs = [];

  new EngineMirror(engine, 10).start(() => {}, (_s, line) => logs.push(line));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /cannot capture frames/);
});
