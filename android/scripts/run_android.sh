#!/usr/bin/env bash
# Thin wrapper kept for Makefile compatibility — delegates to open-emu demo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HEADLESS="${ANDROID_HEADLESS:-1}"
exec "$ROOT/bin/open-emu" demo "$@"
