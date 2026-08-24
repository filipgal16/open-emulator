/**
 * wsl.exe emits UTF-16LE (sometimes with a BOM) when its stdout/stderr are piped rather than
 * attached to a console — a well-known WSL quirk. Decoding piped output as UTF-8 unconditionally
 * produces text riddled with NUL bytes. This detects and decodes either encoding.
 */
export function decodeWindowsProcessOutput(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  const BOM = String.fromCharCode(0xfeff);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    const text = buffer.toString('utf16le');
    return text.startsWith(BOM) ? text.slice(1) : text;
  }
  const sampleLen = Math.min(buffer.length, 64);
  if (sampleLen >= 4) {
    let nullCount = 0;
    for (let i = 1; i < sampleLen; i += 2) {
      if (buffer[i] === 0) nullCount++;
    }
    if (nullCount / Math.floor(sampleLen / 2) > 0.8) {
      return buffer.toString('utf16le');
    }
  }
  return buffer.toString('utf8');
}
