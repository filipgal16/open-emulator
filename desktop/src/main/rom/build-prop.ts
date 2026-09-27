/**
 * Edits Android `build.prop` files as text, changing only the values it is asked to.
 *
 * The image's identity — what Settings → About, `Build.MODEL` and the fingerprint report — lives in
 * the four stock `build.prop`s (system, system_ext, product, vendor). The line rules here follow
 * the parser that reads them, `LoadProperties` in AOSP's `init/property_service.cpp`: a line is
 * `key=value` with whitespace trimmed around both, `#` starts a comment only at the start of a
 * line, and `import <file>` lines pull in other files.
 *
 * **Identity is rewritten in place, never appended.** Which of two definitions of a key wins
 * depends on who reads it: API 30's init loads every file into one map and lets the later one
 * override (logging "Overriding previous 'ro.' property"), older init and anything that reads the
 * file itself — `/system/build.prop` is world-readable — take the first. An appended line leaves
 * two answers and the stock identity still in plain sight; rewriting every occurrence leaves one.
 *
 * Everything this module does not rewrite stays byte-identical: comments, blank lines, order, line
 * endings, and whether the file ends in a newline. A rewritten line keeps its key and the
 * whitespace around its value; only the value between them changes.
 */

// ── Identity ──────────────────────────────────────────────────────────────────────────────────

export interface RomIdentity {
  /** `ro.product[.<p>].brand`, and the first part of every fingerprint. */
  brand: string;
  manufacturer: string;
  /** `ro.product[.<p>].model`: the name Settings → About shows. */
  model: string;
  /** `ro.product[.<p>].name`, and the second part of every fingerprint. */
  name: string;
  /** `ro.product[.<p>].device`, and the third part of every fingerprint. */
  device: string;
  /** `ro.build.display.id`: the build number line in About. */
  displayId: string;
  /** `ro.build.description`. */
  description: string;
  /** `ro.build.product`. */
  buildProduct: string;
}

const IDENTITY_FIELDS: ReadonlyArray<keyof RomIdentity> = [
  'brand', 'manufacturer', 'model', 'name', 'device', 'displayId', 'description', 'buildProduct',
];

/**
 * `ro.product.<field>` and `ro.product.<partition>.<field>` for the five identity fields.
 *
 * Deliberately closed on both sides: `ro.product.cpu.abi`, `ro.product.build.date`,
 * `ro.product.board`, `ro.product.first_api_level`, `ro.product.vndk.version` and the rest share
 * the prefix, and rewriting any of them would change what the image *is*, not what it is called —
 * a wrong ABI list is an image that refuses every app.
 */
const PRODUCT_KEY =
  /^ro\.product\.(?:(?:system|system_ext|product|vendor|odm|bootimage)\.)?(brand|manufacturer|model|name|device)$/;

/** `ro.build.fingerprint` and `ro.<partition>.build.fingerprint`, including `product` and `bootimage`. */
const FINGERPRINT_KEY = /^ro\.(?:(?:system|system_ext|product|vendor|odm|bootimage)\.)?build\.fingerprint$/;

/** `brand/name/device:release/id/incremental:type/tags`, every part non-empty. */
const FINGERPRINT = /^[^/:\s]+\/[^/:\s]+\/[^/:\s]+:[^/:\s]+\/[^/:\s]+\/[^/:\s]+:[^/:\s]+\/[^/:\s]+$/;

/**
 * Rewrites every identity key the file defines, every occurrence, and appends nothing: a key the
 * file does not have is left for the files that do (init derives the unsuffixed `ro.product.*` and
 * `ro.build.fingerprint` from them).
 *
 * A fingerprint keeps everything from its first `:` — release, build id, incremental, type and
 * tags stay true to the build underneath; only `brand/name/device` becomes ours. `changed` lists
 * each key whose value this call changed, once, in file order, so a second run reports nothing.
 */
export function rewriteIdentity(text: string, identity: RomIdentity): { text: string; changed: string[] } {
  checkIdentity(identity);
  const result = rewriteValues(text, (key, value) => identityValue(key, value, identity));
  return { text: result.text, changed: result.changed };
}

function identityValue(key: string, value: string, identity: RomIdentity): string | undefined {
  const product = PRODUCT_KEY.exec(key);
  if (product) return identity[product[1] as 'brand' | 'manufacturer' | 'model' | 'name' | 'device'];
  if (FINGERPRINT_KEY.test(key)) {
    // A value that is not a fingerprint means this is not the file we measured. Splicing an
    // identity into it anyway would ship a fingerprint nobody can parse, so the build stops here.
    if (!FINGERPRINT.test(value)) {
      throw new Error(`${key}=${value} is not a brand/name/device:release/id/incremental:type/tags fingerprint`);
    }
    return `${identity.brand}/${identity.name}/${identity.device}${value.slice(value.indexOf(':'))}`;
  }
  switch (key) {
    case 'ro.build.display.id':
      return identity.displayId;
    case 'ro.build.description':
      return identity.description;
    case 'ro.build.product':
      return identity.buildProduct;
    case 'ro.build.flavor': {
      // `<product name>-<build type>`: the name is ours, the build type stays what it is.
      const dash = value.lastIndexOf('-');
      return dash > 0 ? `${identity.name}${value.slice(dash)}` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Throws unless every identity value can be written as a property, and brand, name and device can
 * sit in a fingerprint: a `/`, `:` or space in one of those shifts every part after it, and
 * anything that splits the fingerprint — attestation, Play's device checks, crash reporters —
 * reads a different release or build id than the image has.
 */
export function checkIdentity(identity: RomIdentity): void {
  for (const field of IDENTITY_FIELDS) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`identity.${field} is empty`);
    checkValue(`identity.${field}`, value);
  }
  for (const field of ['brand', 'name', 'device'] as const) {
    if (/[/:\s]/.test(identity[field])) {
      throw new Error(`identity.${field} ${JSON.stringify(identity[field])} contains '/', ':' or whitespace, which would break the fingerprint`);
    }
  }
}

// ── Other properties ──────────────────────────────────────────────────────────────────────────

/**
 * Sets each property: every existing occurrence has its value replaced in place, and a key the
 * file lacks is appended as `key=value` at the end, in the order given.
 *
 * Upsert rather than append because appending a key the file already has does nothing a reader
 * can rely on (see the module comment). An appended line always ends in a newline, and a file that
 * did not end in one gets one before it — otherwise the new property is glued onto the last value.
 * When nothing is appended the text keeps whatever ending it had.
 *
 * Every key and value is checked before anything is edited, so a refusal changes nothing.
 */
export function upsertProps(text: string, props: Record<string, string>): string {
  const wanted = new Map(Object.entries(props));
  for (const [key, value] of wanted) checkProp(key, value);

  const result = rewriteValues(text, (key) => wanted.get(key));
  const missing = [...wanted].filter(([key]) => !result.matched.has(key));
  if (missing.length === 0) return result.text;

  const head = result.text.length === 0 || result.text.endsWith('\n') ? result.text : `${result.text}\n`;
  return head + missing.map(([key, value]) => `${key}=${value}\n`).join('');
}

/**
 * Throws unless `key=value` would be read back by init as exactly this key and this value.
 *
 * A line break or NUL in the value ends the line (or the C string) early and turns the rest into a
 * line of its own; whitespace at either end is trimmed by init, so the property read back would
 * not be the one written. A key outside `[A-Za-z0-9._-]` is not one this module has any reason to
 * write, and an `=` or space in it would move where init splits the line.
 */
export function checkProp(key: string, value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`property name ${JSON.stringify(key)} is not [A-Za-z0-9._-]+`);
  checkValue(key, value);
}

function checkValue(what: string, value: string): void {
  if (typeof value !== 'string') throw new Error(`${what}: value is not a string`);
  if (/[\n\r\0]/.test(value)) {
    throw new Error(`${what}: value ${JSON.stringify(value)} contains a line break or NUL, which would split the line init reads`);
  }
  if (/^[ \t\v\f]|[ \t\v\f]$/.test(value)) {
    throw new Error(`${what}: value ${JSON.stringify(value)} starts or ends with whitespace, which init trims away`);
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────

/**
 * Every property the text defines, skipping comments, blank lines, `import` lines and lines
 * without `=`.
 *
 * When a key is defined twice, the last definition wins — what API 30's init does, and so what
 * `getprop` reports (see the module comment).
 */
export function parseProps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const prop = parseLine(line);
    if (prop) out.set(prop.key, line.slice(prop.valueStart, prop.valueEnd));
  }
  return out;
}

// ── Lines ─────────────────────────────────────────────────────────────────────────────────────

interface PropLine {
  key: string;
  /** The value's bounds in the line, whitespace excluded, so it can be replaced on its own. */
  valueStart: number;
  valueEnd: number;
}

/** C's `isspace`, which is what init trims with. `\r` is in it: a CRLF line reads the same as LF. */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r';
}

/** The property a line defines, located the way init locates it, or null for any other line. */
function parseLine(line: string): PropLine | null {
  let start = 0;
  while (start < line.length && isSpace(line[start])) start += 1;
  if (start === line.length || line[start] === '#') return null;
  if (line.startsWith('import ', start)) return null;

  const eq = line.indexOf('=', start);
  if (eq === -1) return null;

  let keyEnd = eq;
  while (keyEnd > start && isSpace(line[keyEnd - 1])) keyEnd -= 1;
  if (keyEnd === start) return null;

  let valueEnd = line.length;
  while (valueEnd > eq + 1 && isSpace(line[valueEnd - 1])) valueEnd -= 1;
  let valueStart = eq + 1;
  while (valueStart < valueEnd && isSpace(line[valueStart])) valueStart += 1;

  return { key: line.slice(start, keyEnd), valueStart, valueEnd };
}

/**
 * Offers every property line to `replace`; a returned string becomes the line's new value, and
 * `undefined` leaves the line alone.
 *
 * Splits on `\n` only and rejoins with `\n`, so every line `replace` declines — and the file's
 * final newline, or its absence — comes back byte-for-byte.
 */
function rewriteValues(
  text: string,
  replace: (key: string, value: string) => string | undefined,
): { text: string; matched: Set<string>; changed: string[] } {
  const lines = text.split('\n');
  const matched = new Set<string>();
  const changed: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const prop = parseLine(line);
    if (!prop) continue;

    const value = line.slice(prop.valueStart, prop.valueEnd);
    const next = replace(prop.key, value);
    if (next === undefined) continue;

    matched.add(prop.key);
    if (next === value) continue;
    lines[i] = line.slice(0, prop.valueStart) + next + line.slice(prop.valueEnd);
    if (!changed.includes(prop.key)) changed.push(prop.key);
  }

  return { text: lines.join('\n'), matched, changed };
}
