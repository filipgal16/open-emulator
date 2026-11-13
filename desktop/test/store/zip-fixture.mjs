import zlib from 'node:zlib';

/**
 * Builds a genuine PKZIP archive in memory, the same way `test/engine/sdk/dependencies.test.mjs`
 * does — by hand, so the fixture depends on nothing — but with deflate and zip64 as options,
 * since bundles use both.
 *
 * `files` is a list of `[name, data, { method }]`, `method` being `'stored'` or `'deflate'`
 * (the default). With `zip64`, every size and offset is written as the 0xFFFFFFFF placeholder with
 * its real value in a zip64 extra field, and the end of the archive carries the zip64 record and
 * locator — the layout a writer produces for an archive past 4 GB, at a size a test can afford.
 */
export function makeZip(files, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content, options = {}] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const method = options.method === 'stored' ? 0 : 8;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const nameBytes = Buffer.from(name, 'utf8');

    const localExtra = zip64 ? zip64Extra([data.length, packed.length]) : Buffer.alloc(0);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 18);
    head.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    head.writeUInt16LE(localExtra.length, 28);
    const local = Buffer.concat([head, nameBytes, localExtra, packed]);

    const centralExtra = zip64 ? zip64Extra([data.length, packed.length, offset]) : Buffer.alloc(0);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(zip64 ? 45 : 20, 4);
    dir.writeUInt16LE(zip64 ? 45 : 20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
    dir.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(centralExtra.length, 30);
    dir.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);

    locals.push(local);
    centrals.push(Buffer.concat([dir, nameBytes, centralExtra]));
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  tail.push(end);

  return Buffer.concat([...locals, directory, ...tail]);
}

function zip64Extra(values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

/** A stand-in APK: a zip with a manifest at its root, which is all the detection looks for. */
export function fakeApk(tag) {
  return makeZip([
    ['AndroidManifest.xml', `manifest for ${tag}`],
    ['classes.dex', `code for ${tag}`.repeat(50)],
  ]);
}
