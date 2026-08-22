import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { REQUIRED_TOOLS, missingPackages, profileEnv } = loadDist('setup-wizard.js');

test('the selected profile is forwarded to raw bridge commands', () => {
  // `bridge.run` does not inject ANDROID_PROFILE the way `runOpenEmu` does. Without this, the SDK
  // step would check and download the *default* guest's image no matter which one the user chose.
  assert.equal(profileEnv({ profile: 'play' }), 'ANDROID_PROFILE=play');
  assert.equal(profileEnv({ profile: null }), '', 'no profile pinned means open-emu picks its own');
});

test('a profile name is never interpolated into a shell command unchecked', () => {
  for (const hostile of ['play; rm -rf /tmp/x', 'play && id', '$(id)', '../../etc', 'PLAY', 'a'.repeat(40)]) {
    assert.equal(profileEnv({ profile: hostile }), '', `accepted profile name: ${hostile}`);
  }
});

/** Stands in for WslBridge: echoes back the names of whichever tools we say are absent. */
function stubBridge(absent) {
  const calls = [];
  return {
    calls,
    async run(command) {
      calls.push(command);
      return { code: 0, signal: null, stdout: [...absent], stderr: [] };
    },
  };
}

test('a distro with everything installed needs no packages', async () => {
  assert.deepEqual(await missingPackages(stubBridge([])), []);
});

test('a fresh Ubuntu is missing exactly the packages that break the SDK download', async () => {
  // `wsl --install` ships curl and python3 but no JDK, unzip, or make — and sdkmanager is a Java
  // program, so without this step the download fails minutes in with a missing-JVM error.
  const missing = await missingPackages(stubBridge(['java', 'unzip', 'make']));
  assert.deepEqual(missing, ['openjdk-17-jdk-headless', 'unzip', 'make']);
});

test('tools are probed in one round trip, not one per tool', async () => {
  const bridge = stubBridge([]);
  await missingPackages(bridge);
  assert.equal(bridge.calls.length, 1);
  for (const { command } of REQUIRED_TOOLS) {
    assert.ok(bridge.calls[0].includes(`command -v ${command}`), `${command} not probed`);
  }
});

test('unrelated output does not invent a missing package', async () => {
  assert.deepEqual(await missingPackages(stubBridge(['', 'some unrelated line', 'JAVA'])), []);
});

test('every required tool maps to a real package name', () => {
  for (const { command, pkg } of REQUIRED_TOOLS) {
    assert.match(command, /^[a-z0-9]+$/, `odd command: ${command}`);
    assert.match(pkg, /^[a-z0-9.+-]+$/, `odd package: ${pkg}`);
  }
});
