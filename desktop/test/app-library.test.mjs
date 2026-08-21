import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { AppLibrary, isValidPackageName, prettyLabel } = loadDist('app-library.js');

/** Stands in for OpenEmuClient, recording the commands it was asked to run. */
function fakeClient(stdout = [], code = 0) {
  const commands = [];
  return {
    commands,
    async shell(command) {
      commands.push(command);
      return { code, signal: null, stdout, stderr: [] };
    },
  };
}

test('package names are allowlisted, not escaped', () => {
  assert.equal(isValidPackageName('com.example.game'), true);
  assert.equal(isValidPackageName('com.example_2.game3'), true);
  assert.equal(isValidPackageName('a'), true);

  // These strings would cross into WSL and then into adb shell. An allowlist is the only defence
  // that survives three layers of quoting.
  for (const bad of [
    'com.example; rm -rf /',
    'com.example && whoami',
    'com.example`id`',
    'com.example$(id)',
    "com.example'",
    'com.example|cat',
    '../../etc/passwd',
    '',
    '1starts.with.digit',
    'com.example game',
  ]) {
    assert.equal(isValidPackageName(bad), false, `accepted: ${bad}`);
  }
});

test('labels are derived from the last package segment', () => {
  assert.equal(prettyLabel('com.king.candycrushsaga'), 'Candycrushsaga');
  assert.equal(prettyLabel('com.example.my_app'), 'My app');
  assert.equal(prettyLabel('standalone'), 'Standalone');
});

test('the installed list is parsed, filtered and sorted', async () => {
  const client = fakeClient([
    'package:com.example.zeta',
    'package:com.example.alpha',
    'garbage line',
    'package:not a package name',
    '',
  ]);
  const apps = await new AppLibrary(client).list();

  assert.deepEqual(apps.map((a) => a.packageName), ['com.example.alpha', 'com.example.zeta']);
  assert.equal(apps[0].label, 'Alpha');
  assert.deepEqual(client.commands, ['pm list packages -3']);
});

test('launching refuses an invalid package without touching the shell', async () => {
  const client = fakeClient();
  const library = new AppLibrary(client);

  assert.equal(await library.launch('com.example; rm -rf /'), false);
  assert.deepEqual(client.commands, [], 'nothing may reach the shell');

  assert.equal(await library.launch('com.example.game'), true);
  assert.deepEqual(client.commands, ['monkey -p com.example.game -c android.intent.category.LAUNCHER 1']);
});

test('a non-zero exit is reported as a failed launch', async () => {
  const library = new AppLibrary(fakeClient([], 1));
  assert.equal(await library.launch('com.example.game'), false);
});
