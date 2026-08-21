import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export const AD_SCHEME = 'oe-ad';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Magic-byte signatures for the formats we will serve.
 *
 * The `Content-Type` header is *not* trusted for this. A hostile or compromised CDN can label
 * anything `image/png`; sniffing the actual bytes is what stops a non-image ever reaching the
 * renderer, and it's also how the protocol handler decides what MIME to serve back.
 */
const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a' },
  {
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return SIGNATURES.find((s) => s.test(bytes))?.mime ?? null;
}

export interface CreativeCacheOptions {
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

/**
 * Downloads campaign art in the main process and serves it to the renderer over the custom
 * `oe-ad://` scheme.
 *
 * This is what lets the app window keep a `default-src 'self'` CSP with no remote origins at all.
 * The renderer never learns the CDN hostname, issues no cross-origin request, and therefore
 * cannot be fingerprinted or tracked by an ad host — the main process is the only thing that
 * ever talks to one.
 */
export class CreativeCache {
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;

  constructor(private readonly dir: string, options: CreativeCacheOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
  }

  static idFor(imageUrl: string): string {
    return createHash('sha256').update(imageUrl).digest('hex').slice(0, 32);
  }

  /** Absolute path for a cached id, or null if the id is malformed or nothing is stored. */
  pathFor(id: string): string | null {
    // Hex-only ids make directory traversal impossible by construction — no path joining of
    // attacker-controlled text ever reaches the filesystem.
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    const file = path.join(this.dir, id);
    return existsSync(file) ? file : null;
  }

  /** Reads a cached creative for the protocol handler, with the MIME sniffed from its bytes. */
  read(id: string): { bytes: Buffer; mime: string } | null {
    const file = this.pathFor(id);
    if (!file) return null;
    try {
      const bytes = readFileSync(file);
      const mime = sniffImageMime(bytes);
      return mime ? { bytes, mime } : null;
    } catch {
      return null;
    }
  }

  /** `oe-ad://` URL if the art is already on disk, else null — callers render text-only. */
  urlIfReady(imageUrl: string): string | null {
    const id = CreativeCache.idFor(imageUrl);
    return this.pathFor(id) ? `${AD_SCHEME}://creative/${id}` : null;
  }

  /**
   * Downloads if needed and resolves to the `oe-ad://` URL, or null when the art can't be used.
   * Never throws: a creative that fails to fetch degrades to text, it doesn't break the slot.
   */
  async ensure(imageUrl: string): Promise<string | null> {
    const ready = this.urlIfReady(imageUrl);
    if (ready) return ready;

    const id = CreativeCache.idFor(imageUrl);
    const existing = this.pending.get(id);
    if (existing) return existing;

    const job = this.download(imageUrl, id).finally(() => this.pending.delete(id));
    this.pending.set(id, job);
    return job;
  }

  /** Warms the cache so creatives don't pop in a beat after the text. Failures are ignored. */
  async prefetch(imageUrls: string[]): Promise<void> {
    await Promise.all(imageUrls.map((url) => this.ensure(url).catch(() => null)));
  }

  private async download(imageUrl: string, id: string): Promise<string | null> {
    try {
      if (new URL(imageUrl).protocol !== 'https:') throw new Error('not https');

      const response = await this.fetchImpl(imageUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`too large (${bytes.length} bytes)`);
      if (!sniffImageMime(bytes)) throw new Error('not a recognised image');

      mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `${id}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, path.join(this.dir, id));
      return `${AD_SCHEME}://creative/${id}`;
    } catch (err) {
      this.onLog(`creative fetch failed (${imageUrl}): ${(err as Error).message}`);
      return null;
    }
  }
}
