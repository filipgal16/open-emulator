import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { WslEngine } = loadDist('engine/wsl-engine.js');

/**
 * The engine is where runtime-specific translation now lives, and `installApk` is the only place
 * that converts a path. That conversion used to sit in `store/installer.ts` and was asserted there
 * only indirectly — via `startsWith('/mnt/')` on a test that had to be skipped off Windows. Testing
 * it here covers the real thing on every platform.
 */
function fakeBridge() {
  const calls = [];
  return {
    calls,
    async runOpenEmu(args, _onLog, timeoutMs) {
      calls.push({ args, timeoutMs });
      return { code: 0, signal: null, stdout: [], stderr: [] };
    },
    async runOpenEmuWithEnv(args, env, _onLog, timeoutMs) {
      calls.push({ args, env, timeoutMs });
      return { code: 0, signal: null, stdout: [], stderr: [] };
    },
  };
}

const noop = () => undefined;

test('a Windows path becomes a quoted /mnt passthrough', async () => {
  const bridge = fakeBridge();
  await new WslEngine(bridge, { profile: null }).installApk('C:\\Users\\x\\app.apk', noop);

  assert.equal(bridge.calls[0].args, "install '/mnt/c/Users/x/app.apk'");
});

test('a path with a space survives quoting rather than splitting into two arguments', async () => {
  const bridge = fakeBridge();
  await new WslEngine(bridge, { profile: null }).installApk('C:\\Program Files\\my app.apk', noop);

  assert.equal(bridge.calls[0].args, "install '/mnt/c/Program Files/my app.apk'");
});

test('a single quote in a path is escaped, not left to end the quoting early', async () => {
  const bridge = fakeBridge();
  await new WslEngine(bridge, { profile: null }).installApk("C:\\tmp\\it's.apk", noop);

  // Close, escaped quote, reopen — the only way to get a literal quote inside a POSIX quoted string.
  assert.equal(bridge.calls[0].args, "install '/mnt/c/tmp/it'\\''s.apk'");
});

test('a secret is carried in the environment, never in the command string', async () => {
  const bridge = fakeBridge();
  await new WslEngine(bridge, { profile: null }).typeSecret('hunter2', noop);

  const call = bridge.calls[0];
  assert.equal(call.env.OE_INPUT_TEXT, 'hunter2');
  assert.ok(
    !call.args.includes('hunter2'),
    'the password must not appear on a command line every process listing can read',
  );
});

test('a quote in a secret is escaped for the guest shell', async () => {
  const bridge = fakeBridge();
  await new WslEngine(bridge, { profile: null }).typeSecret("pa'ss", noop);

  assert.equal(bridge.calls[0].env.OE_INPUT_TEXT, "pa'\\''ss");
});

test('setProfile writes through to the shared target the bridge reads live', () => {
  const target = { profile: null };
  new WslEngine(fakeBridge(), target).setProfile('play');

  assert.equal(target.profile, 'play');
});

test('a cold start is asked for explicitly, and is not the default', async () => {
  const bridge = fakeBridge();
  const engine = new WslEngine(bridge, { profile: null });

  await engine.start(noop);
  await engine.start(noop, { cold: true });

  assert.equal(bridge.calls[0].args, 'start');
  assert.equal(bridge.calls[1].args, 'start --cold');
});

test('the WSL engine has no window to embed, so it reports none', async () => {
  assert.equal(await new WslEngine(fakeBridge(), { profile: null }).displayPid(), null);
});
