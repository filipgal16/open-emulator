#!/usr/bin/env python3
"""Edit keymap JSON files for open-emu."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def save(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_set = sub.add_parser("set")
    p_set.add_argument("path")
    p_set.add_argument("key")
    p_set.add_argument("x", type=int)
    p_set.add_argument("y", type=int)
    p_set.add_argument("--type", choices=["tap", "hold"], default="tap")
    p_set.add_argument("--label", default="")

    p_unset = sub.add_parser("unset")
    p_unset.add_argument("path")
    p_unset.add_argument("key")

    p_event = sub.add_parser("set-keyevent")
    p_event.add_argument("path")
    p_event.add_argument("key")
    p_event.add_argument("code")
    p_event.add_argument("--label", default="")

    args = ap.parse_args()
    path = Path(args.path)
    data = load(path)
    bindings = data.setdefault("bindings", [])

    if args.cmd == "set":
        key = args.key.lower()
        bindings[:] = [b for b in bindings if str(b.get("key", "")).lower() != key]
        bindings.append(
            {
                "key": key,
                "type": args.type,
                "x": args.x,
                "y": args.y,
                "label": args.label or key,
            }
        )
        save(path, data)
        print(f"set {key} -> {args.type} ({args.x},{args.y})")
    elif args.cmd == "unset":
        key = args.key.lower()
        before = len(bindings)
        bindings[:] = [b for b in bindings if str(b.get("key", "")).lower() != key]
        save(path, data)
        print(f"unset {key} (removed {before - len(bindings)})")
    elif args.cmd == "set-keyevent":
        key = args.key.lower()
        bindings[:] = [b for b in bindings if str(b.get("key", "")).lower() != key]
        bindings.append(
            {
                "key": key,
                "type": "keyevent",
                "code": args.code,
                "label": args.label or key,
            }
        )
        save(path, data)
        print(f"set {key} -> keyevent {args.code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
