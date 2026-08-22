import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { posixQuote, guestShellArg } = loadDist('shell-quote.js');

/**
 * Stands in for a POSIX shell's quote removal.
 *
 * The value crosses two of them — `bash -lc` inside WSL, then the guest's `sh` after adb re-joins
 * its argv — so the real test is that unquoting twice returns exactly what went in. Anything less
 * means a metacharacter survived into a shell that would act on it.
 */
function unquotePosix(input) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (c === "'") {
      inQuote = !inQuote;
      continue;
    }
    if (c === '\\' && !inQuote) {
      out += input[i + 1] ?? '';
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

const HOSTILE = [
  'simple',
  'with spaces',
  "it's",
  "''",
  'pa$$w0rd',
  'sub$(id)',
  'back`tick`',
  'quote"dq',
  'semi; echo pwned',
  'pipe | cat',
  'amp && echo',
  'redirect > /tmp/x',
  'newline-free\ttab',
  "everything'\"$`;|&><",
];

test('single-quoting survives one shell', () => {
  for (const value of HOSTILE) {
    assert.equal(unquotePosix(posixQuote(value)), value, `failed for ${JSON.stringify(value)}`);
  }
});

test('guest args survive both shells intact', () => {
  for (const value of HOSTILE) {
    const arg = guestShellArg(value);
    const afterBash = unquotePosix(arg);
    const afterGuestSh = unquotePosix(afterBash);
    assert.equal(afterGuestSh, value, `failed for ${JSON.stringify(value)}`);
  }
});

test('after the first shell strips its layer, the value is still quoted for the second', () => {
  // This is the whole reason guestShellArg exists. Quoting once means bash consumes the quotes and
  // the guest's sh receives `sub$(id)` bare — where it would run `id`. Quoting twice means what
  // survives bash is still a quoted token, so the guest's sh strips quotes instead of expanding.
  for (const value of ['sub$(id)', 'back`tick`', "it's", 'semi; echo pwned']) {
    assert.equal(unquotePosix(posixQuote(value)), value, 'one layer leaves the value bare');

    const afterBash = unquotePosix(guestShellArg(value));
    assert.ok(
      afterBash.startsWith("'") && afterBash.endsWith("'"),
      `two layers must leave a quoted token, got ${afterBash}`,
    );
    assert.equal(unquotePosix(afterBash), value, 'and the guest shell recovers the original');
  }
});

test('the empty string quotes to something a shell still parses as one empty argument', () => {
  assert.equal(posixQuote(''), "''");
  assert.equal(unquotePosix(unquotePosix(guestShellArg(''))), '');
});
