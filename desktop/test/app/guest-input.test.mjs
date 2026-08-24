import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { clampCoord, isSafeKeycode, isTypeableText, keyCommand, swipeCommand, tapCommand, textCommand } =
  loadDist('guest/input.js');

test('coordinates are clamped, never passed through raw', () => {
  assert.equal(clampCoord(120.4), 120);
  assert.equal(clampCoord(-5), 0, 'negatives clamp to the panel edge');
  assert.equal(clampCoord(1e9), 20_000, 'absurd values clamp to the ceiling');
  // Non-finite input is garbage rather than a big number, so it lands at the origin like NaN
  // instead of being clamped to the far corner of the panel.
  assert.equal(clampCoord(Number.NaN), 0);
  assert.equal(clampCoord(Number.POSITIVE_INFINITY), 0);
});

test('tap and swipe emit only numbers, so nothing can be smuggled through coordinates', () => {
  assert.equal(tapCommand(10.6, 20.2), 'input tap 11 20');
  assert.match(swipeCommand(1, 2, 3, 4, 250), /^input swipe \d+ \d+ \d+ \d+ \d+$/);
});

test('swipe duration is bounded, since Android reads gesture velocity from it', () => {
  assert.equal(swipeCommand(0, 0, 0, 0, 0), 'input swipe 0 0 0 0 1');
  assert.equal(swipeCommand(0, 0, 0, 0, 999_999), 'input swipe 0 0 0 0 10000');
  assert.equal(swipeCommand(0, 0, 0, 0, Number.NaN), 'input swipe 0 0 0 0 200');
});

test('only real keycodes reach the guest', () => {
  assert.ok(isSafeKeycode('KEYCODE_BACK'));
  assert.ok(isSafeKeycode('4'), 'numeric codes are legitimate');
  assert.equal(keyCommand('KEYCODE_HOME'), 'input keyevent KEYCODE_HOME');

  for (const hostile of ['KEYCODE_BACK; id', 'KEYCODE_BACK && id', '$(id)', 'keycode_back', '', 'KEYCODE-BACK']) {
    assert.equal(isSafeKeycode(hostile), false, `accepted keycode: ${hostile}`);
    assert.equal(keyCommand(hostile), null, `built a command for: ${hostile}`);
  }
});

test('text is quoted rather than %s-escaped, so a literal %s is not corrupted', () => {
  const command = textCommand('100%s off');
  assert.ok(command.startsWith('input text '));
  assert.ok(command.includes('100%s off'), 'the literal text is preserved inside the quoting');
});

test('input text refuses what Android cannot actually type', () => {
  assert.equal(isTypeableText(''), false);
  assert.equal(isTypeableText('café'), false, 'non-ASCII arrives mangled');
  assert.equal(isTypeableText('line\nbreak'), false);
  assert.equal(isTypeableText('x'.repeat(1025)), false);
  assert.equal(textCommand('café'), null);

  assert.ok(isTypeableText('ASCII is fine ~!@#$%^&*()'));
});
