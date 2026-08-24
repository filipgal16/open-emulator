import type { AppLibrary } from '../guest/app-library';
import { isValidPackageName } from '../guest/app-library';
import type { OpenEmuClient } from '../engine/client';

export const PLAY_PACKAGE = 'com.android.vending';

/**
 * Drives the real Play Store app inside the guest.
 *
 * This is the whole of the "Play source": there is no catalogue here, no protobuf client, and no
 * scraped listing. Google's own client renders in the guest, we frame it and forward input, and
 * `market://` intents steer it. That means Play's UI is always current, its installs are real
 * Play installs, and nothing about it can break when Google changes an API we were never calling.
 */
export class PlayController {
  constructor(
    private readonly openEmu: OpenEmuClient,
    private readonly library: AppLibrary,
    private readonly onLog: (message: string) => void = () => undefined,
  ) {}

  /** Brings Play to the foreground. Reuses the launcher-intent path the app grid already uses. */
  async open(): Promise<boolean> {
    try {
      return await this.library.launch(PLAY_PACKAGE);
    } catch (err) {
      this.onLog(`could not open Play: ${(err as Error).message}`);
      return false;
    }
  }

  /** Runs a search inside Play. An empty query just opens the store's front page. */
  async search(query: string): Promise<boolean> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return this.open();
    return this.intent(`market://search?q=${encodeURIComponent(trimmed)}&c=apps`);
  }

  /** Opens one app's Play listing. */
  async details(packageName: string): Promise<boolean> {
    if (!isValidPackageName(packageName)) return false;
    return this.intent(`market://details?id=${packageName}`);
  }

  async back(): Promise<boolean> {
    return this.openEmu.key('KEYCODE_BACK', () => undefined);
  }

  async home(): Promise<boolean> {
    return this.openEmu.key('KEYCODE_HOME', () => undefined);
  }

  private async intent(uri: string): Promise<boolean> {
    try {
      return await this.openEmu.viewIntent(uri, () => undefined);
    } catch (err) {
      this.onLog(`play intent failed (${uri}): ${(err as Error).message}`);
      return false;
    }
  }
}
