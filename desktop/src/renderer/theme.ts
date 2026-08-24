import type { ThemeChoice } from '../shared/settings-types';

/**
 * Stamp the explicit theme on <html> so the CSS `[data-theme="…"]` rules take effect.
 *
 * `system` must remove the attribute rather than set a value: the stylesheet follows the OS
 * through `prefers-color-scheme` only when `data-theme` is absent. The main process already
 * drives Electron's `nativeTheme`; this is the document-side half, and it has to run on load
 * as well as on change or a saved choice dies at restart.
 */
export function applyDocumentTheme(theme: ThemeChoice): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
