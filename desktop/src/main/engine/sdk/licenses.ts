import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { SdkLicense } from './repository';

/**
 * Google's SDK licences: presenting them, and recording that they were accepted.
 *
 * Worth being precise about what this replaces. `android/scripts/fetch_android.sh` ran
 *
 *     yes 2>/dev/null | "$SDKMANAGER" --licenses >/dev/null
 *
 * — it accepted every Google licence automatically, without ever showing one, and discarded the
 * output. `LICENSING.md` rests its whole argument on each user's machine accepting Google's
 * licence, so replacing that with the text actually shown and an explicit acceptance is not a
 * regression from dropping `sdkmanager`; it is the first time the acceptance means anything.
 *
 * The acceptance is recorded in the same format `sdkmanager` uses — a file per licence id under
 * `<sdk>/licenses/`, containing the SHA-1 of the licence text — so the SDK directory stays
 * interchangeable with a normally-installed one, and `sdkmanager` will not re-prompt if anyone
 * ever runs it here.
 */

/** `sdkmanager` identifies an accepted licence by the SHA-1 of its exact text. */
export function licenseHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function licenseFile(sdkRoot: string, licenseId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(licenseId)) throw new Error(`unsafe licence id: ${licenseId}`);
  return path.join(sdkRoot, 'licenses', licenseId);
}

/**
 * Whether this exact licence text has already been accepted.
 *
 * Matched on the hash, not merely the presence of the file: Google revises these, and a stale
 * acceptance recorded against older wording is not consent to the current one.
 */
export function isAccepted(sdkRoot: string, license: SdkLicense): boolean {
  const file = licenseFile(sdkRoot, license.id);
  if (!existsSync(file)) return false;
  try {
    const recorded = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return recorded.includes(licenseHash(license.text));
  } catch {
    return false;
  }
}

/**
 * Records acceptance, appending rather than replacing.
 *
 * A licences file legitimately holds several hashes — one per licence version the user has
 * accepted over time — and overwriting would silently revoke consent to the others, which
 * `sdkmanager` would then prompt for again.
 */
export function recordAcceptance(sdkRoot: string, license: SdkLicense): void {
  const file = licenseFile(sdkRoot, license.id);
  mkdirSync(path.dirname(file), { recursive: true });

  const hash = licenseHash(license.text);
  const existing = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  if (existing.includes(hash)) return;
  // Leading newline matches the layout sdkmanager writes.
  writeFileSync(file, `\n${[...existing, hash].join('\n')}\n`, 'utf8');
}

/** The licences that still need showing, given what has already been accepted. */
export function pendingLicenses(
  sdkRoot: string,
  licenses: Map<string, SdkLicense>,
  requiredIds: string[],
): SdkLicense[] {
  const pending: SdkLicense[] = [];
  for (const id of new Set(requiredIds)) {
    const license = licenses.get(id);
    // A package referencing a licence the manifest does not carry cannot be lawfully accepted on
    // the user's behalf, so it is surfaced rather than skipped.
    if (!license) throw new Error(`the manifest references licence "${id}" but does not define it`);
    if (!isAccepted(sdkRoot, license)) pending.push(license);
  }
  return pending;
}

/** Accepts every licence in the list. Call only once a person has actually agreed to them. */
export function acceptAll(sdkRoot: string, licenses: SdkLicense[]): void {
  for (const license of licenses) recordAcceptance(sdkRoot, license);
}
