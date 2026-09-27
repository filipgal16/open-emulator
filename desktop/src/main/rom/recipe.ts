import { createHash } from 'crypto';
import { checkIdentity, checkProp } from './build-prop';
import type { RomIdentity } from './build-prop';

/**
 * The openemu ROM, as data: what the builder removes, renames and adds on top of Google's AOSP
 * `default` API 30 image. `design/openemu-rom.md` ("Recipe v1") is where each choice is argued;
 * this file is where it is pinned.
 *
 * Paths are **in-volume**: each logical partition is its own ext4, opened on its own. The system
 * volume is system-as-root — its tree starts at `/` with the content under `/system/...` — while
 * system_ext, product and vendor are mounted at their own root, so their apps are `/app/...`, not
 * `/product/app/...`. Mixing the two up removes nothing and still reports success, which is what
 * `validateRecipe` refuses.
 */

export type VolumeName = 'system' | 'system_ext' | 'product' | 'vendor';

export const VOLUMES: readonly VolumeName[] = ['system', 'system_ext', 'product', 'vendor'];

export interface RomFile {
  volume: VolumeName;
  /** In-volume path; see the module comment. */
  path: string;
  kind: 'dir' | 'file';
  /** Permission bits only (`0o755`); the type comes from `kind`. */
  mode: number;
  /** The `security.selinux` label. Unlabeled, init is not allowed to read the file on enforcing. */
  selinux: string;
  /** Where a file's bytes come from; a file without one is created empty. */
  source?: 'wallpaper';
}

export interface RomRecipe {
  id: 'openemu';
  /** Bumped for any change to what the image contains; it shows in the build number. */
  version: number;
  displayName: string;
  baseTag: 'default';
  apiLevel: 30;
  identity: RomIdentity;
  buildPropPath: Record<VolumeName, string>;
  /** In-volume directories to remove, whole. Run first, so the space is there for `files`. */
  debloat: Record<VolumeName, string[]>;
  /** Upserted into the system volume's `build.prop`. */
  systemProps: Record<string, string>;
  /** Created in order, after debloat — a directory before anything inside it. */
  files: RomFile[];
}

/**
 * Bumped whenever the builder changes how it applies a recipe — a different edit order, a fixed
 * ext4 bug, another file rewritten — without the recipe itself changing.
 *
 * It is hashed with the recipe, because "up to date" is decided by the hash: without it, an image
 * built by a broken builder would count as current forever after the fix shipped.
 */
// 2: the ROM id became a build id over recipe, base and vbmeta, not the vbmeta digest alone.
export const BUILDER_REVISION = 2;

// ── Recipe v1 ─────────────────────────────────────────────────────────────────────────────────

const VERSION = 1;

const SYSTEM_FILE = 'u:object_r:system_file:s0';

/**
 * The system volume is rooted at `/`, so this in-volume path is also the path Android sees — which
 * is what `ro.config.wallpaper` has to name.
 */
const MEDIA_DIR = '/system/media';
const WALLPAPER_DIR = `${MEDIA_DIR}/openemu`;
const WALLPAPER = `${WALLPAPER_DIR}/wallpaper.png`;

const under = (dir: string, names: string[]): string[] => names.map((name) => `${dir}/${name}`);

/**
 * Apps the recipe must never remove, and why. A test holds `debloat` to this.
 *
 * `PartnerBookmarksProvider` is the one provider that goes: it only supplies a partner's preset
 * bookmarks, and nothing on this image has any.
 */
export const KEPT: Readonly<Record<string, string>> = {
  BookmarkProvider: 'Browser2 and QuickSearchBox query it; without it the browser and search suggestions break',
  PrintSpooler: 'PrintManagerService binds the spooler',
  Camera2: 'ACTION_IMAGE_CAPTURE needs a handler',
  WallpaperPicker: "the launcher's wallpaper entry opens the picker",
  WallpaperCropper: 'the picker hands the chosen image to the cropper',
  WallpaperBackup: "backs up the user's wallpaper; harmless, and not worth a fight",
  CalendarProvider: 'removing the Calendar app does not remove its provider, which other apps use',
  ContactsProvider: 'removing the Contacts app does not remove its provider, which telephony and other apps use',
  TelephonyProvider: "telephony's own data; the framework starts it regardless of the apps removed",
  BlockedNumberProvider: 'Telecom checks incoming calls against it',
  SettingsProvider: 'Settings.System/Secure/Global live in it; without it nothing boots',
  DownloadProvider: 'DownloadManager is a framework API any app may call',
  TeleService: 'com.android.phone; the framework starts it regardless of the apps removed',
  Telecom: 'call routing in the framework; runs whether or not a dialer is installed',
};

export const OPENEMU_RECIPE: RomRecipe = deepFreeze({
  id: 'openemu',
  version: VERSION,
  displayName: 'open-emulator Android',
  baseTag: 'default',
  apiLevel: 30,
  identity: {
    brand: 'open-emulator',
    manufacturer: 'open-emulator',
    model: 'OpenEmulator One',
    name: 'openemu_x86_64',
    device: 'openemu',
    displayId: `open-emulator Android 11 (openemu ${VERSION})`,
    // The build this was made from: release, build id, incremental, type and tags are the stock
    // image's and stay honest. If Google republishes `default` under another build id, this line
    // is the one to update with it.
    description: 'openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys',
    buildProduct: 'openemu',
  },
  buildPropPath: {
    system: '/system/build.prop',
    system_ext: '/build.prop',
    product: '/build.prop',
    vendor: '/build.prop',
  },
  debloat: {
    system: [
      // Screensavers, the easter egg, live wallpapers, Bluetooth MIDI, IMS presence and RCS, SIM
      // toolkit screens, print recommendations and the tracing tool: user-facing extras, or
      // services for hardware and carrier features the emulator does not have. None is needed to
      // boot; the framework looks the MIDI and print-recommendation services up only on demand.
      // NfcNci goes because the stock image declares no `android.hardware.nfc` feature (checked
      // on a boot), so SystemServer never starts NfcService. PartnerBookmarksProvider only serves
      // a partner's preset bookmarks; BookmarkProvider, which Browser2 uses, stays.
      ...under('/system/app', [
        'BasicDreams',
        'BluetoothMidiService',
        'EasterEgg',
        'LiveWallpapersPicker',
        'NfcNci',
        'PartnerBookmarksProvider',
        'PresencePolling',
        'PrintRecommendationService',
        'RcsService',
        'SimAppDialog',
        'Stk',
        'Traceur',
      ]),
      // The default print plugin (the spooler stays), the call-log backup agent (no dialer left to
      // log calls), legacy cell broadcast, the GSI installer (DSU), the effects panel for the
      // removed Music app, the opportunistic network service (multi-SIM carrier switching) and the
      // NFC tag viewer. The verification boot checks that system_server stays up without them.
      ...under('/system/priv-app', [
        'BuiltInPrintService',
        'CallLogBackup',
        'CellBroadcastLegacyApp',
        'DynamicSystemInstallationService',
        'MusicFX',
        'ONS',
        'Tag',
      ]),
    ],
    system_ext: [
      // The emergency information screen, a phone feature with no use on a desktop emulator.
      ...under('/priv-app', ['EmergencyInfo']),
    ],
    product: [
      // Bundled user apps. Their data lives in providers under other directory names
      // (CalendarProvider, MediaProvider), which stay; nothing binds these by package.
      // Without `messaging` there is no default SMS app, which this emulator does not need.
      ...under('/app', ['Calendar', 'DeskClock', 'Gallery2', 'Music', 'PhotoTable', 'messaging']),
      // ContactsProvider stays. Without a dialer Telecom logs a missing default dialer and keeps
      // running; there is no in-call UI, which is accepted here.
      ...under('/priv-app', ['Contacts', 'Dialer']),
    ],
    // Nothing: vendor holds the goldfish HALs and one free inode.
    vendor: [],
  },
  systemProps: {
    'ro.openemu.rom': '1',
    'ro.openemu.rom.version': String(VERSION),
    // Applies only when a user has no wallpaper file yet, so it shows on fresh AVDs, not upgrades.
    'ro.config.wallpaper': WALLPAPER,
  },
  files: [
    // This image keeps its media under /product/media; /system/media, the usual AOSP home for
    // boot animations and wallpapers, does not exist on it, so the ROM makes it.
    { volume: 'system', path: MEDIA_DIR, kind: 'dir', mode: 0o755, selinux: SYSTEM_FILE },
    { volume: 'system', path: WALLPAPER_DIR, kind: 'dir', mode: 0o755, selinux: SYSTEM_FILE },
    { volume: 'system', path: WALLPAPER, kind: 'file', mode: 0o644, selinux: SYSTEM_FILE, source: 'wallpaper' },
  ],
});

// ── Hash ──────────────────────────────────────────────────────────────────────────────────────

/**
 * What decides whether a built image is current: sha256 over the recipe, `BUILDER_REVISION`, and
 * the sha256 of every content a file is built from.
 *
 * The serialisation sorts object keys, so reordering a literal does not force a 3 GB rebuild;
 * arrays keep their order, because the order of `files` is the order they are created in. Content
 * the recipe does not use is ignored. `builderRevision` is there for tests; the builder never
 * passes it.
 */
export function recipeHash(
  recipe: RomRecipe,
  contents: Record<string, Buffer>,
  builderRevision: number = BUILDER_REVISION,
): string {
  const sources: Record<string, string> = {};
  for (const file of recipe.files) {
    if (file.source === undefined) continue;
    const content = Object.prototype.hasOwnProperty.call(contents, file.source) ? contents[file.source] : undefined;
    if (!Buffer.isBuffer(content)) {
      throw new Error(`${file.volume}:${file.path} is built from '${file.source}', and no content was given for it`);
    }
    sources[file.source] = sha256(content);
  }
  return sha256(Buffer.from(canonical({ builderRevision, recipe, sources }), 'utf8'));
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted and `undefined` members dropped: one text per value. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot hash the number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error(`cannot hash a ${typeof value}`);
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────

/**
 * Directories new files may go into without declaring them: measured on the stock volumes, not
 * assumed. `/system` is a linear directory of 17 entries in one block on the stock system volume.
 * Adding one here is a claim about Google's image, so it needs a measurement behind it — an
 * earlier revision listed `/system/media`, which that image does not have.
 */
const STOCK_DIRS: Record<VolumeName, readonly string[]> = {
  system: ['/system'],
  system_ext: [],
  product: [],
  vendor: [],
};

/**
 * Throws, naming the entry, if the recipe could not be applied as written. Run before a build
 * touches anything, so a bad recipe costs no 3 GB copy.
 */
export function validateRecipe(recipe: RomRecipe): void {
  if (!Number.isInteger(recipe.version) || recipe.version < 1) throw new Error(`recipe version ${recipe.version} is not a positive integer`);
  checkIdentity(recipe.identity);
  for (const [key, value] of Object.entries(recipe.systemProps)) checkProp(key, value);

  const removed = new Set<string>();
  for (const volume of VOLUMES) {
    checkPath(volume, recipe.buildPropPath[volume], 'build.prop');
    const list = recipe.debloat[volume];
    if (!Array.isArray(list)) throw new Error(`debloat has no list for ${volume}`);
    for (const target of list) {
      checkPath(volume, target, 'debloat path');
      const id = `${volume}:${target}`;
      if (removed.has(id)) throw new Error(`debloat path ${id} is listed twice`);
      removed.add(id);
    }
  }

  // Debloat runs before anything else, so a removed path that is — or contains — something the
  // recipe then edits or creates would leave the builder editing a file that no longer exists.
  const removedAncestor = (volume: VolumeName, target: string): string | null => {
    for (let p = target; p !== ''; p = p.slice(0, p.lastIndexOf('/'))) {
      if (removed.has(`${volume}:${p}`)) return p;
    }
    return null;
  };

  for (const volume of VOLUMES) {
    const gone = removedAncestor(volume, recipe.buildPropPath[volume]);
    if (gone !== null) throw new Error(`${volume}:${recipe.buildPropPath[volume]} is rewritten, but debloat removes ${gone}`);
  }

  const created = new Map<string, RomFile>();
  for (const file of recipe.files) {
    if (!VOLUMES.includes(file.volume)) throw new Error(`file ${file.path} is on unknown volume '${file.volume}'`);
    checkPath(file.volume, file.path, 'file');
    const id = `${file.volume}:${file.path}`;
    if (created.has(id)) throw new Error(`file ${id} is listed twice`);

    const gone = removedAncestor(file.volume, file.path);
    if (gone !== null) {
      throw new Error(gone === file.path
        ? `${id} is both removed by debloat and created as a file`
        : `${id} is created inside ${gone}, which debloat removes`);
    }

    const parent = file.path.slice(0, file.path.lastIndexOf('/'));
    const declared = created.get(`${file.volume}:${parent}`);
    if (declared ? declared.kind !== 'dir' : !STOCK_DIRS[file.volume].includes(parent)) {
      throw new Error(`${id}: its parent ${parent} is neither a known stock directory nor a directory declared before it`);
    }

    if (file.kind !== 'dir' && file.kind !== 'file') throw new Error(`${id}: unknown kind '${file.kind}'`);
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) {
      const shown = typeof file.mode === 'number' ? `0o${file.mode.toString(8)}` : String(file.mode);
      throw new Error(`${id}: mode ${shown} is not permission bits alone — the type comes from kind`);
    }
    if (file.kind === 'dir' && file.source !== undefined) throw new Error(`${id} is a directory and cannot have content`);
    if (!/^u:object_r:[a-z0-9_]+:s0$/.test(file.selinux)) throw new Error(`${id}: '${file.selinux}' is not an SELinux file label`);

    created.set(id, file);
  }
}

/**
 * An in-volume path must be absolute and normalised — the ext4 editor looks names up one
 * component at a time, and `.`, `..` or an empty component are not names it will find — and must
 * have the shape its volume has (see the module comment).
 */
function checkPath(volume: VolumeName, target: string, what: string): void {
  if (typeof target !== 'string' || !target.startsWith('/')) {
    throw new Error(`${what} ${volume}:${String(target)} is not absolute`);
  }
  if (!/^(\/[^/\0]+)+$/.test(target) || target.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`${what} ${volume}:${target} is not normalised`);
  }
  const inSystem = target.startsWith('/system/');
  if (volume === 'system' && !inSystem) {
    throw new Error(`${what} system:${target} is outside /system/ — the system volume is rooted at / with its content under /system/`);
  }
  if (volume !== 'system' && inSystem) {
    throw new Error(`${what} ${volume}:${target} starts with /system/, but ${volume} is mounted at its own root`);
  }
}

/**
 * The recipe is module state shared by everything in the process, and its hash decides whether a
 * rebuild happens. Frozen, a caller that sorts or pushes onto one of its lists fails at that line
 * instead of silently changing the hash for every later caller.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}
