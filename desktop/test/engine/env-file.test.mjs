import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDist, REPO_ROOT } from '../helpers.mjs';

const { parseEnvFile, isSafeConfigName, loadProfile, loadDevice } = loadDist('engine/env-file.js');

// The real files, not fixtures. These are the definitions the product ships, so a change to them
// that this parser cannot read should fail here rather than at runtime on someone's machine.
const ANDROID_ROOT = path.join(REPO_ROOT, 'android');

test('comments, blanks, and bare values', () => {
  const env = parseEnvFile(['# a comment', '', 'A=1', '  B=two  ', '# another'].join('\n'));

  assert.deepEqual(env, { A: '1', B: 'two' });
});

test('quotes are stripped, and a value keeps what is inside them', () => {
  const env = parseEnvFile('A="a value"\nB=\'single\'\nC="with # hash"');

  assert.equal(env.A, 'a value');
  assert.equal(env.B, 'single');
  assert.equal(env.C, 'with # hash', 'a hash inside quotes is content, not a comment');
});

test('a trailing comment is stripped only from an unquoted value', () => {
  const env = parseEnvFile('A=plain # trailing\nB="quoted # kept"');

  assert.equal(env.A, 'plain');
  assert.equal(env.B, 'quoted # kept');
});

test('an empty value is kept, because empty means "no override"', () => {
  assert.equal(parseEnvFile('DEVICE_BRAND=').DEVICE_BRAND, '');
});

test('nothing is expanded — this is data, not a shell', () => {
  const env = parseEnvFile('A=$HOME\nB=`whoami`\nC=$(id -u)');

  assert.equal(env.A, '$HOME');
  assert.equal(env.B, '`whoami`');
  assert.equal(env.C, '$(id -u)');
});

test('a line that is not an assignment is skipped rather than guessed at', () => {
  const env = parseEnvFile('export A=1\nnot a line\n=novalue\nB=2');

  assert.equal(env.B, '2');
  assert.equal(env.A, undefined, '`export A=1` is a shell statement, not data');
  assert.equal(Object.keys(env).length, 1);
});

test('config names are matched, not trusted — they become a filesystem path', () => {
  assert.ok(isSafeConfigName('play'));
  assert.ok(isSafeConfigName('pixel_5'));
  assert.ok(!isSafeConfigName('../../etc/passwd'));
  assert.ok(!isSafeConfigName('a/b'));
  assert.ok(!isSafeConfigName(''));
  assert.ok(!isSafeConfigName('Play'), 'uppercase is not a filename this project uses');
});

test('every shipped profile loads, and play is the only one with the Play Store', () => {
  for (const name of ['openemu', 'fast', 'full', 'play']) {
    const profile = loadProfile(ANDROID_ROOT, name);
    assert.ok(profile.systemImage.startsWith('system-images;android-30;'), name);
    assert.ok(profile.imageTag.length > 0, name);
    assert.ok(profile.avdName.length > 0, name);
  }

  assert.equal(loadProfile(ANDROID_ROOT, 'play').playStore, true);
  assert.equal(loadProfile(ANDROID_ROOT, 'fast').playStore, false);
  assert.equal(loadProfile(ANDROID_ROOT, 'full').playStore, false);
  assert.equal(loadProfile(ANDROID_ROOT, 'openemu').playStore, false);
});

test('openemu is derived from the AOSP image, not downloaded from Google', () => {
  const profile = loadProfile(ANDROID_ROOT, 'openemu');
  assert.equal(profile.imageTag, 'openemu');
  assert.equal(profile.baseImageTag, 'default');
  assert.equal(loadProfile(ANDROID_ROOT, 'fast').baseImageTag, null);
});

test('each profile gets its own AVD, or one snapshot would load against another image', () => {
  const names = ['openemu', 'fast', 'full', 'play'].map((n) => loadProfile(ANDROID_ROOT, n).avdName);

  assert.equal(new Set(names).size, names.length, `AVD names collide: ${names.join(', ')}`);
});

test('an unknown profile is refused rather than silently defaulted', () => {
  assert.throws(() => loadProfile(ANDROID_ROOT, 'nope'), /unknown profile/);
  assert.throws(() => loadProfile(ANDROID_ROOT, '../../evil'), /unsafe profile name/);
});

test('the generic device contributes no property overrides at all', () => {
  const device = loadDevice(ANDROID_ROOT, 'generic');

  assert.deepEqual(device.props, {}, 'an empty field means no opinion, not an empty brand');
  assert.equal(device.lcdWidth, 720);
});

test('a real handset sets the identity apps check', () => {
  const pixel = loadDevice(ANDROID_ROOT, 'pixel_5');

  assert.equal(pixel.props['ro.product.manufacturer'], 'Google');
  assert.equal(pixel.props['ro.product.model'], 'Pixel 5');
  assert.match(pixel.props['ro.build.fingerprint'], /^google\/redfin\/redfin:11\//);
  assert.equal(pixel.lcdWidth, 1080);
  assert.equal(pixel.lcdHeight, 2340);
  assert.equal(pixel.lcdDensity, 440);
});
