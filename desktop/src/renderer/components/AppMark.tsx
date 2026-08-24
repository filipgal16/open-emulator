/**
 * A placeholder app icon.
 *
 * Real icons are not available for installed packages, and F-Droid icons only arrive once the
 * catalogue has cached them. This is a monogram on a shaped field, hashed from the package name
 * so the same app is always the same mark — deliberate, not a letter in an identical circle.
 */
export function AppMark({
  name,
  seed,
  size = 48,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  const variant = hash(seed) % 4;
  const letters = monogram(name);

  return (
    <span
      className={`app-mark app-mark-${variant}${size >= 64 ? ' app-mark-lg' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="app-mark-letter">{letters}</span>
    </span>
  );
}

function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${firstGlyph(words[0])}${firstGlyph(words[1])}`;
  }
  const compact = (words[0] ?? label).replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length >= 2) return compact.slice(0, 2).toUpperCase();
  return (firstGlyph(label) || '?').toUpperCase();
}

function firstGlyph(value: string): string {
  const match = value.match(/[a-zA-Z0-9]/);
  return match ? match[0].toUpperCase() : '';
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
