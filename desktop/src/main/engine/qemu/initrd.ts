import { gunzipSync, gzipSync } from 'zlib';
import { buildCpio, findEntry, parseCpio, replaceEntry, type CpioEntry } from './cpio';

/**
 * Patching the Android-x86 initrd so the guest is reachable over adb.
 *
 * There is no USB to emulate, so adb has to arrive over TCP — and `adbd` only listens on TCP when
 * `service.adb.tcp.port` is set. Getting that property in is the whole problem, and the initrd is
 * the small honest place to do it:
 *
 *   `/data/property` does not work. Android 9 keeps persistent properties in a single protobuf
 *   blob rather than one file per property, so seeding an empty data disk achieves nothing.
 *
 *   Editing `system.sfs` means unpacking and repacking 942 MB to change one line.
 *
 *   The initrd is about 1.3 MB and *already* writes to `default.prop` immediately before handing
 *   over to Android — that is how it disables the setup wizard. Adding three lines beside that is
 *   a few hundred bytes of change to a file that is rebuilt on every prepare anyway.
 *
 * `ro.adb.secure` and `ro.secure` go in the same edit for a related reason: with adb
 * authentication on, the first connection waits for someone to accept a key prompt on a screen
 * nobody is looking at.
 */

/** The line the stock initrd uses to disable the setup wizard — our insertion point. */
const ANCHOR = 'ro.setupwizard.mode=DISABLED';

export const ADB_TCP_PORT = 5555;

/**
 * Shell inserted into the initrd's `init`, immediately after the anchor.
 *
 * Existing assignments are stripped before the new ones are appended, because `default.prop` is
 * read top to bottom and a later duplicate does not reliably win — leaving the original in place
 * would make the result depend on Android's property-loading order rather than on this edit.
 *
 * Tab-indented to match the surrounding script.
 */
function patchScript(port: number): string {
  return [
    '',
    '\t# open-emulator: adbd only listens on TCP when this property is set, and there is no USB to',
    '\t# emulate. Written here because the initrd owns default.prop right up until Android starts.',
    "\tgrep -v -E '^(service\\.adb\\.tcp\\.port|ro\\.adb\\.secure|ro\\.secure)=' default.prop > oe.prop",
    `\tprintf 'service.adb.tcp.port=${port}\\nro.adb.secure=0\\nro.secure=0\\n' >> oe.prop`,
    '\tmv oe.prop default.prop',
  ].join('\n');
}

export class InitrdPatchError extends Error {}

/**
 * Inserts the patch after the anchor line in `init`.
 *
 * Exported separately from the archive handling so the text transformation can be tested without
 * building a cpio, and so a future Android-x86 release that moves the anchor fails here with a
 * clear message rather than producing a silently unpatched initrd.
 */
export function patchInitScript(script: string, port: number = ADB_TCP_PORT): string {
  if (script.includes('service.adb.tcp.port')) {
    // Already patched. Returning it unchanged keeps `prepare` idempotent — and re-running the
    // insertion would stack duplicate blocks on every call.
    return script;
  }

  const lines = script.split('\n');
  const anchorIndex = lines.findIndex((line) => line.includes(ANCHOR));
  if (anchorIndex === -1) {
    throw new InitrdPatchError(
      `could not find "${ANCHOR}" in the initrd's init script — this Android-x86 build is not one this patch understands`,
    );
  }

  lines.splice(anchorIndex + 1, 0, patchScript(port));
  return lines.join('\n');
}

export interface PatchResult {
  /** The gzipped, repacked initrd, ready to hand to QEMU as `-initrd`. */
  image: Buffer;
  entryCount: number;
  alreadyPatched: boolean;
}

/**
 * Reads a gzipped initrd, patches `init`, and repacks it.
 *
 * Every other entry is passed through untouched, including its mode — which matters more than it
 * sounds, because `init` is the one file whose executable bit the kernel absolutely requires.
 */
export function patchInitrd(gzipped: Buffer, port: number = ADB_TCP_PORT): PatchResult {
  let raw: Buffer;
  try {
    raw = gunzipSync(gzipped);
  } catch (err) {
    throw new InitrdPatchError(`the initrd is not gzip-compressed: ${(err as Error).message}`);
  }

  const entries: CpioEntry[] = parseCpio(raw);

  const init = findEntry(entries, 'init');
  if (!init) {
    throw new InitrdPatchError('the initrd contains no init — it is not an Android-x86 boot image');
  }

  const before = init.data.toString('utf8');
  const alreadyPatched = before.includes('service.adb.tcp.port');

  replaceEntry(entries, 'init', (previous) =>
    Buffer.from(patchInitScript(previous.toString('utf8'), port), 'utf8'),
  );

  const after = findEntry(entries, 'init')!.data.toString('utf8');
  // Belt and braces: a patch that silently did nothing produces a guest that boots fine and is
  // simply unreachable, which is a far worse failure than refusing here.
  if (!after.includes('service.adb.tcp.port')) {
    throw new InitrdPatchError('the initrd patch did not apply');
  }

  return {
    image: gzipSync(buildCpio(entries), { level: 9 }),
    entryCount: entries.length,
    alreadyPatched,
  };
}
