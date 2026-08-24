import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';

const { downloadFile, downloadAll, digestOf, DownloadError } = loadDist('engine/download.js');

const PAYLOAD = Buffer.from('x'.repeat(4096) + 'END');
const SHA1 = createHash('sha1').update(PAYLOAD).digest('hex');

/**
 * A real HTTP server, not a stubbed fetch.
 *
 * Resume is the whole point of this module and it is a *protocol* behaviour — Range requests, 206
 * versus 200, Content-Range. A hand-rolled fake would encode my assumptions about those and prove
 * nothing about the code that runs against Google's CDN.
 */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Serves PAYLOAD with correct Range support. `truncateAt` cuts the stream off mid-flight. */
function fileHandler({ truncateAt = null, ignoreRange = false } = {}) {
  return (req, res) => {
    const range = ignoreRange ? null : req.headers.range;
    let body = PAYLOAD;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      body = PAYLOAD.subarray(start);
      res.writeHead(206, {
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
    } else {
      res.writeHead(200, { 'content-length': String(body.length) });
    }
    if (truncateAt !== null) {
      // Flush before killing the socket. Destroying immediately after write() can abort the bytes
      // before they reach the wire, which would test a connection that failed instantly rather
      // than one that died partway — the case that actually matters here.
      res.write(body.subarray(0, truncateAt), () => setTimeout(() => res.destroy(), 20));
      return;
    }
    res.end(body);
  };
}

test('a file downloads and verifies', async () => {
  await withTempDir(async (dir) => {
    await withServer(fileHandler(), async (base) => {
      const target = path.join(dir, 'pkg.zip');
      await downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 });

      assert.deepEqual(readFileSync(target), PAYLOAD);
      assert.ok(!existsSync(`${target}.part`), 'the part file is renamed away, not left behind');
    });
  });
});

test('a wrong digest is refused and the file never appears', async () => {
  await withTempDir(async (dir) => {
    await withServer(fileHandler(), async (base) => {
      const target = path.join(dir, 'pkg.zip');
      await assert.rejects(
        () => downloadFile({ url: `${base}/pkg.zip`, target, digest: 'a'.repeat(40) }),
        /failed verification/,
      );
      // Nothing downstream should ever be able to extract a corrupt archive.
      assert.ok(!existsSync(target));
    });
  });
});

test('an interrupted download leaves a part file, and the retry resumes from it', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'pkg.zip');

    // First attempt: the server cuts the connection halfway.
    await withServer(fileHandler({ truncateAt: 2000 }), async (base) => {
      await assert.rejects(() => downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 }));
    });

    const partial = statSync(`${target}.part`).size;
    assert.ok(partial > 0 && partial < PAYLOAD.length, `kept ${partial} bytes as a head start`);

    // Second attempt against a healthy server must continue, not restart.
    let sawRange = null;
    await withServer((req, res) => {
      sawRange = req.headers.range ?? null;
      fileHandler()(req, res);
    }, async (base) => {
      await downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 });
    });

    assert.equal(sawRange, `bytes=${partial}-`, 'asked to continue from exactly where it stopped');
    assert.deepEqual(readFileSync(target), PAYLOAD, 'and the reassembled file is byte-identical');
  });
});

test('a server that ignores Range is handled by starting over, not by appending', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'pkg.zip');
    writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 1000));

    await withServer(fileHandler({ ignoreRange: true }), async (base) => {
      await downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 });
    });

    // Appending a full response onto a partial file would duplicate the first 1000 bytes and
    // produce a corrupt archive that still looked plausible.
    assert.deepEqual(readFileSync(target), PAYLOAD);
  });
});

test('an already-correct file is not downloaded again', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'pkg.zip');
    writeFileSync(target, PAYLOAD);

    let requests = 0;
    await withServer((req, res) => {
      requests += 1;
      fileHandler()(req, res);
    }, async (base) => {
      await downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 });
    });

    // This is what makes "Try again" cost seconds instead of restarting a 2 GB download.
    assert.equal(requests, 0);
  });
});

test('a present-but-wrong file is replaced rather than resumed onto', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'pkg.zip');
    writeFileSync(target, Buffer.from('stale contents'));

    await withServer(fileHandler(), async (base) => {
      await downloadFile({ url: `${base}/pkg.zip`, target, digest: SHA1 });
    });

    assert.deepEqual(readFileSync(target), PAYLOAD);
  });
});

test('a 404 is not retryable; a 503 is', async () => {
  await withTempDir(async (dir) => {
    for (const [status, retryable] of [[404, false], [503, true]]) {
      await withServer((_req, res) => {
        res.writeHead(status);
        res.end();
      }, async (base) => {
        const err = await downloadFile({ url: `${base}/x.zip`, target: path.join(dir, `${status}.zip`) })
          .then(() => null)
          .catch((e) => e);
        assert.ok(err instanceof DownloadError, `status ${status}`);
        assert.equal(err.retryable, retryable, `status ${status} retryable=${retryable}`);
      });
    }
  });
});

test('an oversized download is refused before it fills the disk', async () => {
  await withTempDir(async (dir) => {
    await withServer(fileHandler(), async (base) => {
      await assert.rejects(
        () => downloadFile({ url: `${base}/pkg.zip`, target: path.join(dir, 'big.zip') }, { maxBytes: 10 }),
        /size limit|refusing/,
      );
    });
  });
});

test('progress across parallel downloads is reported as one total', async () => {
  await withTempDir(async (dir) => {
    await withServer(fileHandler(), async (base) => {
      const seen = [];
      const result = await downloadAll(
        ['a', 'b', 'c'].map((name) => ({
          url: `${base}/${name}.zip`,
          target: path.join(dir, `${name}.zip`),
          digest: SHA1,
          sizeBytes: PAYLOAD.length,
        })),
        { concurrency: 3, onProgress: (p) => seen.push(p) },
      );

      assert.equal(result.files.length, 3);
      assert.equal(result.failures.length, 0);
      const last = seen[seen.length - 1];
      assert.equal(last.bytesTotal, PAYLOAD.length * 3, 'one bar covering all three, not three bars');
      assert.equal(last.bytesDone, PAYLOAD.length * 3);
    });
  });
});

test('one failed package does not discard the others that succeeded', async () => {
  await withTempDir(async (dir) => {
    await withServer((req, res) => {
      if (req.url?.includes('bad')) {
        res.writeHead(404);
        res.end();
        return;
      }
      fileHandler()(req, res);
    }, async (base) => {
      const result = await downloadAll(
        [
          { url: `${base}/good.zip`, target: path.join(dir, 'good.zip'), digest: SHA1 },
          { url: `${base}/bad.zip`, target: path.join(dir, 'bad.zip'), digest: SHA1 },
        ],
        { concurrency: 2 },
      );

      // Throwing here would throw away gigabytes that downloaded fine; the caller retries only
      // what actually failed.
      assert.equal(result.files.length, 1);
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0].url, /bad\.zip/);
    });
  });
});

test('digestOf agrees with the hash the manifest would publish', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'f.bin');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, PAYLOAD);

    assert.equal(await digestOf(file, 'sha1'), SHA1);
  });
});
