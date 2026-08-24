import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { GuestFactsProbe, looksSpoofed, UNKNOWN_FACTS } = loadDist('store/guest-facts.js');

const STOCK_FP = 'google/sdk_gphone_x86_64/generic_x86_64:11/RSR1.201013.001/6903271:userdebug/dev-keys';
const SPOOFED_FP = 'google/redfin/redfin:11/RQ3A.211001.001/7641976:user/release-keys';

function fakeOpenEmu(lines, { code = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async shell(command) {
      calls.push(command);
      return { code, signal: null, stdout: lines, stderr: [] };
    },
  };
}

const answer = ({ sdk = '30', fp = STOCK_FP, avd = 'OpenEmulator_API30_fast', play = '1' } = {}) => [
  `OE_SDK=${sdk}`,
  `OE_FP=${fp}`,
  `OE_AVD=${avd}`,
  `OE_PLAY=${play}`,
];

test('a stock emulator fingerprint is not treated as spoofed', () => {
  assert.equal(looksSpoofed(STOCK_FP), false);
  assert.equal(looksSpoofed('Android/sdk_phone_x86/generic:11/x/y:user/release-keys'), false);
  assert.equal(looksSpoofed(null), false, 'not knowing is not the same as spoofed');
});

test('a retail device fingerprint on an emulator means customize_device.sh has been here', () => {
  assert.equal(looksSpoofed(SPOOFED_FP), true);
});

test('all four facts come back from one shell round trip', async () => {
  const openEmu = fakeOpenEmu(answer());
  const probe = new GuestFactsProbe(openEmu);

  const facts = await probe.probe();

  assert.equal(openEmu.calls.length, 1, 'one call, not four');
  assert.equal(facts.sdk, 30);
  assert.equal(facts.playAvailable, true);
  assert.equal(facts.avdName, 'OpenEmulator_API30_fast');
  assert.equal(facts.identitySpoofed, false);
});

test('an absent Play package is reported as absent', async () => {
  const probe = new GuestFactsProbe(fakeOpenEmu(answer({ play: '0' })));
  assert.equal((await probe.probe()).playAvailable, false);
});

test('answers are labelled, so an empty property cannot shift the others', async () => {
  // `getprop` prints a blank line for an unset property. A positional parse would read the AVD
  // name as the fingerprint here; the labels are what stop that.
  const probe = new GuestFactsProbe(fakeOpenEmu(['OE_SDK=30', 'OE_FP=', 'OE_AVD=my_avd', 'OE_PLAY=1']));

  const facts = await probe.probe();
  assert.equal(facts.sdk, 30);
  assert.equal(facts.fingerprint, null);
  assert.equal(facts.avdName, 'my_avd');
});

test('a guest that is not running yields unknown facts rather than wrong ones', async () => {
  const probe = new GuestFactsProbe(fakeOpenEmu([], { code: 1 }));
  assert.deepEqual(await probe.probe(), UNKNOWN_FACTS);
});

test('a thrown bridge error is caught and logged', async () => {
  const logs = [];
  const probe = new GuestFactsProbe(
    {
      async shell() {
        throw new Error('wsl is not running');
      },
    },
    { onLog: (line) => logs.push(line) },
  );

  assert.deepEqual(await probe.probe(), UNKNOWN_FACTS);
  assert.ok(logs.some((line) => line.includes('wsl is not running')));
});

test('facts are cached, because each probe costs an adb round trip', async () => {
  let now = 1_000;
  const openEmu = fakeOpenEmu(answer());
  const probe = new GuestFactsProbe(openEmu, { now: () => now });

  await probe.probe();
  await probe.probe();
  assert.equal(openEmu.calls.length, 1, 'the second call was served from cache');

  await probe.probe(true);
  assert.equal(openEmu.calls.length, 2, 'force bypasses the cache');

  now += 61_000;
  await probe.probe();
  assert.equal(openEmu.calls.length, 3, 'the TTL expired');
});

test('current() reports the last answer without touching the guest', async () => {
  const openEmu = fakeOpenEmu(answer());
  const probe = new GuestFactsProbe(openEmu);

  assert.deepEqual(probe.current(), UNKNOWN_FACTS);
  await probe.probe();
  assert.equal(probe.current().sdk, 30);
  assert.equal(openEmu.calls.length, 1);
});

test('concurrent probes share one round trip', async () => {
  const openEmu = fakeOpenEmu(answer());
  const probe = new GuestFactsProbe(openEmu);

  const [a, b, c] = await Promise.all([probe.probe(), probe.probe(), probe.probe()]);

  assert.equal(openEmu.calls.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});
