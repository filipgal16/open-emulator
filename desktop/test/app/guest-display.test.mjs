import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const {
  applyCommands,
  parsePhysicalDensity,
  parsePhysicalSize,
  resetCommands,
  resolveDisplayGeometry,
  worthApplying,
} = loadDist('guest/display.js');

/** A Pixel-ish panel: 1080x1920 at 440dpi, so smallest-width is ~392.7dp. */
const BASE = { width: 1080, height: 1920, density: 440 };

const swDp = (g) => (Math.min(g.width, g.height) * 160) / g.density;

// ── The invariant that keeps app layouts stable ────────────────────────────────────────────────

test('smallest-width in dp survives any plausible window shape', () => {
  // This is the whole point of recomputing density. If sw drifts, Android moves the app between
  // its phone and tablet layout buckets mid-drag, which reads as a rendering bug.
  const target = swDp(BASE);

  for (const viewport of [
    { width: 1600, height: 900 },
    { width: 900, height: 1600 },
    { width: 1280, height: 720 },
    { width: 800, height: 800 },
    { width: 2000, height: 1200 },
  ]) {
    const got = resolveDisplayGeometry({ viewport, base: BASE });
    assert.ok(
      Math.abs(swDp(got) - target) < 2,
      `${viewport.width}x${viewport.height} gave sw=${swDp(got).toFixed(1)}dp, wanted ~${target.toFixed(1)}dp`,
    );
  }
});

test('a wide window really does produce a landscape display, not a padded portrait one', () => {
  const got = resolveDisplayGeometry({ viewport: { width: 1600, height: 900 }, base: BASE });

  assert.equal(got.width, 1600);
  assert.equal(got.height, 900);
  assert.ok(got.width > got.height, 'the guest is asked for a landscape geometry');
});

test('density moves with the window rather than staying at the panel value', () => {
  // Keeping 440dpi on a 900px-tall window would hand Android a 218dp-tall display, which is
  // shorter than most apps' declared minimum.
  const got = resolveDisplayGeometry({ viewport: { width: 1600, height: 900 }, base: BASE });

  assert.notEqual(got.density, BASE.density);
  assert.equal(got.density, 367);
});

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

test('an absurdly wide window letterboxes instead of breaking app layouts', () => {
  const got = resolveDisplayGeometry({ viewport: { width: 3000, height: 500 }, base: BASE });

  assert.ok(got.width / got.height <= 2.4 + 0.01, `aspect ${got.width}/${got.height} exceeds the cap`);
  assert.equal(got.height, 500, 'the short edge is kept; the long one is trimmed');
});

test('a very tall window is capped the same way', () => {
  const got = resolveDisplayGeometry({ viewport: { width: 500, height: 3000 }, base: BASE });

  assert.ok(got.height / got.width <= 2.4 + 0.01);
});

test('a window dragged tiny does not ask for a display Android cannot lay out', () => {
  const got = resolveDisplayGeometry({ viewport: { width: 100, height: 80 }, base: BASE });

  assert.ok(got.width >= 360 && got.height >= 360);
});

test('a 4K window is capped, because the guest renders every pixel for real', () => {
  const got = resolveDisplayGeometry({ viewport: { width: 4000, height: 3000 }, base: BASE });

  assert.ok(got.width <= 2560 && got.height <= 2560);
  assert.ok(got.density <= 640, 'density stays inside the range Android defines buckets for');
});

test('both edges come out even', () => {
  // Odd dimensions are rejected by some encoders and silently rounded by others, and then the
  // mirror is decoding a different size than it thinks.
  const got = resolveDisplayGeometry({ viewport: { width: 901, height: 1601 }, base: BASE });

  assert.equal(got.width % 2, 0);
  assert.equal(got.height % 2, 0);
});

// ── Reading the guest's own numbers back ───────────────────────────────────────────────────────

test('the physical size is read, never the override', () => {
  // Treating the override as the base would compound each resize on the last, and the display
  // would shrink a little with every drag.
  const stdout = 'Physical size: 1080x1920\nOverride size: 1600x900\n';

  assert.deepEqual(parsePhysicalSize(stdout), { width: 1080, height: 1920 });
});

test('the physical density is read, never the override', () => {
  const stdout = 'Physical density: 440\nOverride density: 367\n';

  assert.equal(parsePhysicalDensity(stdout), 440);
});

test('an unparseable answer is null rather than a guess', () => {
  assert.equal(parsePhysicalSize('error: no devices/emulators found'), null);
  assert.equal(parsePhysicalDensity(''), null);
  assert.equal(parsePhysicalSize('Physical size: 0x0'), null);
});

// ── Commands ───────────────────────────────────────────────────────────────────────────────────

test('size is applied before density, so both land in one settling period', () => {
  const commands = applyCommands({ width: 1600, height: 900, density: 367 });

  assert.deepEqual(commands, ['wm size 1600x900', 'wm density 367']);
});

test('reset hands the display back to the panel', () => {
  assert.deepEqual(resetCommands(), ['wm size reset', 'wm density reset']);
});

test('a no-op drag costs no reconfiguration', () => {
  const g = { width: 1600, height: 900, density: 367 };

  assert.equal(worthApplying(g, { ...g }), false);
  assert.equal(worthApplying(null, g), true, 'nothing applied yet is always worth applying');
});

test('a few pixels of wobble is ignored; a real resize is not', () => {
  // A scrollbar appearing, or an in-flow panel nudging the layout, would otherwise reconfigure the
  // display and re-lay out every visible activity for a change nobody can see.
  const g = { width: 1600, height: 900, density: 367 };

  assert.equal(worthApplying(g, { ...g, width: 1604 }), false, '4px is noise');
  assert.equal(worthApplying(g, { ...g, height: 892 }), false, '8px is noise');
  assert.equal(worthApplying(g, { ...g, width: 1560 }), true, '40px is a resize');
  assert.equal(worthApplying(g, { ...g, height: 700 }), true);
});
