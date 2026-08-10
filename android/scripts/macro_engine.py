#!/usr/bin/env python3
"""JSON macro recorder/runner for open-emu Android devices."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
MACRO_DIR = ROOT / "config" / "macros"


def find_adb() -> str:
    env = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    if env:
        cand = Path(env) / "platform-tools" / "adb"
        if cand.exists():
            return str(cand)
    bundled = ROOT / "sdk" / "platform-tools" / "adb"
    if bundled.exists():
        return str(bundled)
    return "adb"


def macro_path(name: str) -> Path:
    safe = name[:-5] if name.endswith(".json") else name
    if "/" in safe or "\\" in safe or safe in ("", ".", ".."):
        raise SystemExit(f"invalid macro name: {name}")
    return MACRO_DIR / f"{safe}.json"


def load_macro(name: str) -> dict[str, Any]:
    path = macro_path(name)
    if not path.exists():
        raise SystemExit(f"macro not found: {name}")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data.get("steps", []), list):
        raise SystemExit(f"macro has no steps array: {path}")
    return data


def save_macro(name: str, steps: list[dict[str, Any]], force: bool = False) -> Path:
    MACRO_DIR.mkdir(parents=True, exist_ok=True)
    path = macro_path(name)
    if path.exists() and not force:
        raise SystemExit(f"macro already exists: {name} (use --force to overwrite)")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    data = {
        "name": path.stem,
        "description": "Recorded open-emu macro",
        "created_at": now,
        "steps": steps,
    }
    path.write_text(json.dumps(data, indent=2) + "\n")
    return path


def list_macros() -> int:
    MACRO_DIR.mkdir(parents=True, exist_ok=True)
    print("macros:")
    for path in sorted(MACRO_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            count = len(data.get("steps", []))
            desc = data.get("description", "")
            suffix = f" - {desc}" if desc else ""
            print(f"  {path.stem} ({count} steps){suffix}")
        except Exception as exc:  # keep listing useful even with one bad file
            print(f"  {path.stem} (invalid: {exc})")
    return 0


def show_macro(name: str) -> int:
    data = load_macro(name)
    print(json.dumps(data, indent=2))
    return 0


def parse_record_line(line: str) -> dict[str, Any] | None:
    parts = shlex.split(line)
    if not parts:
        return None
    action = parts[0].lower()
    if action in ("done", "end", "quit", "exit"):
        raise EOFError
    if action == "tap" and len(parts) == 3:
        return {"type": "tap", "x": int(parts[1]), "y": int(parts[2])}
    if action == "wait" and len(parts) == 2:
        return {"type": "wait", "ms": int(parts[1])}
    if action == "swipe" and len(parts) in (5, 6):
        step = {
            "type": "swipe",
            "x1": int(parts[1]),
            "y1": int(parts[2]),
            "x2": int(parts[3]),
            "y2": int(parts[4]),
        }
        if len(parts) == 6:
            step["duration_ms"] = int(parts[5])
        return step
    if action == "keyevent" and len(parts) == 2:
        return {"type": "keyevent", "code": parts[1]}
    if action == "text" and len(parts) >= 2:
        return {"type": "text", "value": " ".join(parts[1:])}
    raise ValueError(
        "expected: tap X Y | wait MS | swipe X1 Y1 X2 Y2 [MS] | keyevent CODE | text VALUE"
    )


def record_macro(name: str, force: bool = False) -> int:
    print("Recording macro steps. Enter one step per line:")
    print("  tap X Y")
    print("  wait MS")
    print("  swipe X1 Y1 X2 Y2 [MS]")
    print("  keyevent CODE")
    print("  text VALUE")
    print("Type 'done' to save.")
    steps: list[dict[str, Any]] = []
    while True:
        try:
            if sys.stdin.isatty():
                line = input("> ")
            else:
                line = sys.stdin.readline()
                if line == "":
                    break
                line = line.rstrip("\n")
            step = parse_record_line(line)
            if step is None:
                continue
            steps.append(step)
            print(f"recorded: {step}")
        except EOFError:
            break
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
    path = save_macro(name, steps, force=force)
    print(f"macro={path}")
    print(f"steps={len(steps)}")
    return 0


def adb_prefix(adb: str, device: str | None) -> list[str]:
    cmd = [adb]
    if device:
        cmd.extend(["-s", device])
    return cmd


def pick_device(adb: str, requested: str | None) -> str | None:
    if requested:
        return requested
    try:
        out = subprocess.check_output([adb, "devices"], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("emulator-") and parts[1] == "device":
            return parts[0]
    return None


def adb_shell(adb: str, device: str, args: Iterable[str]) -> None:
    subprocess.run(adb_prefix(adb, device) + ["shell", *args], check=True)


def encode_input_text(value: str) -> str:
    return value.replace("%", "%25").replace(" ", "%s")


def run_step(adb: str, device: str, step: dict[str, Any]) -> None:
    action = str(step.get("type") or step.get("action") or "").lower()
    if action == "wait":
        time.sleep(float(step.get("ms", 0)) / 1000.0)
    elif action == "tap":
        adb_shell(adb, device, ["input", "tap", str(int(step["x"])), str(int(step["y"]))])
    elif action == "swipe":
        duration = str(int(step.get("duration_ms", step.get("duration", 200))))
        adb_shell(
            adb,
            device,
            [
                "input",
                "swipe",
                str(int(step["x1"])),
                str(int(step["y1"])),
                str(int(step["x2"])),
                str(int(step["y2"])),
                duration,
            ],
        )
    elif action == "keyevent":
        adb_shell(adb, device, ["input", "keyevent", str(step.get("code") or step.get("keycode"))])
    elif action == "text":
        adb_shell(adb, device, ["input", "text", encode_input_text(str(step.get("value", "")))])
    else:
        raise SystemExit(f"unsupported macro step: {step}")


def run_macro(name: str, loop: int, device: str | None, adb: str) -> int:
    if loop < 1:
        raise SystemExit("--loop must be >= 1")
    data = load_macro(name)
    serial = pick_device(adb, device)
    if not serial:
        raise SystemExit("no adb emulator device; start Android or pass --device SERIAL")
    steps = data.get("steps", [])
    print(f"macro={data.get('name', name)}")
    print(f"device={serial}")
    print(f"steps={len(steps)}")
    for iteration in range(loop):
        print(f"loop={iteration + 1}/{loop}")
        for index, step in enumerate(steps, 1):
            print(f"  step={index} {step}")
            run_step(adb, serial, step)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Record and run open-emu JSON macros")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="List macros")

    p_record = sub.add_parser("record", help="Record macro steps from stdin")
    p_record.add_argument("name")
    p_record.add_argument("--force", action="store_true")

    p_show = sub.add_parser("show", help="Print one macro JSON")
    p_show.add_argument("name")

    p_run = sub.add_parser("run", help="Run a macro through adb input")
    p_run.add_argument("name")
    p_run.add_argument("--loop", type=int, default=1)
    p_run.add_argument("--device", "-s", default="")
    p_run.add_argument("--adb", default="")

    args = parser.parse_args()
    if args.cmd == "list":
        return list_macros()
    if args.cmd == "record":
        return record_macro(args.name, force=args.force)
    if args.cmd == "show":
        return show_macro(args.name)
    if args.cmd == "run":
        return run_macro(args.name, args.loop, args.device or None, args.adb or find_adb())
    raise SystemExit(f"unknown command: {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
