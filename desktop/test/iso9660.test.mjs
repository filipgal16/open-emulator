import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { IsoReader, readBootFiles, IsoError } = loadDist('engine/qemu/iso9660.js');

const SECTOR = 2048;

/**
 * Builds a minimal but genuinely valid ISO9660 image.
 *
 * Written by hand rather than shelled out to mkisofs, which does not exist on Windows — and the
 * point of the module under test is precisely that we no longer need such a tool. It also
 * documents the format: both-endian integers, 2048-byte sectors, and directory records that never
 * straddle a sector boundary.
 */
function buildIso(layout) {
  // Sector plan: 0-15 reserved, 16 PVD, 17 terminator, 18 root dir, then one sector per
  // subdirectory, then file contents.
  const sectors = [];
  const put = (index, buf) => { sectors[index] = buf; };

  const both32 = (n) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32BE(n, 4); return b; };

  function dirRecord(name, lba, size, isDir, special = null) {
    const id = special !== null ? Buffer.from([special]) : Buffer.from(name, 'ascii');
    let len = 33 + id.length;
    if (len % 2) len += 1; // records are padded to an even length
    const r = Buffer.alloc(len);
    r[0] = len;
    both32(lba).copy(r, 2);
    both32(size).copy(r, 10);
    r[25] = isDir ? 0x02 : 0x00;
    r[32] = id.length;
    id.copy(r, 33);
    return r;
  }

  function directorySector(selfLba, selfSize, parentLba, children) {
    const parts = [
      dirRecord('', selfLba, selfSize, true, 0x00),
      dirRecord('', parentLba, SECTOR, true, 0x01),
      ...children,
    ];
    const out = Buffer.alloc(SECTOR);
    let off = 0;
    for (const p of parts) { p.copy(out, off); off += p.length; }
    return out;
  }

  let nextLba = 19 + layout.dirs.length;
  const fileEntries = [];
  for (const f of layout.files.concat(...layout.dirs.map((d) => d.files))) {
    const lba = nextLba;
    const size = f.data.length;
    nextLba += Math.max(1, Math.ceil(size / SECTOR));
    fileEntries.push({ ...f, lba, size });
    const padded = Buffer.alloc(Math.max(1, Math.ceil(size / SECTOR)) * SECTOR);
    f.data.copy(padded, 0);
    for (let i = 0; i < padded.length / SECTOR; i += 1) {
      put(lba + i, padded.subarray(i * SECTOR, (i + 1) * SECTOR));
    }
  }

  const at = (name) => fileEntries.find((e) => e.name === name);

  // Subdirectories, one sector each.
  layout.dirs.forEach((d, i) => {
    const lba = 19 + i;
    put(lba, directorySector(lba, SECTOR, 18, d.files.map((f) => dirRecord(f.name, at(f.name).lba, at(f.name).size, false))));
  });

  const rootChildren = [
    ...layout.files.map((f) => dirRecord(f.name, at(f.name).lba, at(f.name).size, false)),
    ...layout.dirs.map((d, i) => dirRecord(d.name, 19 + i, SECTOR, true)),
  ];
  put(18, directorySector(18, SECTOR, 18, rootChildren));

  // Primary volume descriptor.
  const pvd = Buffer.alloc(SECTOR);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'ascii');
  pvd[6] = 1;
  dirRecord('', 18, SECTOR, true, 0x00).copy(pvd, 156);
  put(16, pvd);

  const term = Buffer.alloc(SECTOR);
  term[0] = 0xff;
  term.write('CD001', 1, 'ascii');
  put(17, term);

  const total = sectors.length;
  const out = Buffer.alloc(total * SECTOR);
  for (let i = 0; i < total; i += 1) if (sectors[i]) sectors[i].copy(out, i * SECTOR);
  return out;
}

const KERNEL = Buffer.from('\x1f\x8b fake bzImage payload');
const INITRD = Buffer.from('fake gzipped cpio payload');

async function withIso(layout, fn) {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'android.iso');
    writeFileSync(file, buildIso(layout));
    return fn(file);
  });
}

test('a payload at the media root is found, with an empty SRC', async () => {
  // How Android-x86 ISO releases are laid out.
  await withIso({ files: [{ name: 'kernel', data: KERNEL }, { name: 'initrd.img', data: INITRD }], dirs: [] },
    async (file) => {
      const boot = readBootFiles(file);
      assert.equal(boot.srcDir, '', 'SRC= must be empty for a root payload');
      assert.deepEqual(boot.kernel, KERNEL);
      assert.deepEqual(boot.initrd, INITRD);
    });
});

test('a payload in a release-named directory yields that directory as SRC', async () => {
  // How an installed-to-disk layout looks. Guessing either shape would break the other.
  await withIso({
    files: [],
    dirs: [{ name: 'android-9.0-r2', files: [{ name: 'kernel', data: KERNEL }, { name: 'initrd.img', data: INITRD }] }],
  }, async (file) => {
    const boot = readBootFiles(file);
    assert.equal(boot.srcDir, '/android-9.0-r2');
    assert.deepEqual(boot.kernel, KERNEL);
  });
});

test('the root listing skips . and .. rather than returning them as entries', async () => {
  await withIso({ files: [{ name: 'kernel', data: KERNEL }, { name: 'initrd.img', data: INITRD }], dirs: [] },
    async (file) => {
      const iso = new IsoReader(file);
      try {
        const names = iso.list(iso.root()).map((e) => e.name).sort();
        assert.deepEqual(names, ['initrd.img', 'kernel']);
      } finally { iso.close(); }
    });
});

test('lookups are case-insensitive and ignore the ISO version suffix', async () => {
  // Plain ISO9660 stores INITRD.IMG;1; Rock Ridge preserves initrd.img. Both must resolve.
  await withIso({ files: [{ name: 'KERNEL;1', data: KERNEL }, { name: 'INITRD.IMG;1', data: INITRD }], dirs: [] },
    async (file) => {
      const boot = readBootFiles(file);
      assert.deepEqual(boot.kernel, KERNEL);
      assert.deepEqual(boot.initrd, INITRD);
    });
});

test('an image with no boot files is refused, naming what it looked for', async () => {
  await withIso({ files: [{ name: 'readme.txt', data: Buffer.from('hello') }], dirs: [] }, async (file) => {
    assert.throws(() => readBootFiles(file), /no kernel and initrd\.img found/);
  });
});

test('a file that is not an ISO is refused rather than misread', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'not.iso');
    writeFileSync(file, Buffer.alloc(SECTOR * 20, 0x41));
    assert.throws(() => readBootFiles(file), /not an ISO9660 image/);
  });
});

test('reading past the end of the image fails instead of returning garbage', async () => {
  await withIso({ files: [{ name: 'kernel', data: KERNEL }, { name: 'initrd.img', data: INITRD }], dirs: [] },
    async (file) => {
      const iso = new IsoReader(file);
      try {
        assert.throws(() => iso.readFile({ name: 'x', isDirectory: false, lba: 999_999, size: SECTOR }),
          IsoError);
      } finally { iso.close(); }
    });
});
