
/**
 * Builders for the `adb shell input …` commands that drive the guest.
 *
 * Kept apart from OpenEmuClient and free of any electron/IPC dependency so the escaping and
 * clamping can be unit-tested directly — this is the one place in the shell where renderer-supplied
 * text is turned into a command line, so it is worth testing as carefully as `isValidPackageName`.
 */

/** Android keycode names (`KEYCODE_BACK`) or raw numeric codes. Nothing else reaches the guest. */
const KEYCODE_RE = /^(?:KEYCODE_[A-Z0-9_]{1,40}|[0-9]{1,4})$/;

export function isSafeKeycode(keycode: string): boolean {
  return KEYCODE_RE.test(keycode);
}

/**
 * Screen coordinates are clamped rather than rejected: a tap a few pixels outside the panel is a
 * rounding artefact of the scaled mirror, not an attack, and swallowing it silently would make the
 * UI feel broken.
 */
export function clampCoord(value: number, max = 20_000): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

export function tapCommand(x: number, y: number): string {
  return `input tap ${clampCoord(x)} ${clampCoord(y)}`;
}

export function swipeCommand(x1: number, y1: number, x2: number, y2: number, durationMs: number): string {
  const duration = Math.min(10_000, Math.max(1, Math.round(Number.isFinite(durationMs) ? durationMs : 200)));
  return `input swipe ${clampCoord(x1)} ${clampCoord(y1)} ${clampCoord(x2)} ${clampCoord(y2)} ${duration}`;
}

export function keyCommand(keycode: string): string | null {
  return isSafeKeycode(keycode) ? `input keyevent ${keycode}` : null;
}

/**
 * Whether `input text` can actually send this string.
 *
 * Android's `input` speaks printable ASCII. Anything else arrives mangled or not at all, and a
 * silently truncated password is worse than an obvious refusal — the user would be left retrying
 * a login that cannot succeed, with no indication why.
 */
export function isTypeableText(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  return !/[^\x20-\x7e]/.test(value);
}

/**
 * `input text` for arbitrary user text (a Play search, a form field).
 *
 * Quoted rather than `%s`-escaped. The `%s`-for-space convention that most adb snippets use
 * corrupts any text that legitimately contains `%s`, and does nothing about the characters that
 * actually matter — quoting handles spaces and metacharacters together.
 *
 * **The quoting is supplied by the caller**, not chosen here. How many times a value must be
 * quoted depends on how many shells sit between this process and the guest, which is a property of
 * the runtime rather than of the text: two under WSL, one natively. Assuming a depth here is what
 * made the native engine type `'P@ss w0rd!'` — quotes and all — into a sign-in form. See
 * `AndroidEngine.quoteGuestArg`.
 */
export function textCommand(value: string, quote: (value: string) => string): string | null {
  return isTypeableText(value) ? `input text ${quote(value)}` : null;
}
