import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { loadAdsConfig, ADS_CONFIG_FILENAME } = loadDist('ads/config.js');

const write = (dir, contents) =>
  writeFileSync(path.join(dir, ADS_CONFIG_FILENAME), typeof contents === 'string' ? contents : JSON.stringify(contents));

test('a build with no config file serves no ads', async () => {
  await withTempDir(async (dir) => {
    assert.equal(loadAdsConfig([dir], {}).enabled, false);
  });
});

test('a malformed config file serves no ads rather than crashing the app', async () => {
  await withTempDir(async (dir) => {
    write(dir, '{ nope');
    assert.equal(loadAdsConfig([dir], {}).enabled, false);
  });
});

test('enabled must be explicitly true — no truthy coercion', async () => {
  await withTempDir(async (dir) => {
    write(dir, { enabled: 'yes' });
    assert.equal(loadAdsConfig([dir], {}).enabled, false);
  });
});

test('a populated config is read through', async () => {
  await withTempDir(async (dir) => {
    write(dir, {
      enabled: true,
      manifestUrl: 'https://ads.example.test/v1/manifest.json',
      affiliates: { nordvpn: 'AFF-123', junk: 42 },
      network: { provider: 'somenetwork', publisherId: 'PUB-9' },
    });

    const config = loadAdsConfig([dir], {});
    assert.equal(config.enabled, true);
    assert.equal(config.manifestUrl, 'https://ads.example.test/v1/manifest.json');
    assert.deepEqual(config.affiliates, { nordvpn: 'AFF-123' }, 'non-string affiliate ids are dropped');
    assert.equal(config.network.publisherId, 'PUB-9');
  });
});

test('the first directory in the search order wins', async () => {
  await withTempDir(async (packaged) => {
    await withTempDir(async (source) => {
      write(packaged, { enabled: true, manifestUrl: 'https://packaged.test/m.json' });
      write(source, { enabled: true, manifestUrl: 'https://source.test/m.json' });
      assert.equal(loadAdsConfig([packaged, source], {}).manifestUrl, 'https://packaged.test/m.json');
    });
  });
});

test('OPEN_EMULATOR_ADS overrides the file in both directions', async () => {
  await withTempDir(async (dir) => {
    assert.equal(loadAdsConfig([dir], { OPEN_EMULATOR_ADS: '1' }).enabled, true, 'house-only dev mode');

    write(dir, { enabled: true });
    assert.equal(loadAdsConfig([dir], { OPEN_EMULATOR_ADS: '0' }).enabled, false, 'kill switch');
    assert.equal(loadAdsConfig([dir], {}).enabled, true);
  });
});
