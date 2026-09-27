import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_ROOT, loadDist } from '../helpers.mjs';

const { rewriteIdentity, upsertProps, parseProps, checkIdentity, checkProp } = loadDist('rom/build-prop.js');

/** The stock `build.prop`s from Google's `default` API 30 image, byte-exact. */
const stock = (volume) =>
  readFileSync(path.join(DESKTOP_ROOT, 'test', 'fixtures', 'rom', `build.prop.${volume}`), 'utf8');

const IDENTITY = {
  brand: 'open-emulator',
  manufacturer: 'open-emulator',
  model: 'OpenEmulator One',
  name: 'openemu_x86_64',
  device: 'openemu',
  displayId: 'open-emulator Android 11 (openemu 1)',
  description: 'openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys',
  buildProduct: 'openemu',
};

const TAIL = ':11/RSR1.210722.013.A2/10067904:userdebug/test-keys';
const FINGERPRINT = `open-emulator/openemu_x86_64/openemu${TAIL}`;

const productKeys = (p) => ({
  [`ro.product.${p}.brand`]: 'open-emulator',
  [`ro.product.${p}.device`]: 'openemu',
  [`ro.product.${p}.manufacturer`]: 'open-emulator',
  [`ro.product.${p}.model`]: 'OpenEmulator One',
  [`ro.product.${p}.name`]: 'openemu_x86_64',
});

/**
 * Every identity key each stock file has, in file order, with what it must read after the
 * rewrite. Written out rather than derived from the module's own patterns, so a pattern that
 * misses a key — or grabs one too many — fails here.
 */
const EXPECTED = {
  system: {
    'ro.system.build.fingerprint': FINGERPRINT,
    ...productKeys('system'),
    'ro.build.display.id': 'open-emulator Android 11 (openemu 1)',
    'ro.build.flavor': 'openemu_x86_64-userdebug',
    'ro.build.product': 'openemu',
    'ro.build.description': 'openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys',
  },
  system_ext: {
    'ro.system_ext.build.fingerprint': FINGERPRINT,
    ...productKeys('system_ext'),
  },
  product: {
    'ro.product.build.fingerprint': FINGERPRINT,
    ...productKeys('product'),
  },
  vendor: {
    'ro.vendor.build.fingerprint': FINGERPRINT,
    ...productKeys('vendor'),
    'ro.bootimage.build.fingerprint': FINGERPRINT,
  },
};

/** Keys that share a prefix with identity keys and must come through untouched. */
const LOOKALIKES = [
  'ro.product.cpu.abilist',
  'ro.product.build.date',
  'ro.product.board',
  'ro.product.vndk.version',
  'ro.setupwizard.mode',
];

const keyOf = (line) => /^([^#=][^=]*)=/.exec(line)?.[1] ?? null;

for (const volume of Object.keys(EXPECTED)) {
  test(`${volume} build.prop: every identity key it has is rewritten, and nothing else`, () => {
    const before = stock(volume);
    const { text: after, changed } = rewriteIdentity(before, IDENTITY);
    const expected = EXPECTED[volume];

    assert.deepEqual(changed, Object.keys(expected), 'changed lists exactly the identity keys, in file order');

    const props = parseProps(after);
    for (const [key, value] of Object.entries(expected)) assert.equal(props.get(key), value, key);

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    assert.equal(afterLines.length, beforeLines.length, 'no line added or removed');
    for (let i = 0; i < beforeLines.length; i += 1) {
      const key = keyOf(beforeLines[i]);
      if (key !== null && key in expected) {
        assert.equal(keyOf(afterLines[i]), key, `line ${i + 1} keeps its key`);
      } else {
        assert.equal(afterLines[i], beforeLines[i], `line ${i + 1} is not identity and must be byte-identical`);
      }
    }
    // Same line count, same ending and every non-identity line equal: nothing was appended.
    assert.equal(after.endsWith('\n'), before.endsWith('\n'), 'trailing newline status kept');
    assert.equal(after.includes('\r'), false, 'LF stays LF');
  });

  test(`${volume} build.prop: fingerprints keep the build's own tail`, () => {
    const before = parseProps(stock(volume));
    const after = parseProps(rewriteIdentity(stock(volume), IDENTITY).text);
    let fingerprints = 0;
    for (const [key, value] of after) {
      if (!key.endsWith('.build.fingerprint')) continue;
      fingerprints += 1;
      assert.ok(before.get(key).endsWith(TAIL), `${key} stock tail is what the fixture says`);
      assert.ok(value.endsWith(TAIL), `${key} keeps release, id, incremental, type and tags`);
      assert.ok(value.startsWith('open-emulator/openemu_x86_64/openemu:'), `${key} has our brand/name/device`);
    }
    assert.ok(fingerprints >= 1, 'every stock file has at least one fingerprint');
  });

  test(`${volume} build.prop: a second rewrite changes nothing`, () => {
    const once = rewriteIdentity(stock(volume), IDENTITY).text;
    const twice = rewriteIdentity(once, IDENTITY);
    assert.equal(twice.text, once);
    assert.deepEqual(twice.changed, []);
  });
}

test('keys that only look like identity keys are untouched in the real files', () => {
  const seen = new Set();
  for (const volume of Object.keys(EXPECTED)) {
    const before = parseProps(stock(volume));
    const after = parseProps(rewriteIdentity(stock(volume), IDENTITY).text);
    for (const key of LOOKALIKES) {
      if (!before.has(key)) continue;
      seen.add(key);
      assert.equal(after.get(key), before.get(key), `${volume}: ${key}`);
    }
    // And the vendor's `ro.vendor.product.cpu.*`, which has `product` in the middle.
    for (const [key, value] of before) {
      if (key.startsWith('ro.vendor.product.')) assert.equal(after.get(key), value, key);
    }
  }
  assert.deepEqual([...seen].sort(), [...LOOKALIKES].sort(), 'each lookalike is really in one of the files');
});

test('the stock files hold the values this test assumes', () => {
  // If Google's image or the fixture drifts, say so here rather than as a confusing diff above.
  assert.equal(parseProps(stock('system')).get('ro.product.system.model'), 'mainline');
  assert.equal(parseProps(stock('vendor')).get('ro.product.vendor.model'), 'Android SDK built for x86_64');
  assert.equal(parseProps(stock('system_ext')).get('ro.setupwizard.mode'), 'DISABLED');
});

test('unsuffixed and odm/bootimage product keys are identity too; other ro.product keys are not', () => {
  const text = [
    'ro.product.model=a',
    'ro.product.brand=a',
    'ro.product.odm.device=a',
    'ro.product.bootimage.name=a',
    'ro.build.fingerprint=Android/sdk/generic:11/X/1:user/release-keys',
    'ro.odm.build.fingerprint=Android/sdk/generic:11/X/1:user/release-keys',
    'ro.product.cpu.abi=x86_64',
    'ro.product.locale=en-US',
    'ro.product.first_api_level=30',
    'ro.product.model.for_attestation=a',
    'ro.product.systemx.model=a',
    'ro.product.build.date=today',
    'ro.system.build.display.id=a',
    'ro.build.fingerprint.extra=a',
    '',
  ].join('\n');

  const { text: out, changed } = rewriteIdentity(text, IDENTITY);

  assert.deepEqual(changed, [
    'ro.product.model',
    'ro.product.brand',
    'ro.product.odm.device',
    'ro.product.bootimage.name',
    'ro.build.fingerprint',
    'ro.odm.build.fingerprint',
  ]);
  const props = parseProps(out);
  assert.equal(props.get('ro.build.fingerprint'), 'open-emulator/openemu_x86_64/openemu:11/X/1:user/release-keys');
  for (const key of ['ro.product.model.for_attestation', 'ro.product.systemx.model', 'ro.system.build.display.id', 'ro.build.fingerprint.extra']) {
    assert.equal(props.get(key), 'a', `${key} is not an identity key`);
  }
  assert.equal(props.get('ro.product.cpu.abi'), 'x86_64');
});

test('every occurrence of an identity key is rewritten, and a comment is not an occurrence', () => {
  const text = 'ro.product.model=first\n# ro.product.model=commented\nx=1\nro.product.model=second\n';
  const { text: out, changed } = rewriteIdentity(text, IDENTITY);

  assert.equal(out, 'ro.product.model=OpenEmulator One\n# ro.product.model=commented\nx=1\nro.product.model=OpenEmulator One\n');
  assert.deepEqual(changed, ['ro.product.model'], 'listed once');
});

test('a rewritten line keeps the whitespace and line ending around its value', () => {
  const { text } = rewriteIdentity('  ro.product.model =  old  \r\nro.product.brand=x', IDENTITY);
  assert.equal(text, '  ro.product.model =  OpenEmulator One  \r\nro.product.brand=open-emulator');
});

test('a file with no identity keys comes back identical, with nothing appended', () => {
  const text = '# nothing\nfoo=bar';
  assert.deepEqual(rewriteIdentity(text, IDENTITY), { text, changed: [] });
  assert.deepEqual(rewriteIdentity('', IDENTITY), { text: '', changed: [] });
});

test('a fingerprint that is not brand/name/device:release/id/incremental:type/tags is refused', () => {
  for (const bad of ['garbage', 'a/b:11/X/1:user/keys', 'a/b/c/d:11/X/1:user/keys', 'a/b/c:11/X/1', '']) {
    assert.throws(() => rewriteIdentity(`ro.vendor.build.fingerprint=${bad}\n`, IDENTITY), /fingerprint/, JSON.stringify(bad));
  }
});

test('identity values that would break a fingerprint or a line are refused', () => {
  const cases = [
    [{ brand: 'open/emulator' }, /identity\.brand/],
    [{ name: 'openemu:x86_64' }, /identity\.name/],
    [{ device: 'open emu' }, /identity\.device/],
    [{ model: 'One\nro.debuggable=1' }, /identity\.model/],
    [{ displayId: 'x\r' }, /identity\.displayId/],
    [{ description: 'a\0b' }, /identity\.description/],
    [{ buildProduct: '' }, /identity\.buildProduct is empty/],
    [{ manufacturer: ' padded' }, /identity\.manufacturer/],
  ];
  for (const [over, message] of cases) {
    const identity = { ...IDENTITY, ...over };
    assert.throws(() => checkIdentity(identity), message);
    assert.throws(() => rewriteIdentity('ro.product.model=x\n', identity), message);
  }
  // Spaces are fine where no fingerprint is built from the value.
  assert.doesNotThrow(() => checkIdentity(IDENTITY));
});

// ── upsertProps ───────────────────────────────────────────────────────────────────────────────

test('upsert replaces a present key in place and appends nothing', () => {
  const text = '# head\na=1\nb=2\nc=3\n';
  assert.equal(upsertProps(text, { b: 'two' }), '# head\na=1\nb=two\nc=3\n');
});

test('upsert appends an absent key at the end, keeping one trailing newline', () => {
  assert.equal(upsertProps('a=1\n', { z: '26' }), 'a=1\nz=26\n');
  assert.equal(upsertProps('a=1', { z: '26' }), 'a=1\nz=26\n', 'a missing final newline is added, not glued onto');
  assert.equal(upsertProps('', { z: '26' }), 'z=26\n');
  assert.equal(upsertProps('a=1\n\n', { z: '26' }), 'a=1\n\nz=26\n', 'a trailing blank line is kept, not eaten');
});

test('upsert replaces every occurrence of a duplicated key and appends no third', () => {
  assert.equal(upsertProps('k=1\nx=0\nk=2\n', { k: 'new' }), 'k=new\nx=0\nk=new\n');
});

test('upsert handles present and absent keys together, appending in the order given', () => {
  assert.equal(upsertProps('b=1\n', { c: '3', b: '2', a: '1' }), 'b=2\nc=3\na=1\n');
});

test('upsert with nothing to append keeps the ending the text had', () => {
  assert.equal(upsertProps('a=1', { a: '2' }), 'a=2');
  assert.equal(upsertProps('a=1\n', {}), 'a=1\n');
});

test('upsert does not count a commented-out key as present', () => {
  assert.equal(upsertProps('# ro.x=old\n', { 'ro.x': 'new' }), '# ro.x=old\nro.x=new\n');
});

test('upsert allows an empty value, as stock files have', () => {
  assert.equal(upsertProps('ro.board.platform=x\n', { 'ro.board.platform': '' }), 'ro.board.platform=\n');
});

test('upsert refuses bad keys and values, and edits nothing when it does', () => {
  for (const key of ['', 'ro.a b', 'ro.a=b', 'ro/a', 'ro.a\n', 'ró.a']) {
    assert.throws(() => upsertProps('a=1\n', { ok: '1', [key]: 'v' }), /property name/, JSON.stringify(key));
  }
  for (const value of ['a\nb', 'a\rb', 'a\0b', 'trailing\n', ' leading', 'trailing\t']) {
    assert.throws(() => upsertProps('a=1\n', { a: value }), /value/, JSON.stringify(value));
    assert.throws(() => checkProp('a', value), /value/);
  }
});

test('upsert of the recipe props into the real system build.prop only appends them', () => {
  const before = stock('system');
  const ours = {
    'ro.openemu.rom': '1',
    'ro.openemu.rom.version': '1',
    'ro.config.wallpaper': '/system/media/openemu/wallpaper.png',
  };
  const after = upsertProps(before, ours);

  assert.ok(after.startsWith(before), 'the stock text is untouched');
  assert.equal(after.slice(before.length),
    'ro.openemu.rom=1\nro.openemu.rom.version=1\nro.config.wallpaper=/system/media/openemu/wallpaper.png\n');
  assert.equal(upsertProps(after, ours), after, 'a second upsert is a no-op');
});

test('upserting a key system_ext already has, with the same value, changes nothing', () => {
  const before = stock('system_ext');
  assert.equal(upsertProps(before, { 'ro.setupwizard.mode': 'DISABLED' }), before);
});

// ── parseProps ────────────────────────────────────────────────────────────────────────────────

test('parseProps keeps the last definition of a key, as API 30 init does', () => {
  assert.equal(parseProps('a=1\nb=x\na=2\n').get('a'), '2');
});

test('ro.build.flavor takes our product name and keeps the build type', () => {
  const { text, changed } = rewriteIdentity(stock('system'), IDENTITY);
  assert.equal(parseProps(text).get('ro.build.flavor'), 'openemu_x86_64-userdebug');
  assert.ok(changed.includes('ro.build.flavor'));
});

test('parseProps skips comments, blank lines, import lines and lines without =', () => {
  const props = parseProps([
    '# a=comment',
    '   # b=indented comment',
    '',
    '   ',
    'import /vendor/etc/extra.prop',
    'import /odm/etc/build.prop ro.*',
    'no equals sign here',
    '=no key',
    '  spaced.key =  spaced value  ',
    'empty=',
    'eq=a=b',
    'crlf=value\r',
    'last=no newline',
  ].join('\n'));

  assert.deepEqual([...props], [
    ['spaced.key', 'spaced value'],
    ['empty', ''],
    ['eq', 'a=b'],
    ['crlf', 'value'],
    ['last', 'no newline'],
  ]);
});

test('parseProps reads every property line of the real files', () => {
  for (const volume of Object.keys(EXPECTED)) {
    const text = stock(volume);
    const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.equal(parseProps(text).size, lines.length, volume);
  }
  assert.equal(parseProps(stock('system')).get('ro.build.id'), 'RSR1.210722.013.A2');
  assert.equal(parseProps(stock('vendor')).get('ro.bootimage.build.date'), 'Thu May 4 15:17:11 UTC 2023');
});
