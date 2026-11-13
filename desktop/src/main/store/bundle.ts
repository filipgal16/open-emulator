import path from 'path';
import { PROFILES } from '../../shared/device-types';
import { readZipDirectory, readZipEntry, type ZipEntry } from './zip-archive';

/**
 * Game bundles: `.xapk` (APKPure, APKCombo) and `.apks` (SAI), as well as plain `.apk`.
 *
 * Both bundle formats are a zip holding a base APK and the split APKs Play would normally have
 * picked for the phone — one per processor type, screen density and language, plus asset packs —
 * and an XAPK can also carry OBB data files and a `manifest.json` describing them. Installing one
 * means doing Play's picking ourselves: the base, every language/density/asset split, and the
 * native-code split for exactly one processor type this guest can run, all handed to the package
 * manager in a single session.
 *
 * Every message thrown from here as a `PackageFileError` is shown to the person who chose the
 * file, so it is phrased for them and says what to do, never what the format calls things.
 */

export const PACKAGE_EXTENSIONS = ['.apk', '.xapk', '.apks'] as const;

/** `manifest.json` is a few kilobytes; anything far larger is not the file it claims to be. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** An Android package name, for checking the ones that arrive inside a downloaded file. */
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export class PackageFileError extends Error {}

export interface BundleManifest {
  packageName: string | null;
  name: string | null;
  versionName: string | null;
  versionCode: number | null;
  splits: Array<{ file: string; id: string }>;
  /** OBB data files: where each sits in the archive, and where the manifest says it belongs. */
  expansions: Array<{ file: string; installPath: string }>;
}

export interface AppBundle {
  kind: 'bundle';
  /** The top-level `.apk` members. */
  apks: ZipEntry[];
  /** Every member, for finding expansion files, which live in subdirectories. */
  entries: ZipEntry[];
  manifest: BundleManifest | null;
}

export type PackageFile = { kind: 'apk' } | AppBundle;

export function hasPackageExtension(filePath: string): boolean {
  return (PACKAGE_EXTENSIONS as readonly string[]).includes(path.extname(filePath).toLowerCase());
}

/** A file name with any of the three extensions removed, for showing to people. */
export function packageFileLabel(filePath: string): string {
  const base = path.basename(filePath);
  return hasPackageExtension(base) ? base.slice(0, -path.extname(base).length) : base;
}

function isTopLevelApk(name: string): boolean {
  return !name.includes('/') && !name.includes('\\') && name.toLowerCase().endsWith('.apk');
}

/**
 * Decides what a file is from its contents, not only its name.
 *
 * An APK is itself a zip, so the extension cannot be the whole story: an XAPK renamed to `.apk` is
 * common on download sites, and a plain APK renamed to `.xapk` turns up too. What separates them is
 * unambiguous — an APK has `AndroidManifest.xml` at its root, a bundle has APKs there instead.
 */
export function inspectPackageFile(filePath: string): PackageFile {
  if (!hasPackageExtension(filePath)) {
    throw new PackageFileError('Only Android app files (.apk, .xapk or .apks) can be installed.');
  }

  let entries: ZipEntry[];
  try {
    entries = readZipDirectory(filePath);
  } catch {
    throw new PackageFileError('This file isn’t an Android app, or it is damaged.');
  }

  if (entries.some((entry) => entry.name === 'AndroidManifest.xml')) return { kind: 'apk' };

  const apks = entries.filter((entry) => isTopLevelApk(entry.name));
  if (apks.length === 0) throw new PackageFileError('This file isn’t an Android app, or it is damaged.');

  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  let manifest: BundleManifest | null = null;
  if (manifestEntry) {
    try {
      manifest = parseBundleManifest(readZipEntry(filePath, manifestEntry, MAX_MANIFEST_BYTES).toString('utf8'));
    } catch {
      // The manifest only refines choices the APK names already allow, so an unreadable one is
      // ignored rather than fatal.
      manifest = null;
    }
  }

  return { kind: 'bundle', apks, entries, manifest };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * XAPK's `manifest.json`, version 2. Tolerant: every field is optional, and a field of the wrong
 * type is dropped rather than failing the whole file — download sites write these by hand.
 */
export function parseBundleManifest(text: string): BundleManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const versionCode = Number(record.version_code);
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];

  return {
    packageName: stringOrNull(record.package_name),
    name: stringOrNull(record.name),
    versionName: stringOrNull(record.version_name),
    versionCode: Number.isSafeInteger(versionCode) && versionCode > 0 ? versionCode : null,
    splits: list(record.split_apks).flatMap((item) => {
      const file = stringOrNull(item.file);
      const id = stringOrNull(item.id);
      return file && id ? [{ file, id }] : [];
    }),
    expansions: list(record.expansions).flatMap((item) => {
      const file = stringOrNull(item.file);
      const installPath = stringOrNull(item.install_path);
      return file && installPath ? [{ file, installPath }] : [];
    }),
  };
}

/** How split names spell processor types (`arm64_v8a`) against how the guest does (`arm64-v8a`). */
const ABI_TOKENS: Record<string, string> = {
  armeabi: 'armeabi',
  armeabi_v7a: 'armeabi-v7a',
  arm64_v8a: 'arm64-v8a',
  x86: 'x86',
  x86_64: 'x86_64',
  mips: 'mips',
  mips64: 'mips64',
};

const CONFIG_SPLIT = /^(?:split_)?config\.([^.]+)\.apk$/i;

/** The processor type a split carries native code for, or null for any other kind of split. */
export function splitAbi(fileName: string): string | null {
  const match = CONFIG_SPLIT.exec(fileName);
  if (!match) return null;
  return ABI_TOKENS[match[1].toLowerCase()] ?? null;
}

/** `ro.product.cpu.abilist`, in the guest's own order of preference. */
export function parseAbiList(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((abi) => abi.trim())
    .filter((abi) => abi.length > 0);
}

interface NamedSize {
  name: string;
  size: number;
}

/**
 * Which APK is the app itself, as opposed to one of its splits.
 *
 * Asked in order of how much the answer can be trusted: the manifest naming it, the `<package>.apk`
 * convention XAPK uses, the `base.apk` convention SAI and bundletool use, and only then a guess
 * among whatever is not a config split — a name shaped like a package first (the XAPK convention
 * with its manifest missing), then the largest, since asset packs aside the base is where the
 * code lives.
 */
export function findBase(apks: NamedSize[], manifest: BundleManifest | null): string | null {
  const names = new Set(apks.map((apk) => apk.name));
  const declared = manifest?.splits.find((split) => split.id === 'base')?.file;
  if (declared && names.has(declared)) return declared;
  if (manifest?.packageName && names.has(`${manifest.packageName}.apk`)) return `${manifest.packageName}.apk`;
  if (names.has('base.apk')) return 'base.apk';

  const candidates = apks.filter((apk) => !CONFIG_SPLIT.test(apk.name));
  const unsplit = candidates.filter((apk) => !/^split_/i.test(apk.name));
  const packageShaped = unsplit.filter((apk) => PACKAGE_NAME.test(apk.name.slice(0, -'.apk'.length)));
  const pool = [packageShaped, unsplit, candidates].find((group) => group.length > 0);
  if (!pool) return null;
  return [...pool].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))[0].name;
}

export interface BundleSelection {
  base: string;
  /** Every APK to install, base first. */
  apks: string[];
  /** The processor type whose native code was chosen, or null when the bundle carries none. */
  abi: string | null;
}

function noMatchingAbiMessage(bundleAbis: string[]): string {
  if (bundleAbis.every((abi) => abi.startsWith('arm'))) {
    return (
      'This app is built for ARM phones, and this Android version can’t run those. ' +
      `Switch to “${PROFILES['openemu-compat'].label}” in the Android version menu, then try again.`
    );
  }
  return 'This app is built for a different kind of phone, and this Android version can’t run it.';
}

/**
 * Picks the APKs this guest should get.
 *
 * Everything except native-code splits is installed: languages and densities the guest will not
 * use cost some disk, while leaving out one it does use breaks the app. Native code is the one
 * place a wrong pick fails the install outright, so exactly one processor type is chosen — the
 * first in the guest's own preference order that the bundle has.
 */
export function selectApks(apks: NamedSize[], manifest: BundleManifest | null, guestAbis: string[]): BundleSelection {
  const base = findBase(apks, manifest);
  if (!base) throw new PackageFileError('This file doesn’t contain the app itself, only parts of it.');

  const abiSplits = new Map<string, string[]>();
  const others: string[] = [];
  for (const apk of apks) {
    if (apk.name === base) continue;
    const abi = splitAbi(apk.name);
    if (abi) abiSplits.set(abi, [...(abiSplits.get(abi) ?? []), apk.name]);
    else others.push(apk.name);
  }
  others.sort((a, b) => a.localeCompare(b));

  if (abiSplits.size === 0) return { base, apks: [base, ...others], abi: null };

  const abi = guestAbis.find((candidate) => abiSplits.has(candidate));
  if (!abi) throw new PackageFileError(noMatchingAbiMessage([...abiSplits.keys()]));
  return { base, apks: [base, ...others, ...abiSplits.get(abi)!], abi };
}

const OBB_FILE_NAME = /^[A-Za-z0-9._-]+$/;

export interface ExpansionPlan {
  entry: ZipEntry;
  /** Absolute path in the guest. */
  guestPath: string;
}

/**
 * Where each OBB in the manifest goes: `/sdcard/Android/obb/<package>/<file>`, which is the one
 * place a game looks for them.
 *
 * Only the file name is taken from the manifest's install path, and both it and the package name
 * are checked against a strict pattern — they come from a downloaded file and end up as a path on
 * the guest's storage. An entry that fails the check, or names a member the archive does not
 * have, is skipped.
 */
export function planExpansions(bundle: AppBundle, packageName: string | null): ExpansionPlan[] {
  if (!packageName || !PACKAGE_NAME.test(packageName) || !bundle.manifest) return [];
  const plans: ExpansionPlan[] = [];
  for (const expansion of bundle.manifest.expansions) {
    const entry = bundle.entries.find((candidate) => candidate.name === expansion.file);
    const fileName = expansion.installPath.split(/[\\/]/).pop() ?? '';
    if (!entry || !OBB_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') continue;
    plans.push({ entry, guestPath: `/sdcard/Android/obb/${packageName}/${fileName}` });
  }
  return plans;
}

const INSTALL_FLOOR_MS = 10 * 60_000;
const INSTALL_CEILING_MS = 60 * 60_000;
/**
 * A 2.7 GB bundle took 66–76 s to push into a guest when measured, about 40 MB/s. A quarter of
 * that leaves room for a slower disk and for the package manager's own work after the copy.
 */
const ASSUMED_BYTES_PER_SECOND = 10 * 1024 * 1024;

/** How long to give one install of `totalBytes`, proportional to its size within sane bounds. */
export function installTimeoutMs(totalBytes: number): number {
  const proportional = Math.ceil(totalBytes / ASSUMED_BYTES_PER_SECOND) * 1000;
  return Math.min(INSTALL_CEILING_MS, Math.max(INSTALL_FLOOR_MS, proportional));
}
