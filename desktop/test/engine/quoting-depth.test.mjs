import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { WslEngine } = loadDist('engine/wsl-engine.js');
const { SdkEngine } = loadDist('engine/sdk/sdk-engine.js');
const { createSdkLayout } = loadDist('engine/sdk/layout.js');
const { posixQuote, guestShellArg } = loadDist('platform/shell-quote.js');
const { textCommand } = loadDist('guest/input.js');

const wsl = () => new WslEngine({ async runOpenEmu() {}, async runOpenEmuWithEnv() {} }, { profile: null });
const sdk = () =>
  new SdkEngine({
    layout: createSdkLayout('C:\\nowhere'),
    androidRoot: 'C:\\nowhere',
    profile: 'fast',
    accelerated: () => false,
    windowed: false,
    onLog: () => undefined,
  });

/**
 * What a POSIX shell does to one single-quoted argument: strip the outer quotes and turn each
 * `'\''` escape back into a quote. One call models one shell.
 */
const SQ = String.fromCharCode(39); // '
const ESCAPED_SQ = SQ + String.fromCharCode(92) + SQ + SQ; // '\''

function unwrapOnce(value) {
  const inner = value.startsWith(SQ) && value.endsWith(SQ) ? value.slice(1, -1) : value;
  return inner.split(ESCAPED_SQ).join(SQ);
}

/**
 * How many times a value must be quoted depends on how many shells lie between this process and
 * the guest, and the two runtimes differ. Getting it wrong is silent: the native engine typed
 * `'P@ss w0rd!'` — quotes included — into a Google sign-in form, and the login simply failed.
 */

test('WSL quotes twice, because bash parses the command before the guest does', () => {
  // wsl.exe -e bash -lc "<command>" -> bash splits it -> adb shell -> the guest's sh.
  assert.equal(wsl().quoteGuestArg('hello world'), guestShellArg('hello world'));
  assert.equal(unwrapOnce(unwrapOnce(wsl().quoteGuestArg('hello world'))), 'hello world');
});

test('native quotes once, because adb takes argv directly', () => {
  assert.equal(sdk().quoteGuestArg('hello world'), posixQuote('hello world'));
  assert.equal(unwrapOnce(sdk().quoteGuestArg('hello world')), 'hello world');
});

test('one shell is exactly enough for native, and not enough for WSL', () => {
  // This asymmetry is the bug in one assertion: the same double-quoted value that survives two
  // shells arrives with its outer quotes intact when only one shell unwraps it.
  assert.equal(unwrapOnce(sdk().quoteGuestArg('hello world')), 'hello world');
  assert.notEqual(unwrapOnce(wsl().quoteGuestArg('hello world')), 'hello world');
});

test('metacharacters survive the native quoting as literal text', () => {
  // $ and backtick would be expanded, | & ; would split the command.
  const cases = ['a$b' + String.fromCharCode(96) + 'c', 'pipe|amp&', 'semi;colon', "it's", 'P@ss w0rd!', 'plain'];
  for (const value of cases) {
    assert.equal(unwrapOnce(sdk().quoteGuestArg(value)), value, `mangled: ${value}`);
  }
});

test('textCommand asks the caller how to quote rather than assuming a depth', () => {
  // Hardcoding the two-shell form for every runtime is what caused the bug.
  assert.equal(textCommand('hi', (v) => `<${v}>`), 'input text <hi>');
  assert.equal(textCommand('hi', (v) => sdk().quoteGuestArg(v)), `input text ${posixQuote('hi')}`);
  assert.equal(textCommand('', () => 'x'), null, 'unsendable text is still refused');
});
