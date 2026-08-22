import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { GuestAccountMonitor, parseAccounts, GOOGLE_ACCOUNT_TYPE } = loadDist('account/guest-account.js');

const DUMP = `
Accounts: 2
  Account {name=someone@gmail.com, type=com.google}
  Account {name=work@example.com, type=com.example.work}

User UserInfo{0:Owner:c13}:
  Accounts: 2
  Account {name=someone@gmail.com, type=com.google}
`;

function fakeOpenEmu(stdout, { code = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async shell(command) {
      calls.push(command);
      return { code, signal: null, stdout, stderr: [] };
    },
  };
}

test('accounts are parsed out of the dump', () => {
  const accounts = parseAccounts(DUMP);
  assert.deepEqual(accounts, [
    { name: 'someone@gmail.com', type: GOOGLE_ACCOUNT_TYPE },
    { name: 'work@example.com', type: 'com.example.work' },
  ]);
});

test('the same account mentioned in several sections is counted once', () => {
  // dumpsys repeats accounts under each authenticator's cache; without dedupe one Google address
  // would read as three accounts.
  assert.equal(parseAccounts(DUMP).filter((a) => a.type === GOOGLE_ACCOUNT_TYPE).length, 1);
});

test('a dump with no accounts parses to nothing', () => {
  assert.deepEqual(parseAccounts('Accounts: 0\n'), []);
  assert.deepEqual(parseAccounts(''), []);
});

test('a signed-in guest is reported with only its Google accounts', async () => {
  const monitor = new GuestAccountMonitor(fakeOpenEmu(DUMP.split('\n')));
  const state = await monitor.refresh('OpenEmulator_API30_play');

  assert.equal(state.state, 'signed-in');
  assert.deepEqual(state.accounts, [{ name: 'someone@gmail.com', type: GOOGLE_ACCOUNT_TYPE }]);
  assert.equal(state.avd, 'OpenEmulator_API30_play');
  assert.ok(state.checkedAt > 0);
});

test('a guest with only non-Google accounts counts as signed out', async () => {
  const monitor = new GuestAccountMonitor(fakeOpenEmu(['Account {name=work@example.com, type=com.example.work}']));
  const state = await monitor.refresh(null);

  assert.equal(state.state, 'signed-out');
  assert.deepEqual(state.accounts, []);
});

test('a guest that is not answering is distinguished from one that is signed out', async () => {
  const monitor = new GuestAccountMonitor(fakeOpenEmu([], { code: 1 }));
  assert.equal((await monitor.refresh(null)).state, 'guest-unavailable');
});

test('a thrown bridge error is reported as unavailable, not as signed out', async () => {
  const logs = [];
  const monitor = new GuestAccountMonitor(
    {
      async shell() {
        throw new Error('bridge exploded');
      },
    },
    { onLog: (line) => logs.push(line) },
  );

  assert.equal((await monitor.refresh(null)).state, 'guest-unavailable');
  assert.ok(logs.some((line) => line.includes('bridge exploded')));
});

test('the result is cached, and force re-asks', async () => {
  let now = 5_000;
  const openEmu = fakeOpenEmu(DUMP.split('\n'));
  const monitor = new GuestAccountMonitor(openEmu, { now: () => now });

  await monitor.refresh(null);
  await monitor.refresh(null);
  assert.equal(openEmu.calls.length, 1);

  await monitor.refresh(null, true);
  assert.equal(openEmu.calls.length, 2);

  now += 31_000;
  await monitor.refresh(null);
  assert.equal(openEmu.calls.length, 3);
});

test('current() is a copy, so a caller cannot mutate monitor state', async () => {
  const monitor = new GuestAccountMonitor(fakeOpenEmu(DUMP.split('\n')));
  await monitor.refresh(null);

  const snapshot = monitor.current();
  snapshot.accounts.push({ name: 'injected@example.com', type: GOOGLE_ACCOUNT_TYPE });

  assert.equal(monitor.current().accounts.length, 1);
});
