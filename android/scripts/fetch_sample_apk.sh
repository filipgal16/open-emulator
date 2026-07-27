#!/usr/bin/env bash
# Fetch a small real-world APK into android/apps for install testing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPS="$ROOT/apps"
mkdir -p "$APPS"

# F-Droid client — lightweight, useful for installing more apps without Play login.
# Pin a known archive.org / f-droid CDN URL; override with SAMPLE_APK_URL if needed.
URL="${SAMPLE_APK_URL:-https://f-droid.org/F-Droid.apk}"
OUT="$APPS/F-Droid.apk"

if [[ -f "$OUT" ]]; then
  echo "already present: $OUT"
  ls -lh "$OUT"
  exit 0
fi

echo "==> downloading sample APK from $URL"
curl -L --fail --retry 3 -o "$OUT.partial" "$URL"
mv "$OUT.partial" "$OUT"
ls -lh "$OUT"
echo "placed $OUT — install with: android/bin/open-emu install $OUT"
