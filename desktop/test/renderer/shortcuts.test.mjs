import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_ROOT } from '../helpers.mjs';
import { fileURLToPath } from 'node:url';

const RENDERER = path.join(DESKTOP_ROOT, 'src', 'renderer');
const read = (file) => readFileSync(path.join(RENDERER, file), 'utf8');

/**
 * Renderer modules are bundled by esbuild rather than compiled into `dist/main`, so they cannot be
 * required the way the main-process tests load their subjects. These read the source as text — the
 * same approach the contrast test takes against the stylesheet — which is enough to hold the rules
 * that matter here.
 */

test('every workspace shortcut is documented', () => {
  // An undocumented shortcut is not a feature: nobody discovers Alt+3 by accident, and one that
  // exists without being listed is indistinguishable from a bug when it fires unexpectedly.
  const source = read('keyboard.ts');
  const digits = [...source.matchAll(/digit:\s*'(\d)'/g)].map((m) => m[1]);
  const help = source.slice(source.indexOf('SHORTCUT_HELP'));

  assert.ok(digits.length >= 3, `expected workspace shortcuts, found ${digits.length}`);
  for (const digit of digits) {
    // A plain substring rather than a regex: `+` is a quantifier, and escaping it correctly
    // through every layer here is a good way to write a test that passes for the wrong reason.
    assert.ok(help.includes(`Alt+${digit}`), `Alt+${digit} is bound but not documented`);
  }
});

test('the shortcut help is actually rendered somewhere', () => {
  // Documented in a constant nobody displays would be no better than undocumented.
  assert.match(read('components/Settings/SettingsView.tsx'), /SHORTCUT_HELP/);
});

test('shortcuts do not fire while the user is typing', () => {
  const source = read('keyboard.ts');

  // Without this, Alt+S in the store's search box stops the device instead of typing an S — and
  // a plain-text guard would miss contenteditable and textarea.
  assert.match(source, /isContentEditable/);
  assert.match(source, /TEXTAREA/);
  assert.match(source, /INPUT/);
});

test('icon-only controls carry accessible names', () => {
  // The tool rail is the Android navigation; every button in it is a bare glyph, so without a
  // label a screen reader announces nothing usable.
  for (const file of ['components/ToolRail.tsx', 'components/NavRail.tsx']) {
    assert.match(read(file), /aria-label/, `${file} has icon-only buttons without accessible names`);
  }
});

test('the rails are announced as what they are', () => {
  assert.match(read('components/ToolRail.tsx'), /role="toolbar"/);
  assert.match(read('components/NavRail.tsx'), /<nav[^>]*aria-label/);
});

test('device state changes are announced, not only shown', () => {
  // The guest goes checking -> starting -> booting -> running without the user acting, so a
  // sighted user sees progress and a screen-reader user would otherwise get silence.
  assert.match(read('components/DeviceBar.tsx'), /aria-live/);
});
