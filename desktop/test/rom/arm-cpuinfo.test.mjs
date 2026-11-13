import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { expandArmCpuinfo } = loadDist('rom/arm-cpuinfo.js');

// The two files as Google's API 34 Google APIs image ships them, byte for byte (tabs included).
const STOCK_ARM64 = Buffer.from(
  'processor\t: 1\n' +
  'BogoMIPS\t: 1.00\n' +
  'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp\n' +
  'CPU implementer\t: 0x41\n' +
  'CPU architecture: 8\n' +
  'CPU variant\t: 0x6\n' +
  'CPU part\t: 0x802\n' +
  'CPU revision\t: 13\n',
  'utf8',
);
const STOCK_ARM = Buffer.from(
  'processor\t: 1\n' +
  'BogoMIPS\t: 1.00\n' +
  'Features\t: neon vfp swp half thumb fastmult edsp vfpv3 vfpv4 idiva idivt\n' +
  'CPU implementer\t: 0x41\n' +
  'CPU architecture: 8\n' +
  'CPU variant\t: 0x6\n' +
  'CPU part\t: 0x802\n' +
  'CPU revision\t: 13\n',
  'utf8',
);

const processors = (buffer) => [...buffer.toString('utf8').matchAll(/^processor\t: (\d+)$/gm)].map((m) => Number(m[1]));

test('one entry becomes one per core, numbered from 0 as the kernel numbers them', () => {
  const out = expandArmCpuinfo(STOCK_ARM64, 6);
  assert.deepEqual(processors(out), [0, 1, 2, 3, 4, 5]);
  // The stock file numbers its only processor 1, which is why Unity reported "mask: 0x2".
  assert.deepEqual(processors(STOCK_ARM64), [1]);
});

test("every entry keeps Google's lines exactly; only the processor number differs", () => {
  const out = expandArmCpuinfo(STOCK_ARM64, 3).toString('utf8');
  const entries = out.split('\n\n').filter((e) => e.length > 0);
  assert.equal(entries.length, 3);
  const stockBody = STOCK_ARM64.toString('utf8').trimEnd().split('\n').slice(1);
  entries.forEach((entry, cpu) => {
    const lines = entry.split('\n');
    assert.equal(lines[0], `processor\t: ${cpu}`);
    assert.deepEqual(lines.slice(1), stockBody);
  });
});

test('entries are separated by a blank line and the file ends with one, as /proc/cpuinfo does', () => {
  const out = expandArmCpuinfo(STOCK_ARM, 2).toString('utf8');
  assert.ok(out.endsWith('CPU revision\t: 13\n\n'));
  assert.equal(out.split('\n\n').length, 3, 'two entries and the empty tail');
  assert.ok(!out.includes('\n\n\n'), 'never two blank lines');
});

test('the 32-bit file is expanded the same way and keeps its own feature list', () => {
  const out = expandArmCpuinfo(STOCK_ARM, 4);
  assert.deepEqual(processors(out), [0, 1, 2, 3]);
  assert.equal(out.toString('utf8').match(/neon vfp swp half thumb/g).length, 4);
  assert.ok(!out.toString('utf8').includes('asimd'));
});

test('one core gives one entry, renumbered to 0', () => {
  assert.deepEqual(processors(expandArmCpuinfo(STOCK_ARM64, 1)), [0]);
});

test('expanding an already expanded file gives the same bytes', () => {
  const once = expandArmCpuinfo(STOCK_ARM64, 8);
  assert.ok(expandArmCpuinfo(once, 8).equals(once));
  assert.deepEqual(processors(expandArmCpuinfo(once, 2)), [0, 1], 'and a smaller count shrinks it');
});

test('the same input always gives the same bytes — they are part of what the ROM id is made from', () => {
  assert.ok(expandArmCpuinfo(STOCK_ARM64, 12).equals(expandArmCpuinfo(Buffer.from(STOCK_ARM64), 12)));
});

test('CRLF line endings are read, and written back as LF', () => {
  const crlf = Buffer.from(STOCK_ARM64.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  assert.ok(expandArmCpuinfo(crlf, 2).equals(expandArmCpuinfo(STOCK_ARM64, 2)));
});

test('a file with no processor entry is refused rather than guessed at', () => {
  assert.throws(() => expandArmCpuinfo(Buffer.from('model name\t: something\n'), 4), /no "processor : N" entry/);
  assert.throws(() => expandArmCpuinfo(Buffer.alloc(0), 4), /no "processor : N" entry/);
});

test('an entry that names two processors is refused', () => {
  const merged = Buffer.from('processor\t: 0\nprocessor\t: 1\nBogoMIPS\t: 1.00\n');
  assert.throws(() => expandArmCpuinfo(merged, 2), /more than one processor/);
});

test('a core count that is not a positive whole number is refused', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => expandArmCpuinfo(STOCK_ARM64, bad), /cannot describe/);
  }
});
