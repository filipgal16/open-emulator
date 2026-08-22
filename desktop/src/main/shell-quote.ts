/**
 * POSIX single-quoting, and the double-quoting that a string needs to survive the trip into the
 * guest.
 *
 * There are two shells between this process and an `adb shell` command, and both of them parse:
 *
 *   1. `wsl.exe -- bash -lc "<command>"` — WslBridge builds one string, bash splits it into argv.
 *   2. `adb shell <argv…>` — adb re-joins its arguments with spaces and hands the result to the
 *      guest's `sh`, which splits it again.
 *
 * A value quoted once loses its quotes at step 1 and is re-parsed bare at step 2, so `$`, backtick,
 * `;`, `&`, and `|` in (say) a password or a search query would execute in the guest. Quoting twice
 * means step 1 strips the outer layer and step 2 strips the inner one, leaving the literal value.
 */
export function posixQuote(value: string): string {
  // Close the quote, emit an escaped quote, reopen — the only way to get a single quote inside a
  // single-quoted POSIX string.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quotes a value so it arrives at an `adb shell` command intact. See the note above. */
export function guestShellArg(value: string): string {
  return posixQuote(posixQuote(value));
}
