import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { assetUrl, chooseVersion, distillIndex, findApp, pickLocalized, searchIndex, stripHtml } =
  loadDist('store/fdroid-index.js');

const sha = (n) => String(n).repeat(64).slice(0, 64);

function version(overrides = {}) {
  const { versionCode = 1, versionName = '1.0', minSdk = 21, nativecode, digest = sha(1), size = 1024, added = 100 } =
    overrides;
  return {
    added,
    file: { name: `/app_${versionCode}.apk`, sha256: digest, size },
    manifest: {
      versionCode,
      versionName,
      usesSdk: { minSdkVersion: minSdk, targetSdkVersion: 30 },
      ...(nativecode ? { nativecode } : {}),
    },
    ...(overrides.antiFeatures ? { antiFeatures: overrides.antiFeatures } : {}),
  };
}

function index(packages) {
  return distillIndex({
    repo: { address: 'https://f-droid.org/repo/', timestamp: 42 },
    packages,
  });
}

function app(name, overrides = {}) {
  return {
    metadata: {
      name: { 'en-US': name },
      summary: { 'en-US': overrides.summary ?? `${name} summary` },
      description: { 'en-US': overrides.description ?? '' },
      license: 'GPL-3.0-only',
      categories: ['Internet'],
      lastUpdated: overrides.lastUpdated ?? 1_000,
      icon: { 'en-US': { name: `/${name}/icon.png`, sha256: sha(2), size: 10 } },
      ...(overrides.metadata ?? {}),
    },
    versions: overrides.versions ?? { [sha(1)]: version() },
  };
}

test('localised fields prefer English but never render blank', () => {
  assert.equal(pickLocalized({ 'en-US': 'a', de: 'b' }), 'a');
  assert.equal(pickLocalized({ en: 'a' }), 'a');
  assert.equal(pickLocalized({ de: 'nur deutsch' }), 'nur deutsch', 'falls back to any locale');
  assert.equal(pickLocalized(undefined), null);
  assert.equal(pickLocalized('not a map'), null);
});

test('descriptions are reduced to plain text', () => {
  assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One\n\nTwo');
  assert.equal(stripHtml('a<br>b'), 'a\nb');
  assert.equal(stripHtml('<b>bold</b> &amp; &quot;quoted&quot;'), 'bold & "quoted"');
  assert.equal(stripHtml('<script>alert(1)</script>safe'), 'alert(1)safe', 'tags are stripped, not executed');
});

test('a version with no usable digest is dropped, because it could never be verified', () => {
  const distilled = index({
    'com.ok': app('Ok'),
    'com.nohash': {
      metadata: { name: { 'en-US': 'NoHash' }, lastUpdated: 1 },
      versions: { x: { added: 1, file: { name: '/x.apk', size: 1 }, manifest: { versionCode: 1 } } },
    },
  });

  assert.equal(distilled.apps.length, 1);
  assert.equal(distilled.apps[0].packageName, 'com.ok');
});

test('an app with no installable version is not listed at all', () => {
  const distilled = index({
    'com.empty': { metadata: { name: { 'en-US': 'Empty' } }, versions: {} },
  });
  assert.equal(distilled.apps.length, 0);
});

test('one malformed package does not take the catalogue down', () => {
  const distilled = index({
    'com.good': app('Good'),
    'com.broken': null,
    'com.alsobroken': { metadata: 'not an object', versions: 7 },
  });
  assert.equal(distilled.apps.length, 1);
});

test('the repo address is normalised so asset URLs never double up slashes', () => {
  const distilled = index({ 'com.ok': app('Ok') });
  assert.equal(distilled.repoAddress, 'https://f-droid.org/repo');
  assert.equal(assetUrl(distilled, '/com.ok/icon.png'), 'https://f-droid.org/repo/com.ok/icon.png');
  assert.equal(assetUrl(distilled, 'com.ok/icon.png'), 'https://f-droid.org/repo/com.ok/icon.png');
});

test('the offered version is the newest the guest can actually run', () => {
  const distilled = index({
    'com.multi': app('Multi', {
      versions: {
        [sha(1)]: version({ versionCode: 3, versionName: '3.0', minSdk: 33, digest: sha(1) }),
        [sha(2)]: version({ versionCode: 2, versionName: '2.0', minSdk: 30, digest: sha(2) }),
        [sha(3)]: version({ versionCode: 1, versionName: '1.0', minSdk: 21, digest: sha(3) }),
      },
    }),
  });
  const entry = findApp(distilled, 'com.multi');

  assert.equal(chooseVersion(entry, 30).versionName, '2.0', 'skips the build that needs API 33');
  assert.equal(chooseVersion(entry, 33).versionName, '3.0');
  assert.equal(chooseVersion(entry, 21).versionName, '1.0');
  // Nothing fits: the newest comes back anyway so the UI can explain *why* it is unavailable,
  // rather than the app vanishing from search.
  assert.equal(chooseVersion(entry, 19).versionName, '3.0');
  assert.equal(chooseVersion(entry, null).versionName, '3.0');
});

test('native ABIs and anti-features are carried through, not hidden', () => {
  const distilled = index({
    'com.native': app('Native', {
      versions: {
        [sha(1)]: version({ nativecode: ['arm64-v8a'], antiFeatures: { Ads: { 'en-US': 'has ads' }, Tracking: {} } }),
      },
    }),
  });
  const entry = findApp(distilled, 'com.native');
  assert.deepEqual(entry.versions[0].abis, ['arm64-v8a']);
  assert.deepEqual(entry.versions[0].antiFeatures.sort(), ['Ads', 'Tracking']);
});

test('search ranks an exact package match above a name match', () => {
  const distilled = index({
    'org.thing': app('Something Else', { summary: 'mentions thing' }),
    'com.other': app('Thing'),
  });

  const [first] = searchIndex(distilled, 'org.thing');
  assert.equal(first.packageName, 'org.thing');
});

test('search ranks a name prefix above a summary mention', () => {
  const distilled = index({
    'a.pipe': app('NewPipe'),
    'b.other': app('Zebra', { summary: 'works like newpipe' }),
  });

  const results = searchIndex(distilled, 'newpipe');
  assert.equal(results[0].packageName, 'a.pipe');
  assert.equal(results.length, 2, 'the summary match still appears, just lower');
});

test('multi-token queries narrow rather than widen', () => {
  const distilled = index({
    'a.signal': app('Signal', { summary: 'private messenger' }),
    'b.tower': app('Signal Tower', { summary: 'cell signal strength' }),
  });

  const both = searchIndex(distilled, 'signal messenger');
  assert.equal(both.length, 1, 'every token must match something');
  assert.equal(both[0].packageName, 'a.signal');
});

test('an empty query browses by last update', () => {
  const distilled = index({
    'a.old': app('Old', { lastUpdated: 1 }),
    'b.new': app('New', { lastUpdated: 9_999 }),
  });

  const results = searchIndex(distilled, '   ');
  assert.equal(results[0].packageName, 'b.new');
});

test('search respects its limit', () => {
  const packages = {};
  for (let i = 0; i < 30; i += 1) packages[`com.app${i}`] = app(`App ${i}`);
  const distilled = index(packages);

  assert.equal(searchIndex(distilled, 'app', { limit: 5 }).length, 5);
  assert.equal(searchIndex(distilled, '', { limit: 3 }).length, 3);
});

test('a query that matches nothing returns nothing', () => {
  const distilled = index({ 'com.ok': app('Ok') });
  assert.deepEqual(searchIndex(distilled, 'zzzznotpresent'), []);
});
