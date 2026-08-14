#!/usr/bin/env python3
"""Read/apply AVD config.ini keys without rewriting unchanged files.

Rewriting cores/RAM/GPU on every launch is a common way to silently
invalidate the Emulator's named snapshots, which falls back to a multi-
minute cold boot. This helper only touches the file when a value actually
changes.
"""
from __future__ import annotations

import sys
from pathlib import Path


def parse_updates(args: list[str]) -> dict[str, str]:
    updates: dict[str, str] = {}
    for arg in args:
        if "=" not in arg:
            raise SystemExit(f"expected key=value, got {arg!r}")
        key, value = arg.split("=", 1)
        updates[key.strip()] = value
    return updates


def read_pairs(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def get(path: Path, key: str) -> str:
    for line in read_pairs(path):
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        k, v = line.split("=", 1)
        if k.strip() == key:
            return v
    return ""


def apply(path: Path, updates: dict[str, str]) -> bool:
    lines = read_pairs(path)
    seen: set[str] = set()
    out: list[str] = []
    changed = False
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in updates:
                new = f"{key}={updates[key]}"
                if line != new:
                    changed = True
                out.append(new)
                seen.add(key)
                continue
        out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
            changed = True
    if not changed:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return True


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: avd_config.py apply <file> key=value ...", file=sys.stderr)
        print("       avd_config.py get <file> <key>", file=sys.stderr)
        return 2
    cmd, raw_path = argv[1], argv[2]
    path = Path(raw_path)
    if cmd == "apply":
        changed = apply(path, parse_updates(argv[3:]))
        print("changed" if changed else "unchanged")
        return 0
    if cmd == "get":
        if len(argv) < 4:
            print("usage: avd_config.py get <file> <key>", file=sys.stderr)
            return 2
        print(get(path, argv[3]))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
