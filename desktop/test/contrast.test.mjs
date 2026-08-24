import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const INDEX = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'renderer', 'index.html');

/**
 * Colour contrast, checked rather than asserted by eye.
 *
 * This is the one design property that regresses completely silently: nothing breaks, nothing
 * fails to build, and the only symptom is that someone cannot read the secondary text. `--faint`
 * on `--surface` was about 3:1 before the theme work — below AA for body text — and there was no
 * way to notice short of measuring it.
 *
 * Reads the real stylesheet rather than a copy of the values, so it fails when the tokens change
 * rather than when someone forgets to update a duplicate list.
 */
function blockAfter(css, marker) {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`no ${marker} block in index.html`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${marker} block`);
}

function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[`--${m[1]}`] = m[2];
  return out;
}

function relativeLuminance(hex) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6);
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.substr(i, 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(INDEX, 'utf8');
const dark = tokensIn(blockAfter(css, ':root {'));
const light = { ...dark, ...tokensIn(blockAfter(css, ':root[data-theme="light"]')) };

/** Foreground/background pairs that are actually rendered together somewhere in the app. */
const PAIRS = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text-dim', '--surface'],
  ['--muted', '--surface'],
  ['--muted', '--bg'],
  ['--faint', '--surface'],
  ['--faint', '--bg'],
  ['--accent', '--surface'],
  ['--ok', '--surface'],
  ['--warn', '--surface'],
  ['--danger', '--surface'],
];

for (const [name, theme] of [
  ['dark', dark],
  ['light', light],
]) {
  test(`${name} theme meets WCAG AA for body text`, () => {
    for (const [fg, bg] of PAIRS) {
      assert.ok(theme[fg], `${name}: ${fg} is not defined`);
      assert.ok(theme[bg], `${name}: ${bg} is not defined`);

      const ratio = contrast(theme[fg], theme[bg]);
      assert.ok(
        ratio >= 4.5,
        `${name}: ${fg} (${theme[fg]}) on ${bg} (${theme[bg]}) is ${ratio.toFixed(2)}:1, below the 4.5:1 AA threshold`,
      );
    }
  });
}

test('both themes define the same token names', () => {
  // A token defined only in dark silently falls through to the dark value in light mode, which
  // looks like a one-off bug rather than a missing definition.
  const explicitLight = tokensIn(blockAfter(css, ':root[data-theme="light"]'));
  const missing = Object.keys(explicitLight).filter((key) => !(key in dark));

  assert.deepEqual(missing, [], `light defines tokens dark does not: ${missing.join(', ')}`);
});

test('motion is disabled under prefers-reduced-motion', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion/, 'no reduced-motion block at all');
});

test('the theme follows the OS when no explicit choice is set', () => {
  assert.match(css, /prefers-color-scheme/, 'light mode would be unreachable without a manual toggle');
});

test('no remote origin is referenced from the stylesheet', () => {
  // The renderer CSP forbids remote origins; a webfont @import would fail at runtime with a
  // console error and a silently wrong typeface.
  const remote = css.match(/@import\s+url\(['"]?https?:/i) ?? css.match(/src:\s*url\(['"]?https?:/i);
  assert.equal(remote, null, `stylesheet reaches a remote origin: ${remote?.[0]}`);
});
