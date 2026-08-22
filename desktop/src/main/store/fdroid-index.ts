/**
 * Turns F-Droid's `index-v2.json` into something small enough to keep in memory and search on
 * every keystroke.
 *
 * The published index is tens of megabytes and carries per-locale text, build metadata, and full
 * permission lists for every version of every app. Keeping that around would cost hundreds of MB
 * of heap for a grid that shows six fields. So the index is *distilled* once on download — one
 * locale, the fields the UI actually renders, and a handful of recent versions per app — and only
 * the distillate is cached and reloaded.
 *
 * Pure: no fs, no fetch, no electron. `sources/fdroid.ts` owns the I/O around it.
 */

export interface IndexFile {
  /** Repo-relative, always starting with `/` — join onto `repoAddress` for a URL. */
  name: string;
  sha256: string;
  size: number;
}

export interface IndexVersion {
  versionName: string;
  versionCode: number;
  minSdk: number;
  added: number;
  file: IndexFile;
  /** Native ABIs this build ships. Empty means pure bytecode, which runs on any guest. */
  abis: string[];
  antiFeatures: string[];
}

export interface IndexApp {
  packageName: string;
  name: string;
  summary: string;
  description: string;
  license: string | null;
  categories: string[];
  webSite: string | null;
  sourceCode: string | null;
  lastUpdated: number;
  iconPath: string | null;
  screenshotPaths: string[];
  /** Newest first, capped at MAX_VERSIONS. */
  versions: IndexVersion[];
}

export interface DistilledIndex {
  repoAddress: string;
  timestamp: number;
  apps: IndexApp[];
}

export const EMPTY_INDEX: DistilledIndex = { repoAddress: '', timestamp: 0, apps: [] };

/** Enough for the detail pane's version picker without carrying an app's whole history. */
const MAX_VERSIONS = 6;
const MAX_SCREENSHOTS = 6;
const MAX_DESCRIPTION = 4000;
const PREFERRED_LOCALES = ['en-US', 'en_US', 'en-GB', 'en'];

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Picks one language out of a `{ locale: value }` map.
 *
 * Falls back to *any* locale rather than nothing: an app whose metadata exists only in German is
 * still worth listing under its own name, and the alternative is a blank tile.
 */
export function pickLocalized<T = unknown>(field: unknown, locales: string[] = PREFERRED_LOCALES): T | null {
  if (!isRec(field)) return null;
  for (const locale of locales) {
    if (field[locale] !== undefined) return field[locale] as T;
  }
  const first = Object.values(field)[0];
  return first === undefined ? null : (first as T);
}

/** F-Droid descriptions carry a restricted subset of HTML; the detail pane renders plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '\n• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseFile(raw: unknown): IndexFile | null {
  if (!isRec(raw)) return null;
  const name = asString(raw.name);
  const sha256 = asString(raw.sha256);
  // A version with no digest is dropped outright. The hash is the only thing that makes the
  // download verifiable, and installing an unverifiable APK is not a degraded mode worth having.
  if (!name || !sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  return { name, sha256: sha256.toLowerCase(), size: asNumber(raw.size) ?? 0 };
}

function parseVersion(raw: unknown): IndexVersion | null {
  if (!isRec(raw)) return null;
  const file = parseFile(raw.file);
  if (!file) return null;

  const manifest = isRec(raw.manifest) ? raw.manifest : {};
  const versionCode = asNumber(manifest.versionCode);
  if (versionCode === null) return null;

  const usesSdk = isRec(manifest.usesSdk) ? manifest.usesSdk : {};
  const antiFeatures = isRec(raw.antiFeatures) ? Object.keys(raw.antiFeatures) : [];

  return {
    versionName: asString(manifest.versionName) ?? String(versionCode),
    versionCode,
    // No declared minimum means "any" — API 1 is the platform's own default.
    minSdk: asNumber(usesSdk.minSdkVersion) ?? 1,
    added: asNumber(raw.added) ?? 0,
    file,
    abis: asArray(manifest.nativecode).filter((abi): abi is string => typeof abi === 'string'),
    antiFeatures,
  };
}

function parseApp(packageName: string, raw: unknown): IndexApp | null {
  if (!isRec(raw)) return null;
  const metadata = isRec(raw.metadata) ? raw.metadata : {};

  const versions = Object.values(isRec(raw.versions) ? raw.versions : {})
    .map(parseVersion)
    .filter((version): version is IndexVersion => version !== null)
    .sort((a, b) => b.versionCode - a.versionCode)
    .slice(0, MAX_VERSIONS);

  // Nothing installable, nothing to list.
  if (versions.length === 0) return null;

  const icon = pickLocalized<Rec>(metadata.icon);
  const screenshots = isRec(metadata.screenshots) ? metadata.screenshots : {};
  const phoneShots = pickLocalized<unknown[]>(screenshots.phone) ?? pickLocalized<unknown[]>(Object.values(screenshots)[0]);

  const description = pickLocalized<string>(metadata.description);

  return {
    packageName,
    name: pickLocalized<string>(metadata.name)?.trim() || packageName,
    summary: pickLocalized<string>(metadata.summary)?.trim() ?? '',
    description: description ? stripHtml(description).slice(0, MAX_DESCRIPTION) : '',
    license: asString(metadata.license),
    categories: asArray(metadata.categories).filter((c): c is string => typeof c === 'string'),
    webSite: asString(metadata.webSite),
    sourceCode: asString(metadata.sourceCode),
    lastUpdated: asNumber(metadata.lastUpdated) ?? versions[0].added,
    iconPath: isRec(icon) ? asString(icon.name) : null,
    screenshotPaths: asArray(phoneShots)
      .map((shot) => (isRec(shot) ? asString(shot.name) : null))
      .filter((name): name is string => name !== null)
      .slice(0, MAX_SCREENSHOTS),
    versions,
  };
}

/**
 * Distills a parsed `index-v2.json`. Malformed apps are skipped rather than failing the whole
 * index — one bad entry upstream must not take the catalogue offline.
 */
export function distillIndex(raw: unknown): DistilledIndex {
  if (!isRec(raw)) return { ...EMPTY_INDEX };
  const repo = isRec(raw.repo) ? raw.repo : {};
  const packages = isRec(raw.packages) ? raw.packages : {};

  const apps: IndexApp[] = [];
  for (const [packageName, entry] of Object.entries(packages)) {
    const app = parseApp(packageName, entry);
    if (app) apps.push(app);
  }
  apps.sort((a, b) => b.lastUpdated - a.lastUpdated);

  return {
    repoAddress: (asString(repo.address) ?? 'https://f-droid.org/repo').replace(/\/+$/, ''),
    timestamp: asNumber(repo.timestamp) ?? 0,
    apps,
  };
}

/** Absolute URL for a repo-relative asset path (icon, screenshot, or APK). */
export function assetUrl(index: Pick<DistilledIndex, 'repoAddress'>, repoPath: string): string {
  return `${index.repoAddress}/${repoPath.replace(/^\/+/, '')}`;
}

/**
 * The version to offer for a given guest.
 *
 * Newest build the guest can actually run, rather than newest overall — offering an APK whose
 * minSdk exceeds the guest produces an install that fails after a multi-megabyte download. When
 * nothing qualifies, the newest is returned anyway so the UI can say *why* it is unavailable.
 */
export function chooseVersion(app: IndexApp, guestSdk: number | null): IndexVersion {
  if (guestSdk === null) return app.versions[0];
  return app.versions.find((version) => version.minSdk <= guestSdk) ?? app.versions[0];
}

const RECENCY_WINDOW_MS = 2 * 365 * 24 * 60 * 60_000;

/** Small tiebreaker so two equally-relevant matches put the maintained one first. */
function recencyBonus(app: IndexApp, now: number): number {
  const age = now - app.lastUpdated;
  if (!Number.isFinite(age) || age < 0 || age > RECENCY_WINDOW_MS) return 0;
  return Math.round(40 * (1 - age / RECENCY_WINDOW_MS));
}

function tokenScore(app: IndexApp, token: string): number {
  const name = app.name.toLowerCase();
  const pkg = app.packageName.toLowerCase();

  if (pkg === token) return 1000;
  if (name === token) return 900;
  if (name.startsWith(token)) return 700;
  // Word-boundary hit inside the name ("pipe" in "News Pipe") beats a mid-word one.
  if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 600;
  if (name.includes(token)) return 450;
  if (pkg.includes(token)) return 300;
  if (app.summary.toLowerCase().includes(token)) return 150;
  if (app.description.toLowerCase().includes(token)) return 40;
  return 0;
}

export interface SearchOptions {
  limit?: number;
  now?: number;
}

/**
 * Ranked search over the distillate.
 *
 * Multi-token queries are AND: every token must hit something, which is what makes "signal
 * messenger" narrow the result rather than widen it. An empty query browses by last update —
 * without download counts there is no popularity signal, and "recently maintained" is the most
 * useful proxy a FOSS catalogue offers.
 */
export function searchIndex(index: DistilledIndex, query: string, options: SearchOptions = {}): IndexApp[] {
  const limit = options.limit ?? 60;
  const now = options.now ?? Date.now();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) return index.apps.slice(0, limit);

  const scored: Array<{ app: IndexApp; score: number }> = [];
  for (const app of index.apps) {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const score = tokenScore(app, token);
      if (score === 0) {
        matchedAll = false;
        break;
      }
      total += score;
    }
    if (matchedAll) scored.push({ app, score: total + recencyBonus(app, now) });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.app.lastUpdated - a.app.lastUpdated)
    .slice(0, limit)
    .map((entry) => entry.app);
}

export function findApp(index: DistilledIndex, packageName: string): IndexApp | null {
  return index.apps.find((app) => app.packageName === packageName) ?? null;
}
