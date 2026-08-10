#!/usr/bin/env python3
"""Keyboard → on-screen touch mapper for open-emulator.

Maps host keys to adb touchscreen taps / holds / swipes / Android keyevents.
Designed like LDPlayer-style key mapping for games and apps.

Input backends (auto-selected):
  - evdev  : full key-down / key-up (hold) when /dev/input is available
  - tty    : terminal raw mode (tap on press; holds approximated)
  - line   : type a key name + Enter (debug / no TTY)
  - mouse  : JSON lines with raw mouse/touch ops
  - gamepad: evdev gamepad; left stick + face buttons

Injection uses a persistent `adb shell` session for lower latency.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import select
import subprocess
import sys
import termios
import threading
import time
import tty
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Set, Tuple


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

    def scroll(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 200) -> None:
        self.swipe(x1, y1, x2, y2, duration_ms)

    def keyevent(self, code: str) -> None:
        self.run(f"input keyevent {code}")


class MultiInjector:
    """Fan-out injector that mirrors every input operation to multiple adb devices."""

    def __init__(self, injectors: Iterable[AdbInjector]) -> None:
        self.injectors = list(injectors)
        if not self.injectors:
            raise ValueError("MultiInjector requires at least one injector")

    def close(self) -> None:
        for injector in self.injectors:
            injector.close()

    def tap(self, x: int, y: int) -> None:
        for injector in self.injectors:
            injector.tap(x, y)

    def down(self, x: int, y: int) -> None:
        for injector in self.injectors:
            injector.down(x, y)

    def up(self, x: int, y: int) -> None:
        for injector in self.injectors:
            injector.up(x, y)

    def move(self, x: int, y: int) -> None:
        for injector in self.injectors:
            injector.move(x, y)

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 200) -> None:
        for injector in self.injectors:
            injector.swipe(x1, y1, x2, y2, duration_ms)

    def scroll(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 200) -> None:
        for injector in self.injectors:
            injector.scroll(x1, y1, x2, y2, duration_ms)

    def keyevent(self, code: str) -> None:
        for injector in self.injectors:
            injector.keyevent(code)


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


JOYSTICK_DEFAULT_KEYS = {
    "up": "w",
    "down": "s",
    "left": "a",
    "right": "d",
}

JOYSTICK_DIRECTIONS = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}


def joystick_key(binding: Dict[str, Any], direction: str) -> str:
    return normalize_key(str(binding.get(direction, JOYSTICK_DEFAULT_KEYS[direction])))


def parse_devices(devices: str, device: Optional[str]) -> list[Optional[str]]:
    serials: list[Optional[str]] = []
    if devices:
        for part in devices.replace(",", " ").split():
            serial = part.strip()
            if serial and serial not in serials:
                serials.append(serial)
    elif device:
        serials.append(device)
    else:
        serials.append(None)
    return serials


def load_keymap(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text())
    bindings = {}
    for idx, raw in enumerate(data.get("bindings", [])):
        b = dict(raw)
        b.setdefault("_id", f"binding:{idx}")
        if b.get("type") == "joystick":
            b.setdefault("up", JOYSTICK_DEFAULT_KEYS["up"])
            b.setdefault("down", JOYSTICK_DEFAULT_KEYS["down"])
            b.setdefault("left", JOYSTICK_DEFAULT_KEYS["left"])
            b.setdefault("right", JOYSTICK_DEFAULT_KEYS["right"])
            for direction in JOYSTICK_DIRECTIONS:
                bindings[joystick_key(b, direction)] = b
            continue
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
    for k in ("x", "y", "x1", "y1", "x2", "y2", "cx", "cy"):
        if k in out:
            out[k] = int(round(float(out[k]) * (sx if k.startswith("x") else sy)))
    if "radius" in out:
        out["radius"] = int(round(float(out["radius"]) * min(sx, sy)))
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
    def __init__(self, keymap: Dict[str, Any], injector: Any, dst_w: int, dst_h: int) -> None:
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
        self.joysticks: Dict[str, Dict[str, Any]] = {}
        self.default_joystick_id: Optional[str] = None
        for b in self.by_key.values():
            if b.get("type") != "joystick":
                continue
            jid = str(b.get("_id", id(b)))
            if jid in self.joysticks:
                continue
            self.joysticks[jid] = {
                "binding": b,
                "directions": set(),
                "direct": None,
                "active": False,
                "x": int(b["cx"]),
                "y": int(b["cy"]),
            }
            if self.default_joystick_id is None:
                self.default_joystick_id = jid

    def _joystick_direction_for_key(self, b: Dict[str, Any], key: str) -> Optional[str]:
        for direction in JOYSTICK_DIRECTIONS:
            if joystick_key(b, direction) == key:
                return direction
        return None

    def _joystick_vector(self, state: Dict[str, Any]) -> Optional[Tuple[float, float]]:
        directions: Set[str] = state["directions"]
        if directions:
            dx = float(("right" in directions) - ("left" in directions))
            dy = float(("down" in directions) - ("up" in directions))
        else:
            direct = state.get("direct")
            if direct is None:
                return None
            dx, dy = direct
        mag = math.hypot(dx, dy)
        if mag <= 0.0:
            return None
        if mag > 1.0:
            dx /= mag
            dy /= mag
        return dx, dy

    def _joystick_point(self, b: Dict[str, Any], vector: Tuple[float, float]) -> Tuple[int, int]:
        dx, dy = vector
        radius = float(b["radius"])
        return (
            int(round(float(b["cx"]) + dx * radius)),
            int(round(float(b["cy"]) + dy * radius)),
        )

    def _update_joystick(self, jid: str, source: str) -> None:
        state = self.joysticks[jid]
        b = state["binding"]
        label = b.get("label", "joystick")
        vector = self._joystick_vector(state)
        if vector is None:
            if state["active"]:
                self.injector.up(state["x"], state["y"])
                print(f"up   {source:8} -> ({state['x']},{state['y']})  {label}", flush=True)
                state["active"] = False
            return

        x, y = self._joystick_point(b, vector)
        if not state["active"]:
            self.injector.down(x, y)
            state["active"] = True
            print(f"down {source:8} -> ({x},{y})  {label}", flush=True)
        elif (x, y) != (state["x"], state["y"]):
            self.injector.move(x, y)
            print(f"move {source:8} -> ({x},{y})  {label}", flush=True)
        state["x"] = x
        state["y"] = y

    def on_joystick_axis(self, dx: float, dy: float, deadzone: float = 0.18) -> None:
        if self.default_joystick_id is None:
            return
        mag = math.hypot(dx, dy)
        state = self.joysticks[self.default_joystick_id]
        if mag < deadzone:
            state["direct"] = None
        else:
            if mag > 1.0:
                dx /= mag
                dy /= mag
            state["direct"] = (dx, dy)
        self._update_joystick(self.default_joystick_id, "gamepad")

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
        elif typ == "joystick":
            direction = self._joystick_direction_for_key(b, key)
            if direction is None:
                return
            jid = str(b.get("_id", id(b)))
            state = self.joysticks[jid]
            if direction in state["directions"]:
                return
            state["directions"].add(direction)
            self._update_joystick(jid, key)
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
        b = self.by_key.get(key)
        if b and b.get("type") == "joystick":
            direction = self._joystick_direction_for_key(b, key)
            if direction is None:
                return
            jid = str(b.get("_id", id(b)))
            state = self.joysticks[jid]
            state["directions"].discard(direction)
            self._update_joystick(jid, key)
            return
        b = self.held.pop(key, None)
        if not b:
            return
        self.injector.up(b["x"], b["y"])
        print(f"up   {key:8} -> ({b['x']},{b['y']})", flush=True)

    def release_all(self) -> None:
        for key in list(self.held.keys()):
            self.on_release(key)
        for jid, state in self.joysticks.items():
            state["directions"].clear()
            state["direct"] = None
            self._update_joystick(jid, "release")


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
                    if b and b.get("type") in ("hold", "joystick"):
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
            if b and b.get("type") in ("hold", "joystick"):
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
    print("Prefix with + for press and - for release on hold/joystick bindings (+w / -w).", flush=True)
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
            if b and b.get("type") in ("hold", "joystick"):
                mapper.on_press(line)
                time.sleep(0.12)
                mapper.on_release(line)
            else:
                mapper.on_press(line)


def _json_int(event: Dict[str, Any], name: str) -> int:
    try:
        return int(event[name])
    except KeyError as e:
        raise ValueError(f"missing '{name}'") from e


def run_mouse(mapper: KeyMapper) -> None:
    print("Mouse JSON mode — send one JSON object per line.", flush=True)
    print('Ops: {"op":"tap|down|up|move","x":N,"y":N} or {"op":"scroll","x":N,"y":N,"dx":N,"dy":N}', flush=True)
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            event = json.loads(raw)
            op = str(event.get("op", "")).lower()
            if op == "tap":
                mapper.injector.tap(_json_int(event, "x"), _json_int(event, "y"))
            elif op == "down":
                mapper.injector.down(_json_int(event, "x"), _json_int(event, "y"))
            elif op == "up":
                mapper.injector.up(_json_int(event, "x"), _json_int(event, "y"))
            elif op == "move":
                mapper.injector.move(_json_int(event, "x"), _json_int(event, "y"))
            elif op == "scroll":
                duration = int(event.get("duration_ms", 200))
                if all(k in event for k in ("x1", "y1", "x2", "y2")):
                    x1 = _json_int(event, "x1")
                    y1 = _json_int(event, "y1")
                    x2 = _json_int(event, "x2")
                    y2 = _json_int(event, "y2")
                else:
                    x1 = _json_int(event, "x")
                    y1 = _json_int(event, "y")
                    x2 = x1 + int(event.get("dx", 0))
                    y2 = y1 + int(event.get("dy", 0))
                mapper.injector.scroll(x1, y1, x2, y2, duration)
            elif op in ("q", "quit", "exit"):
                break
            else:
                raise ValueError(f"unknown op '{op}'")
            print(f"mouse {op}", flush=True)
        except Exception as e:
            print(f"mouse error: {e}: {raw}", file=sys.stderr, flush=True)


def run_gamepad(mapper: KeyMapper) -> None:
    try:
        import evdev
        from evdev import ecodes
    except ImportError as e:
        raise SystemExit(
            "evdev not installed. Install with: pip install evdev\n"
            "Or run with --backend line"
        ) from e

    button_names = {}
    for code_name, key_name in (
        ("BTN_SOUTH", "gamepad_a"),
        ("BTN_A", "gamepad_a"),
        ("BTN_EAST", "gamepad_b"),
        ("BTN_B", "gamepad_b"),
        ("BTN_WEST", "gamepad_x"),
        ("BTN_X", "gamepad_x"),
        ("BTN_NORTH", "gamepad_y"),
        ("BTN_Y", "gamepad_y"),
    ):
        code = getattr(ecodes, code_name, None)
        if code is not None:
            button_names[code] = key_name

    devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
    gamepads = []
    def cap_codes(values: Any) -> Set[int]:
        codes: Set[int] = set()
        for value in values:
            if isinstance(value, tuple):
                codes.add(int(value[0]))
            else:
                codes.add(int(value))
        return codes

    for d in devices:
        caps = d.capabilities()
        keys = cap_codes(caps.get(ecodes.EV_KEY, []))
        axes = cap_codes(caps.get(ecodes.EV_ABS, []))
        if (ecodes.ABS_X in axes and ecodes.ABS_Y in axes) or any(code in keys for code in button_names):
            gamepads.append(d)
    if not gamepads:
        raise SystemExit("No gamepad evdev device found. Try --backend line")

    def axis_value(dev: Any, code: int, value: int) -> float:
        info = dev.absinfo(code)
        center = (float(info.min) + float(info.max)) / 2.0
        span = max((float(info.max) - float(info.min)) / 2.0, 1.0)
        norm = (float(value) - center) / span
        flat = max(float(getattr(info, "flat", 0)) / span, 0.08)
        if abs(norm) < flat:
            return 0.0
        return max(-1.0, min(1.0, norm))

    axis_state: Dict[int, Dict[int, float]] = {d.fd: {ecodes.ABS_X: 0.0, ecodes.ABS_Y: 0.0} for d in gamepads}
    print("Listening on gamepad:", ", ".join(d.path for d in gamepads), flush=True)
    print("Left stick drives joystick; A/B/X/Y emit gamepad_a/b/x/y. Ctrl+C to stop.", flush=True)

    fds = {d.fd: d for d in gamepads}
    while True:
        r, _, _ = select.select(fds, [], [])
        for fd in r:
            dev = fds[fd]
            for event in dev.read():
                if event.type == ecodes.EV_ABS and event.code in (ecodes.ABS_X, ecodes.ABS_Y):
                    axis_state[fd][event.code] = axis_value(dev, event.code, event.value)
                    mapper.on_joystick_axis(axis_state[fd][ecodes.ABS_X], axis_state[fd][ecodes.ABS_Y])
                elif event.type == ecodes.EV_KEY and event.code in button_names:
                    name = button_names[event.code]
                    if event.value == 1:
                        mapper.on_press(name)
                    elif event.value == 0:
                        mapper.on_release(name)


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
    if b.get("type") in ("hold", "joystick"):
        mapper.on_press(key)
        time.sleep(hold_ms / 1000.0)
        mapper.on_release(key)
    else:
        mapper.on_press(key)


def main() -> int:
    ap = argparse.ArgumentParser(description="Map host keyboard keys to on-screen Android touches")
    ap.add_argument("--map", default=str(DEFAULT_MAP), help="Path to keymap JSON")
    ap.add_argument("--device", default=os.environ.get("ANDROID_SERIAL", ""), help="adb device serial")
    ap.add_argument("--devices", default="", help="Comma-separated adb serials for synchronized injection")
    ap.add_argument("--adb", default="", help="adb binary path")
    ap.add_argument("--backend", choices=["auto", "evdev", "tty", "line", "mouse", "gamepad"], default="auto")
    ap.add_argument("--fire", metavar="KEY", help="Fire one binding and exit (for testing)")
    ap.add_argument("--list", action="store_true", help="List bindings and exit")
    args = ap.parse_args()

    map_path = Path(args.map)
    if not map_path.exists():
        raise SystemExit(f"keymap not found: {map_path}")
    keymap = load_keymap(map_path)
    adb = args.adb or find_adb()
    device = args.device or None
    devices = parse_devices(args.devices, device)
    display_device = next((serial for serial in devices if serial), device)
    dst_w, dst_h = detect_display_size(adb, display_device)

    if args.list:
        print(f"map={keymap.get('name')} display={dst_w}x{dst_h} (src {keymap.get('display')})")
        for k, b in sorted(keymap["_by_key"].items()):
            print(f"  {k:8} {b.get('type','tap'):8} {b}")
        return 0

    injector = MultiInjector(AdbInjector(adb, serial) for serial in devices)
    mapper = KeyMapper(keymap, injector, dst_w, dst_h)
    print(
        f"Loaded '{keymap.get('name')}' — {len(mapper.by_key)} keys, "
        f"scaled {mapper.src_w}x{mapper.src_h} -> {dst_w}x{dst_h}, "
        f"devices={','.join(serial or 'default' for serial in devices)}",
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
        elif backend == "mouse":
            run_mouse(mapper)
        elif backend == "gamepad":
            run_gamepad(mapper)
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
