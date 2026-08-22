import { ImageCache, type ImageCacheOptions } from '../image-cache';

export { sniffImageMime } from '../image-cache';

export const AD_SCHEME = 'oe-ad';

export type CreativeCacheOptions = Omit<ImageCacheOptions, 'scheme' | 'host'>;

/**
 * Campaign art, downloaded in the main process and served to the renderer as `oe-ad://creative/<id>`.
 *
 * All of the mechanism — byte sniffing, https-only, single-flight downloads, hex-only ids — lives
 * in `ImageCache`, which the app store's icon cache shares. This subclass exists to pin the scheme
 * so no caller has to remember it, and to keep `oe-ad` an ads-owned name.
 */
export class CreativeCache extends ImageCache {
  constructor(dir: string, options: CreativeCacheOptions = {}) {
    super(dir, { ...options, scheme: AD_SCHEME, host: 'creative' });
  }
}
