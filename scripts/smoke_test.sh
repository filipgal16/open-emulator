#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/build/open-vmm"
GUEST="$ROOT/build/guest/hello.bin"

if [[ ! -x "$BIN" || ! -f "$GUEST" ]]; then
  echo "build artifacts missing; run make first" >&2
  exit 1
fi

echo "== soft backend =="
out="$("$BIN" --backend=soft "$GUEST" 2>/tmp/open-vmm-soft.err)"
echo "$out"
grep -q "open-emulator: guest is alive" <<<"$out"
grep -q "backend=soft" /tmp/open-vmm-soft.err

if [[ -e /dev/kvm ]]; then
  echo "== kvm backend =="
  out="$("$BIN" --backend=kvm "$GUEST" 2>/tmp/open-vmm-kvm.err)"
  echo "$out"
  grep -q "open-emulator: guest is alive" <<<"$out"
  grep -q "backend=kvm" /tmp/open-vmm-kvm.err
else
  echo "== kvm backend skipped (/dev/kvm missing) =="
fi

echo "smoke test passed"
