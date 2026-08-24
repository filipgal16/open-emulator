/**
 * Google's Android SDK repository manifest.
 *
 * Each package lists its archives with a direct URL, a byte size, and a SHA-1. Reading it lets the
 * packages be fetched in parallel and resumed, and removes the need for a Java runtime and
 * `cmdline-tools` whose only job was to run `sdkmanager` as a downloader — about 175 MB and a whole
 * dependency chain.
 *
 * Parsed with regular expressions rather than an XML library on purpose: adding a dependency to
 * this project means adding a line to `LICENSING.md`, and the shape here is small, stable, and
 * fully covered by the fixture test. The parsing is done by splitting on element boundaries and
 * reading within each block — never with one pattern spanning the whole document, which is the
 * mistake that quietly returns the wrong archive (see `archivesOf`).
 */

export type HostOs = 'windows' | 'macosx' | 'linux';

export interface SdkArchive {
  /** Package coordinate, e.g. `platform-tools` or `system-images;android-30;default;x86_64`. */
  path: string;
  displayName: string;
  /** Absolute, resolved against the manifest's own location. */
  url: string;
  sizeBytes: number;
  sha1: string;
  /** `<uses-license ref="…">`, matched against the licence texts in the same document. */
  licenseId: string | null;
}

export interface SdkLicense {
  id: string;
  text: string;
}

export interface ParsedRepository {
  packages: Map<string, SdkArchive>;
  licenses: Map<string, SdkLicense>;
}

const BLOCK = {
  remotePackage: /<remotePackage\b[\s\S]*?<\/remotePackage>/g,
  archive: /<archive>[\s\S]*?<\/archive>/g,
  license: /<license\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/license>/g,
};

function tag(source: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(source);
  return match ? match[1].trim() : null;
}

/**
 * The archives of one package, each with its own host-os.
 *
 * Split into blocks *before* looking inside them. A single lazy pattern like
 * `<archive>[\s\S]*?<host-os>windows</host-os>[\s\S]*?</archive>` looks right and is wrong: it
 * happily spans from the first `<archive>` across the intervening ones to reach the Windows
 * host-os, and the `<url>` read out of that span is the *first* archive's — the Linux one. That
 * produced a manifest lookup which cheerfully returned `platform-tools_r37.0.1-linux.zip` for a
 * Windows host.
 */
function archivesOf(packageBlock: string): string[] {
  return packageBlock.match(BLOCK.archive) ?? [];
}

/**
 * Picks the archive for this host.
 *
 * A missing `<host-os>` means the package is platform-independent — `platforms;android-30` is one —
 * so it is a valid match for every host rather than a match for none.
 */
function selectArchive(archives: string[], host: HostOs): string | null {
  const exact = archives.find((archive) => tag(archive, 'host-os') === host);
  if (exact) return exact;
  const universal = archives.find((archive) => tag(archive, 'host-os') === null);
  return universal ?? null;
}

/** Relative URLs are resolved against the directory the manifest itself came from. */
export function resolveUrl(manifestUrl: string, relative: string): string {
  if (/^https?:\/\//i.test(relative)) return relative;
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  return base + relative.replace(/^\/+/, '');
}

export function parseRepository(xml: string, host: HostOs, manifestUrl: string): ParsedRepository {
  const licenses = new Map<string, SdkLicense>();
  for (const match of xml.matchAll(BLOCK.license)) {
    licenses.set(match[1], { id: match[1], text: decodeEntities(match[2].trim()) });
  }

  const packages = new Map<string, SdkArchive>();
  for (const match of xml.match(BLOCK.remotePackage) ?? []) {
    const path = /<remotePackage\s+path="([^"]+)"/.exec(match)?.[1];
    if (!path) continue;

    const archive = selectArchive(archivesOf(match), host);
    if (!archive) continue;

    // `<complete>` rather than `<patches>`: a patch archive is a delta against a specific older
    // revision, which is useless when starting from nothing.
    const complete = /<complete>[\s\S]*?<\/complete>/.exec(archive)?.[0] ?? archive;

    const url = tag(complete, 'url');
    const size = Number(tag(complete, 'size') ?? 0);
    const sha1 = tag(complete, 'checksum');
    if (!url || !sha1 || !Number.isFinite(size) || size <= 0) continue;

    packages.set(path, {
      path,
      displayName: tag(match, 'display-name') ?? path,
      url: resolveUrl(manifestUrl, url),
      sizeBytes: size,
      sha1: sha1.toLowerCase(),
      licenseId: /<uses-license\s+ref="([^"]+)"/.exec(match)?.[1] ?? null,
    });
  }

  return { packages, licenses };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The manifest for the main SDK, and the one for system images. */
export const REPOSITORY_URL = 'https://dl.google.com/android/repository/repository2-3.xml';
export const SYS_IMG_URL = 'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml';
export const SYS_IMG_GOOGLE_APIS_URL =
  'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml';
export const SYS_IMG_PLAYSTORE_URL =
  'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml';

/** Which system-image manifest carries a given profile's image tag. */
export function sysImgManifestFor(imageTag: string): string {
  if (imageTag === 'google_apis') return SYS_IMG_GOOGLE_APIS_URL;
  if (imageTag === 'google_apis_playstore') return SYS_IMG_PLAYSTORE_URL;
  return SYS_IMG_URL;
}

export function hostOsForPlatform(platform: NodeJS.Platform = process.platform): HostOs {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macosx';
  return 'linux';
}
