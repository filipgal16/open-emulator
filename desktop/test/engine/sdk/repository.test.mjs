import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { parseRepository, resolveUrl, sysImgManifestFor, hostOsForPlatform } = loadDist('engine/sdk/repository.js');

const MANIFEST_URL = 'https://dl.google.com/android/repository/repository2-3.xml';

/**
 * Shaped exactly like Google's real manifest, including the detail that matters: `<host-os>` comes
 * *after* `<complete>`, and one package carries three archives back to back.
 */
const XML = `<?xml version="1.0" ?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <license id="android-sdk-license" type="text">Terms and Conditions &amp; such &lt;here&gt;</license>
  <license id="android-sdk-preview-license" type="text">Preview terms</license>
  <remotePackage path="platform-tools">
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <archives>
      <archive>
        <complete>
          <size>9054187</size>
          <checksum type="sha1">AAAA254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-linux.zip</url>
        </complete>
        <host-os>linux</host-os>
      </archive>
      <archive>
        <complete>
          <size>9100000</size>
          <checksum type="sha1">BBBB254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-darwin.zip</url>
        </complete>
        <host-os>macosx</host-os>
      </archive>
      <archive>
        <complete>
          <size>8000000</size>
          <checksum type="sha1">CCCC254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-win.zip</url>
        </complete>
        <host-os>windows</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="platforms;android-30">
    <display-name>Android SDK Platform 30</display-name>
    <uses-license ref="android-sdk-license"/>
    <archives>
      <archive>
        <complete>
          <size>52328361</size>
          <checksum type="sha1">e7c6280901dcfa511af098d67dd88c4dfcbc6ea2</checksum>
          <url>platform-30_r03.zip</url>
        </complete>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="broken;no-archive">
    <display-name>Nothing usable</display-name>
    <archives></archives>
  </remotePackage>
</sdk:sdk-repository>`;

test('the archive for THIS host is chosen, not the first one in the file', () => {
  // The trap, and it is not hypothetical: a single lazy pattern spanning from <archive> to the
  // windows <host-os> reaches across the two preceding archives, and the <url> read out of that
  // span is the linux one. Verified against the live manifest, which returned
  // platform-tools_r37.0.1-linux.zip for a Windows host.
  const win = parseRepository(XML, 'windows', MANIFEST_URL).packages.get('platform-tools');
  const mac = parseRepository(XML, 'macosx', MANIFEST_URL).packages.get('platform-tools');
  const lin = parseRepository(XML, 'linux', MANIFEST_URL).packages.get('platform-tools');

  assert.match(win.url, /-win\.zip$/);
  assert.match(mac.url, /-darwin\.zip$/);
  assert.match(lin.url, /-linux\.zip$/);
});

test('size and checksum come from the same archive as the url', () => {
  const win = parseRepository(XML, 'windows', MANIFEST_URL).packages.get('platform-tools');

  // Mixing these across archives yields a download that always fails verification, and the message
  // would point at the network rather than at the parser.
  assert.equal(win.sizeBytes, 8000000);
  assert.equal(win.sha1, 'cccc254aa5f903c15cf51001717bdf347fb6b53e0');
});

test('a package with no host-os is universal, not unavailable', () => {
  for (const host of ['windows', 'macosx', 'linux']) {
    const platform = parseRepository(XML, host, MANIFEST_URL).packages.get('platforms;android-30');
    assert.ok(platform, `platforms;android-30 missing on ${host}`);
    assert.match(platform.url, /platform-30_r03\.zip$/);
  }
});

test('a package with no usable archive is skipped rather than half-parsed', () => {
  assert.equal(parseRepository(XML, 'windows', MANIFEST_URL).packages.has('broken;no-archive'), false);
});

test('urls are resolved against the manifest, not left relative', () => {
  const win = parseRepository(XML, 'windows', MANIFEST_URL).packages.get('platform-tools');

  assert.equal(win.url, 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip');
});

test('an already-absolute url is left alone', () => {
  assert.equal(resolveUrl(MANIFEST_URL, 'https://example.com/a.zip'), 'https://example.com/a.zip');
});

test('licence texts are captured and entity-decoded', () => {
  const { licenses } = parseRepository(XML, 'windows', MANIFEST_URL);

  assert.equal(licenses.size, 2);
  // The licence has to be presentable to a human, so entities cannot survive into the UI.
  assert.equal(licenses.get('android-sdk-license').text, 'Terms and Conditions & such <here>');
});

test('a package records which licence it requires', () => {
  const win = parseRepository(XML, 'windows', MANIFEST_URL).packages.get('platform-tools');

  assert.equal(win.licenseId, 'android-sdk-license');
});

test('each image tag maps to its own system-image manifest', () => {
  const aosp = sysImgManifestFor('default');
  const gapis = sysImgManifestFor('google_apis');
  const play = sysImgManifestFor('google_apis_playstore');

  assert.equal(new Set([aosp, gapis, play]).size, 3, 'three tags, three manifests');
  assert.match(gapis, /google_apis\//);
  assert.match(play, /google_apis_playstore\//);
});

test('the host is derived from the platform', () => {
  assert.equal(hostOsForPlatform('win32'), 'windows');
  assert.equal(hostOsForPlatform('darwin'), 'macosx');
  assert.equal(hostOsForPlatform('linux'), 'linux');
});
