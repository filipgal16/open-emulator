import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../../helpers.mjs';

const { licenseHash, isAccepted, recordAcceptance, pendingLicenses, acceptAll } =
  loadDist('engine/sdk/licenses.js');

const LICENSE = { id: 'android-sdk-license', text: 'Terms and Conditions' };
const OTHER = { id: 'android-sdk-preview-license', text: 'Preview terms' };

test('the hash is the SHA-1 of the exact licence text, as sdkmanager records it', () => {
  assert.equal(licenseHash(LICENSE.text), createHash('sha1').update(LICENSE.text, 'utf8').digest('hex'));
});

test('nothing is accepted on a fresh SDK root', async () => {
  await withTempDir(async (dir) => {
    assert.equal(isAccepted(dir, LICENSE), false);
  });
});

test('acceptance round-trips, in the layout sdkmanager expects', async () => {
  await withTempDir(async (dir) => {
    recordAcceptance(dir, LICENSE);

    assert.equal(isAccepted(dir, LICENSE), true);
    const file = path.join(dir, 'licenses', 'android-sdk-license');
    assert.ok(existsSync(file), 'a file per licence id under licenses/');
    assert.match(readFileSync(file, 'utf8'), new RegExp(licenseHash(LICENSE.text)));
  });
});

test('revised licence wording is not covered by an older acceptance', async () => {
  await withTempDir(async (dir) => {
    recordAcceptance(dir, LICENSE);

    // Google revises these. A stale acceptance recorded against older wording is not consent to
    // the current text, and treating it as such would be the whole point of this file, wrong.
    assert.equal(isAccepted(dir, { id: LICENSE.id, text: 'Revised terms' }), false);
  });
});

test('accepting a second version appends rather than revoking the first', async () => {
  await withTempDir(async (dir) => {
    recordAcceptance(dir, LICENSE);
    recordAcceptance(dir, { id: LICENSE.id, text: 'Revised terms' });

    assert.equal(isAccepted(dir, LICENSE), true, 'the original acceptance survives');
    assert.equal(isAccepted(dir, { id: LICENSE.id, text: 'Revised terms' }), true);
  });
});

test('recording twice does not duplicate the hash', async () => {
  await withTempDir(async (dir) => {
    recordAcceptance(dir, LICENSE);
    recordAcceptance(dir, LICENSE);

    const lines = readFileSync(path.join(dir, 'licenses', 'android-sdk-license'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(lines.length, 1);
  });
});

test('only unaccepted licences are pending', async () => {
  await withTempDir(async (dir) => {
    const all = new Map([[LICENSE.id, LICENSE], [OTHER.id, OTHER]]);

    assert.equal(pendingLicenses(dir, all, [LICENSE.id, OTHER.id]).length, 2);
    recordAcceptance(dir, LICENSE);
    assert.deepEqual(pendingLicenses(dir, all, [LICENSE.id, OTHER.id]).map((l) => l.id), [OTHER.id]);

    acceptAll(dir, [OTHER]);
    assert.deepEqual(pendingLicenses(dir, all, [LICENSE.id, OTHER.id]), []);
  });
});

test('a licence the manifest references but does not define is surfaced, not skipped', async () => {
  await withTempDir(async (dir) => {
    // Silently proceeding would mean accepting terms on the user's behalf that nobody can read.
    assert.throws(() => pendingLicenses(dir, new Map(), ['android-sdk-license']), /does not define it/);
  });
});

test('a licence id that is a path traversal is refused', async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => recordAcceptance(dir, { id: '../../evil', text: 'x' }), /unsafe licence id/);
  });
});

test('a corrupt licences file reads as not accepted rather than throwing', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, 'licenses'), { recursive: true });
    writeFileSync(path.join(dir, 'licenses', 'android-sdk-license'), Buffer.from([0xff, 0xfe, 0x00]));

    assert.equal(isAccepted(dir, LICENSE), false);
  });
});
