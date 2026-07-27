#!/usr/bin/env python3
"""Keyboard → on-screen touch mapper for open-emulator.

Maps host keys to adb touchscreen taps / holds / swipes / Android keyevents.
Designed like LDPlayer-style key mapping for games and apps.

Input backends (auto-selected):
  - evdev  : full key-down / key-up (hold) when /dev/input is available
  - tty    : terminal raw mode (tap on press; holds approximated)
  - line   : type a key name + Enter (debug / no TTY)

Injection uses a persistent `adb shell` session for lower latency.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import subprocess
import sys
import termios
import threading
import time
import tty
from pathlib import Path
from typing import Any, Dict, Optional


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MAP = ROOT / "config" / "keymaps" / "default.json"


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


class AdbInjector:
    """Persistent adb shell for fast input commands."""

    def __init__(self, adb: str, device: Optional[str] = None) -> None:
        self.adb = adb
        self.device = device
        self.proc: Optional[subprocess.Popen[str]] = None
        self.lock = threading.Lock()
        self._start()

    def _cmd_prefix(self) -> list[str]:
        cmd = [self.adb]
        if self.device:
            cmd += ["-s", self.device]
        return cmd

    def _start(self) -> None:
        cmd = self._cmd_prefix() + ["shell"]
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                if self.proc.stdin:
                    self.proc.stdin.write("exit\n")
                    self.proc.stdin.flush()
            except Exception:
                pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except Exception:
                self.proc.kill()

    def run(self, line: str) -> None:
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self._start()
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(line.rstrip() + "\n")
            self.proc.stdin.flush()

    def tap(self, x: int, y: int) -> None:
        self.run(f"input tap {int(x)} {int(y)}")

    def down(self, x: int, y: int) -> None:
        self.run(f"input motionevent DOWN {int(x)} {int(y)}")

    def up(self, x: int, y: int) -> None:
        self.run(f"input motionevent UP {int(x)} {int(y)}")

    def move(self, x: int, y: int) -> None:
        self.run(f"input motionevent MOVE {int(x)} {int(y)}")

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 200) -> None:
        self.run(f"input swipe {int(x1)} {int(y1)} {int(x2)} {int(y2)} {int(duration_ms)}")

    def keyevent(self, code: str) -> None:
        self.run(f"input keyevent {code}")


def normalize_key(name: str) -> str:
    n = name.strip().lower()
    aliases = {
        " ": "space",
        "spc": "space",
        "esc": "escape",
        "return": "enter",
        "ret": "enter",
        "arrow_up": "up",
        "arrow_down": "down",
        "arrow_left": "left",
        "arrow_right": "right",
    }
    return aliases.get(n, n)


def load_keymap(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text())
    bindings = {}
    for b in data.get("bindings", []):
        key = normalize_key(str(b["key"]))
        bindings[key] = b
    data["_by_key"] = bindings
    return data


def scale_binding(b: Dict[str, Any], src_w: int, src_h: int, dst_w: int, dst_h: int) -> Dict[str, Any]:
    """Scale coordinates from keymap display size to current device size."""
    if src_w <= 0 or src_h <= 0 or (src_w == dst_w and src_h == dst_h):
        return b
    out = dict(b)
    sx = dst_w / src_w
    sy = dst_h / src_h
    for k in ("x", "y", "x1", "y1", "x2", "y2"):
        if k in out:
            out[k] = int(round(float(out[k]) * (sx if k.startswith("x") else sy)))
    return out


def detect_display_size(adb: str, device: Optional[str]) -> tuple[int, int]:
    cmd = [adb]
    if device:
        cmd += ["-s", device]
    # Never inherit host stdin — `adb shell` would consume piped keymap input.
    cmd += ["shell", "-n", "wm", "size"]
    try:
        out = subprocess.check_output(
            cmd, text=True, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        )
    except Exception:
        # Older adb without `shell -n`
        cmd = [adb]
        if device:
            cmd += ["-s", device]
        cmd += ["shell", "wm", "size"]
        try:
            out = subprocess.check_output(
                cmd, text=True, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
            )
        except Exception:
            return 1080, 1920
    # Prefer Override size when present.
    override = None
    physical = None
    for line in out.splitlines():
        line = line.strip()
        if "Override size:" in line:
            override = line.split(":")[-1].strip()
        elif "Physical size:" in line:
            physical = line.split(":")[-1].strip()
    chosen = override or physical or "1080x1920"
    w, h = chosen.lower().split("x")
    return int(w), int(h)


class KeyMapper:
    def __init__(self, keymap: Dict[str, Any], injector: AdbInjector, dst_w: int, dst_h: int) -> None:
        self.keymap = keymap
        self.injector = injector
        src = keymap.get("display", {})
        self.src_w = int(src.get("width", dst_w))
        self.src_h = int(src.get("height", dst_h))
        self.dst_w = dst_w
        self.dst_h = dst_h
        self.held: Dict[str, Dict[str, Any]] = {}
        self.by_key: Dict[str, Dict[str, Any]] = {
            k: scale_binding(v, self.src_w, self.src_h, dst_w, dst_h)
            for k, v in keymap["_by_key"].items()
        }

    def on_press(self, key: str) -> None:
        key = normalize_key(key)
        b = self.by_key.get(key)
        if not b:
            return
        typ = b.get("type", "tap")
        label = b.get("label", key)
        if typ == "tap":
            self.injector.tap(b["x"], b["y"])
            print(f"tap  {key:8} -> ({b['x']},{b['y']})  {label}", flush=True)
        elif typ == "hold":
            if key in self.held:
                return
            self.injector.down(b["x"], b["y"])
            self.held[key] = b
            print(f"down {key:8} -> ({b['x']},{b['y']})  {label}", flush=True)
        elif typ == "swipe":
            self.injector.swipe(
                b["x1"], b["y1"], b["x2"], b["y2"], int(b.get("duration_ms", 200))
            )
            print(f"swipe {key:7} -> ({b['x1']},{b['y1']})-({b['x2']},{b['y2']})  {label}", flush=True)
        elif typ == "keyevent":
            code = b.get("code") or b.get("keycode")
            if not code:
                return
            self.injector.keyevent(str(code))
            print(f"key  {key:8} -> {code}  {label}", flush=True)

    def on_release(self, key: str) -> None:
        key = normalize_key(key)
        b = self.held.pop(key, None)
        if not b:
            return
        self.injector.up(b["x"], b["y"])
        print(f"up   {key:8} -> ({b['x']},{b['y']})", flush=True)

    def release_all(self) -> None:
        for key in list(self.held.keys()):
            self.on_release(key)


# --- input backends ---------------------------------------------------------

EVDEV_KEYCODES = {
    1: "escape",
    28: "enter",
    57: "space",
    103: "up",
    108: "down",
    105: "left",
    106: "right",
}


def run_evdev(mapper: KeyMapper) -> None:
    try:
        import evdev
        from evdev import ecodes
    except ImportError as e:
        raise SystemExit(
            "evdev not installed. Install with: pip install evdev\n"
            "Or run with --backend tty"
        ) from e

    devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
    keyboards = []
    for d in devices:
        caps = d.capabilities()
        if ecodes.EV_KEY in caps:
            keys = caps.get(ecodes.EV_KEY, [])
            # Heuristic: devices that have letter keys
            if ecodes.KEY_A in keys or ecodes.KEY_ENTER in keys:
                keyboards.append(d)
    if not keyboards:
        raise SystemExit("No keyboard evdev device found. Try --backend tty")

    print("Listening on:", ", ".join(d.path for d in keyboards), flush=True)
    print("Press keys… Ctrl+C to stop.", flush=True)

    fds = {d.fd: d for d in keyboards}
    while True:
        r, _, _ = select.select(fds, [], [])
        for fd in r:
            dev = fds[fd]
            for event in dev.read():
                if event.type != ecodes.EV_KEY:
                    continue
                code = event.code
                # Map A-Z / 0-9
                name = None
                if ecodes.KEY_A <= code <= ecodes.KEY_Z:
                    name = chr(ord("a") + (code - ecodes.KEY_A))
                elif ecodes.KEY_1 <= code <= ecodes.KEY_9:
                    name = str(code - ecodes.KEY_1 + 1)
                elif code == ecodes.KEY_0:
                    name = "0"
                else:
                    name = EVDEV_KEYCODES.get(code)
                if not name:
                    continue
                if event.value == 1:  # down
                    mapper.on_press(name)
                elif event.value == 0:  # up
                    mapper.on_release(name)


def run_tty(mapper: KeyMapper) -> None:
    """Raw TTY: letter/arrow presses fire bindings. Holds use brief DOWN then UP on next key or timeout."""
    print("TTY keymap mode — focus this terminal and press keys.", flush=True)
    print("Hold bindings press DOWN on key; release approximated on next key / idle.", flush=True)
    print("Ctrl+C to stop.", flush=True)
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        last_hold: Optional[str] = None
        while True:
            ch = sys.stdin.read(1)
            if not ch:
                continue
            # Escape sequences for arrows
            if ch == "\x1b":
                # non-blocking small read for CSI
                rest = ""
                if select.select([sys.stdin], [], [], 0.05)[0]:
                    rest += sys.stdin.read(1)
                if rest == "[" and select.select([sys.stdin], [], [], 0.05)[0]:
                    rest += sys.stdin.read(1)
                seq = ch + rest
                arrows = {"\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left"}
                key = arrows.get(seq)
                if key:
                    # release previous hold first
                    if last_hold:
                        mapper.on_release(last_hold)
                        last_hold = None
                    b = mapper.by_key.get(key)
                    if b and b.get("type") == "hold":
                        mapper.on_press(key)
                        last_hold = key
                    else:
                        mapper.on_press(key)
                continue
            if ch == "\x03":  # Ctrl+C
                break
            if ch in ("\r", "\n"):
                key = "enter"
            elif ch == " ":
                key = "space"
            elif ch == "\x1b":
                key = "escape"
            else:
                key = ch.lower()
            if last_hold and last_hold != key:
                mapper.on_release(last_hold)
                last_hold = None
            b = mapper.by_key.get(key)
            if b and b.get("type") == "hold":
                mapper.on_press(key)
                last_hold = key
            else:
                mapper.on_press(key)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        if last_hold:
            mapper.on_release(last_hold)


def run_line(mapper: KeyMapper) -> None:
    interactive = sys.stdin.isatty()
    print("Line mode — type a key name (e.g. w, space, escape) and press Enter.", flush=True)
    print("Prefix with + for press and - for release on hold bindings (+w / -w).", flush=True)
    while True:
        if interactive:
            sys.stdout.write("> ")
            sys.stdout.flush()
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        if line in ("q", "quit", "exit"):
            break
        if line.startswith("+"):
            mapper.on_press(line[1:])
        elif line.startswith("-"):
            mapper.on_release(line[1:])
        else:
            b = mapper.by_key.get(normalize_key(line))
            if b and b.get("type") == "hold":
                mapper.on_press(line)
                time.sleep(0.12)
                mapper.on_release(line)
            else:
                mapper.on_press(line)


def pick_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    if Path("/dev/input").exists():
        try:
            import evdev  # noqa: F401
            return "evdev"
        except ImportError:
            pass
    if sys.stdin.isatty():
        return "tty"
    return "line"


def fire_once(mapper: KeyMapper, key: str, hold_ms: int = 120) -> None:
    b = mapper.by_key.get(normalize_key(key))
    if not b:
        raise SystemExit(f"no binding for key '{key}'")
    if b.get("type") == "hold":
        mapper.on_press(key)
        time.sleep(hold_ms / 1000.0)
        mapper.on_release(key)
    else:
        mapper.on_press(key)


def main() -> int:
    ap = argparse.ArgumentParser(description="Map host keyboard keys to on-screen Android touches")
    ap.add_argument("--map", default=str(DEFAULT_MAP), help="Path to keymap JSON")
    ap.add_argument("--device", default=os.environ.get("ANDROID_SERIAL", ""), help="adb device serial")
    ap.add_argument("--adb", default="", help="adb binary path")
    ap.add_argument("--backend", choices=["auto", "evdev", "tty", "line"], default="auto")
    ap.add_argument("--fire", metavar="KEY", help="Fire one binding and exit (for testing)")
    ap.add_argument("--list", action="store_true", help="List bindings and exit")
    args = ap.parse_args()

    map_path = Path(args.map)
    if not map_path.exists():
        raise SystemExit(f"keymap not found: {map_path}")
    keymap = load_keymap(map_path)
    adb = args.adb or find_adb()
    device = args.device or None
    dst_w, dst_h = detect_display_size(adb, device)

    if args.list:
        print(f"map={keymap.get('name')} display={dst_w}x{dst_h} (src {keymap.get('display')})")
        for k, b in sorted(keymap["_by_key"].items()):
            print(f"  {k:8} {b.get('type','tap'):8} {b}")
        return 0

    injector = AdbInjector(adb, device)
    mapper = KeyMapper(keymap, injector, dst_w, dst_h)
    print(
        f"Loaded '{keymap.get('name')}' — {len(mapper.by_key)} keys, "
        f"scaled {mapper.src_w}x{mapper.src_h} -> {dst_w}x{dst_h}",
        flush=True,
    )

    try:
        if args.fire:
            fire_once(mapper, args.fire)
            time.sleep(0.3)
            return 0
        backend = pick_backend(args.backend)
        print(f"backend={backend}", flush=True)
        if backend == "evdev":
            run_evdev(mapper)
        elif backend == "tty":
            run_tty(mapper)
        else:
            run_line(mapper)
    except KeyboardInterrupt:
        print("\nStopping…", flush=True)
    finally:
        mapper.release_all()
        injector.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
