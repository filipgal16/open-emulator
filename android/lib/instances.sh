#!/usr/bin/env bash
# Isolated Android AVD instances for open-emu.
# Each instance has its own userdata, sdcard, console/adb ports, pid, and logs.

INSTANCE_STATE_FILE="${INSTANCE_STATE_FILE:-$STATE_DIR/instances.json}"
INSTANCE_LOG_DIR="${INSTANCE_LOG_DIR:-$LOG_DIR/instances}"

instance_usage() {
  cat <<EOF
Usage: open-emu instance <command> [args]

Commands:
  list [--json]
  ensure-main
  create <name> [--cores N] [--memory MB]
  clone [source] <name> [--cores N] [--memory MB]
  start <name>
  stop <name>
  delete <name>
  batch start|stop [name...]

Instances clone OpenEmulator_API30 by default into OpenEmulator_<name>.
Console/adb ports are allocated as 5554/5555, 5556/5557, ...
Each instance is an isolated virtual machine (separate /data and sdcard).
EOF
}

instance_state_init() {
  mkdir -p "$STATE_DIR" "$INSTANCE_LOG_DIR" "$STATE_DIR/instances"
  if [[ ! -f "$INSTANCE_STATE_FILE" ]]; then
    printf '{\n  "instances": []\n}\n' > "$INSTANCE_STATE_FILE"
  fi
}

instance_validate_name() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid instance name: $name (use letters, numbers, _ or -)"
}

instance_dir() {
  echo "$STATE_DIR/instances/${1}"
}

instance_get_env() {
  local name="$1"
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" "$name" <<'PY'
import json
import shlex
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
name = sys.argv[2]
for inst in state.get("instances", []):
    if inst.get("name") == name:
        for key, env in (
            ("name", "INST_NAME"),
            ("avd", "INST_AVD"),
            ("console_port", "INST_CONSOLE_PORT"),
            ("adb_port", "INST_ADB_PORT"),
            ("cores", "INST_CORES"),
            ("memory_mb", "INST_MEMORY_MB"),
            ("pid", "INST_PID"),
            ("status", "INST_STATUS"),
            ("last_app", "INST_LAST_APP"),
            ("source_avd", "INST_SOURCE_AVD"),
        ):
            value = inst.get(key, "")
            print(f"{env}={shlex.quote(str(value))}")
        raise SystemExit(0)
raise SystemExit(1)
PY
}

instance_exists() {
  instance_get_env "$1" >/dev/null 2>&1
}

instance_upsert_state() {
  local name="$1" avd="$2" console_port="$3" cores="$4" memory_mb="$5" status="$6" pid="${7:-}" source_avd="${8:-$AVD_NAME}" last_app="${9:-}"
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" "$name" "$avd" "$console_port" "$cores" "$memory_mb" "$status" "$pid" "$source_avd" "$last_app" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
name, avd = sys.argv[2], sys.argv[3]
console_port = int(sys.argv[4])
cores = int(sys.argv[5])
memory_mb = int(sys.argv[6])
status, pid, source_avd, last_app = sys.argv[7], sys.argv[8], sys.argv[9], sys.argv[10]
state = json.loads(path.read_text()) if path.exists() else {"instances": []}
instances = state.setdefault("instances", [])
now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
existing = next((inst for inst in instances if inst.get("name") == name), None)
if existing is None:
    existing = {"name": name, "created_at": now}
    instances.append(existing)
existing.update(
    {
        "avd": avd,
        "console_port": console_port,
        "adb_port": console_port + 1,
        "cores": cores,
        "memory_mb": memory_mb,
        "status": status,
        "pid": pid,
        "source_avd": source_avd,
        "updated_at": now,
    }
)
if last_app:
    existing["last_app"] = last_app
instances.sort(key=lambda item: int(item.get("console_port", 0)))
path.write_text(json.dumps(state, indent=2) + "\n")
PY
}

instance_set_last_app() {
  local name="$1" app="$2"
  instance_exists "$name" || return 1
  eval "$(instance_get_env "$name")"
  instance_upsert_state "$name" "$INST_AVD" "$INST_CONSOLE_PORT" "$INST_CORES" "$INST_MEMORY_MB" "${INST_STATUS:-stopped}" "${INST_PID:-}" "${INST_SOURCE_AVD:-$INST_AVD}" "$app"
}

instance_remove_state() {
  local name="$1"
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" "$name" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
name = sys.argv[2]
state = json.loads(path.read_text()) if path.exists() else {"instances": []}
state["instances"] = [inst for inst in state.get("instances", []) if inst.get("name") != name]
path.write_text(json.dumps(state, indent=2) + "\n")
PY
}

instance_all_names() {
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" <<'PY'
import json
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
for inst in state.get("instances", []):
    print(inst.get("name", ""))
PY
}

instance_port_in_state() {
  local port="$1"
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" "$port" <<'PY'
import json
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
port = int(sys.argv[2])
for inst in state.get("instances", []):
    if int(inst.get("console_port", -1)) == port:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

instance_port_live() {
  local port="$1"
  if [[ -x "${ADB_BIN:-}" ]] && "$ADB_BIN" devices 2>/dev/null | awk '{print $1}' | grep -qx "emulator-${port}"; then
    return 0
  fi
  if command -v nc >/dev/null 2>&1 && timeout 1s nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

instance_allocate_console_port() {
  local port
  for port in $(seq 5554 2 5684); do
    if ! instance_port_in_state "$port" && ! instance_port_live "$port"; then
      echo "$port"
      return 0
    fi
  done
  die "no free emulator console ports in 5554..5684"
}

instance_set_config_keys() {
  local config="$1"
  shift
  python3 - "$config" "$@" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
updates = dict(arg.split("=", 1) for arg in sys.argv[2:])
lines = path.read_text().splitlines() if path.exists() else []
seen = set()
out = []
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
}

instance_resolve_source_avd() {
  local source="${1:-$AVD_NAME}"
  if instance_exists "$source"; then
    eval "$(instance_get_env "$source")"
    echo "$INST_AVD"
    return 0
  fi
  if [[ -d "$AVD_HOME/${source}.avd" ]]; then
    echo "$source"
    return 0
  fi
  die "source AVD/instance not found: $source"
}

bind_active_instance() {
  local name="${ANDROID_INSTANCE:-main}"
  CONSOLE_PORT="${ANDROID_CONSOLE_PORT:-5554}"
  INSTANCE_NAME="$name"
  mkdir -p "$(instance_dir "$name")" "$INSTANCE_LOG_DIR"

  if instance_exists "$name"; then
    eval "$(instance_get_env "$name")"
    AVD_NAME="$INST_AVD"
    CONSOLE_PORT="$INST_CONSOLE_PORT"
  fi

  PID_FILE="$(instance_dir "$name")/emulator.pid"
  DEVICE_FILE="$(instance_dir "$name")/device"
  EXPECTED_SERIAL="emulator-${CONSOLE_PORT}"
  EMULATOR_LOG="$INSTANCE_LOG_DIR/${name}.log"
  SCREENSHOT_FILE="$(instance_dir "$name")/screen.png"
}

instance_create_from_source() {
  local source_avd="$1" name="$2" cores="$3" memory_mb="$4"
  instance_validate_name "$name"
  instance_exists "$name" && die "instance already exists: $name"

  local dst_avd="OpenEmulator_${name}"
  local src_dir="$AVD_HOME/${source_avd}.avd"
  local dst_dir="$AVD_HOME/${dst_avd}.avd"
  [[ -d "$src_dir" ]] || die "source AVD missing: $src_dir (run setup / the install wizard)"
  [[ ! -e "$dst_dir" ]] || die "target AVD already exists: $dst_dir"

  detect_host_profile
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  [[ "$cores" == "0" ]] && cores="$GUEST_CORES"
  [[ "$memory_mb" == "0" ]] && memory_mb="$GUEST_RAM_MB"

  local console_port
  console_port="$(instance_allocate_console_port)"

  log "cloning isolated VM ${source_avd} -> ${dst_avd}"
  cp -a "$src_dir" "$dst_dir"
  # Drop snapshots so the clone boots its own userdata, not the source's live RAM.
  rm -rf "$dst_dir/snapshots" 2>/dev/null || true
  if [[ -f "$AVD_HOME/${source_avd}.ini" ]]; then
    cp -a "$AVD_HOME/${source_avd}.ini" "$AVD_HOME/${dst_avd}.ini"
  fi

  instance_set_config_keys "$dst_dir/config.ini" \
    "AvdId=${dst_avd}" \
    "avd.ini.displayname=open-emulator ${name}" \
    "hw.cpu.ncore=${cores}" \
    "hw.ramSize=${memory_mb}" \
    "hw.gpu.mode=${GPU_MODE}" \
    "hw.keyboard=yes" \
    "runtime.network.latency=none" \
    "runtime.network.speed=full"

  cat > "$AVD_HOME/${dst_avd}.ini" <<EOF
avd.ini.encoding=UTF-8
path=${dst_dir}
path.rel=avd/${dst_avd}.avd
target=android-30
EOF

  mkdir -p "$(instance_dir "$name")"
  instance_upsert_state "$name" "$dst_avd" "$console_port" "$cores" "$memory_mb" "stopped" "" "$source_avd"
  echo "instance=${name}"
  echo "avd=${dst_avd}"
  echo "console_port=${console_port}"
  echo "adb_device=emulator-${console_port}"
  echo "cores=${cores}"
  echo "memory_mb=${memory_mb}"
  echo "isolated=yes"
}

instance_ensure_main() {
  instance_state_init
  if instance_exists "main"; then
    eval "$(instance_get_env main)"
    echo "instance=main"
    echo "avd=${INST_AVD}"
    echo "status=exists"
    return 0
  fi
  [[ -d "$AVD_HOME/${AVD_NAME}.avd" ]] || die "AVD missing: $AVD_HOME/${AVD_NAME}.avd"

  detect_host_profile
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  local console_port
  console_port="$(instance_allocate_console_port)"
  mkdir -p "$(instance_dir main)"
  instance_upsert_state "main" "$AVD_NAME" "$console_port" "$GUEST_CORES" "$GUEST_RAM_MB" "stopped" "" "$AVD_NAME"
  echo "instance=main"
  echo "avd=${AVD_NAME}"
  echo "console_port=${console_port}"
  echo "status=registered"
}

instance_create() {
  local name="${1:-}" cores=0 memory_mb=0
  [[ -n "$name" ]] || die "usage: open-emu instance create <name> [--cores N] [--memory MB]"
  shift || true
  while (($#)); do
    case "$1" in
      --cores) cores="${2:-0}"; shift 2 ;;
      --cores=*) cores="${1#*=}"; shift ;;
      --memory) memory_mb="${2:-0}"; shift 2 ;;
      --memory=*) memory_mb="${1#*=}"; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [[ "$cores" =~ ^[0-9]+$ && "$memory_mb" =~ ^[0-9]+$ ]] || die "cores and memory must be numeric"
  instance_ensure_main >/dev/null 2>&1 || true
  instance_create_from_source "$AVD_NAME" "$name" "$cores" "$memory_mb"
}

instance_clone() {
  local source="$AVD_NAME" name="" cores=0 memory_mb=0
  [[ -n "${1:-}" ]] || die "usage: open-emu instance clone [source] <name> [--cores N] [--memory MB]"
  if [[ -n "${2:-}" && "${2:0:1}" != "-" ]]; then
    source="$1"
    name="$2"
    shift 2
  else
    name="$1"
    shift
  fi
  while (($#)); do
    case "$1" in
      --cores) cores="${2:-0}"; shift 2 ;;
      --cores=*) cores="${1#*=}"; shift ;;
      --memory) memory_mb="${2:-0}"; shift 2 ;;
      --memory=*) memory_mb="${1#*=}"; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [[ "$cores" =~ ^[0-9]+$ && "$memory_mb" =~ ^[0-9]+$ ]] || die "cores and memory must be numeric"
  instance_create_from_source "$(instance_resolve_source_avd "$source")" "$name" "$cores" "$memory_mb"
}

instance_is_running() {
  local name="$1"
  eval "$(instance_get_env "$name")"
  if [[ -n "${INST_PID:-}" ]] && kill -0 "$INST_PID" 2>/dev/null; then
    return 0
  fi
  local pid_file
  pid_file="$(instance_dir "$name")/emulator.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    kill -0 "$pid" 2>/dev/null && return 0
  fi
  if [[ -x "${ADB_BIN:-}" ]] && "$ADB_BIN" devices 2>/dev/null | awk '{print $1, $2}' | grep -qx "emulator-${INST_CONSOLE_PORT} device"; then
    return 0
  fi
  return 1
}

instance_live_status() {
  local name="$1"
  if instance_is_running "$name"; then
    echo "running"
  else
    echo "stopped"
  fi
}

instance_list() {
  instance_state_init
  if [[ "${1:-}" == "--json" ]]; then
    instance_list_json
    return 0
  fi
  printf "%-18s %-24s %-8s %-8s %-6s %-9s %-9s %s\n" "NAME" "AVD" "CONSOLE" "ADB" "CORES" "MEMORY" "STATUS" "PID"
  while IFS=$'\t' read -r name avd console_port adb_port cores memory_mb status pid; do
    [[ -n "$name" ]] || continue
    status="$(instance_live_status "$name")"
    printf "%-18s %-24s %-8s %-8s %-6s %-9s %-9s %s\n" \
      "$name" "$avd" "$console_port" "$adb_port" "$cores" "${memory_mb}MB" "$status" "${pid:-}"
  done < <(
    python3 - "$INSTANCE_STATE_FILE" <<'PY'
import json
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
for inst in state.get("instances", []):
    print(
        "\t".join(
            str(inst.get(key, ""))
            for key in ("name", "avd", "console_port", "adb_port", "cores", "memory_mb", "status", "pid")
        )
    )
PY
  )
}

instance_list_json() {
  instance_state_init
  python3 - "$INSTANCE_STATE_FILE" "$STATE_DIR" "${ADB_BIN:-}" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
state_dir = Path(sys.argv[2])
adb = sys.argv[3]
devices = set()
if adb and Path(adb).is_file():
    try:
        out = subprocess.check_output([adb, "devices"], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device":
                devices.add(parts[0])
    except Exception:
        pass

rows = []
for inst in state.get("instances", []):
    name = inst.get("name", "")
    port = int(inst.get("console_port") or 0)
    pid = str(inst.get("pid") or "")
    running = False
    if pid:
        try:
            os.kill(int(pid), 0)
            running = True
        except Exception:
            running = False
    pid_file = state_dir / "instances" / name / "emulator.pid"
    if not running and pid_file.exists():
        try:
            os.kill(int(pid_file.read_text().strip()), 0)
            running = True
        except Exception:
            running = False
    serial = f"emulator-{port}"
    if serial in devices:
        running = True
    rows.append({
        "name": name,
        "avd": inst.get("avd"),
        "consolePort": port,
        "adbPort": int(inst.get("adb_port") or (port + 1)),
        "adbDevice": serial,
        "cores": inst.get("cores"),
        "memory": inst.get("memory_mb"),
        "status": "running" if running else "stopped",
        "running": running,
        "pid": pid,
        "lastApp": inst.get("last_app") or "",
        "sourceAvd": inst.get("source_avd") or "",
        "createdAt": inst.get("created_at") or "",
        "isolated": True,
    })
print(json.dumps({"ok": True, "instances": rows}, indent=2))
PY
}

instance_start() {
  local name="${1:-}"
  [[ -n "$name" ]] || die "usage: open-emu instance start <name>"
  instance_exists "$name" || die "instance not found: $name"
  if instance_is_running "$name"; then
    eval "$(instance_get_env "$name")"
    echo "instance=${name}"
    echo "status=running"
    echo "adb_device=emulator-${INST_CONSOLE_PORT}"
    echo "emulator=running"
    return 0
  fi

  eval "$(instance_get_env "$name")"
  [[ -x "$EMULATOR_BIN" ]] || die "emulator missing — run the install wizard or: make android-fetch"
  [[ -x "$ADB_BIN" ]] || die "adb missing — run the install wizard or: make android-fetch"
  [[ -d "$AVD_HOME/${INST_AVD}.avd" ]] || die "AVD missing: $INST_AVD"

  detect_host_profile
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"

  local gpu="$GPU_MODE"
  if (( HAS_KVM == 0 )) && [[ "$gpu" != "swiftshader" && "$gpu" != "swiftshader_indirect" ]]; then
    gpu="swiftshader"
  fi
  instance_set_config_keys "$AVD_HOME/${INST_AVD}.avd/config.ini" \
    "hw.cpu.ncore=${INST_CORES}" \
    "hw.ramSize=${INST_MEMORY_MB}" \
    "hw.gpu.mode=${gpu}" \
    "runtime.network.latency=none" \
    "runtime.network.speed=full"

  local headless=0
  if [[ "${ANDROID_HEADLESS:-}" == "1" || -z "${DISPLAY:-}" ]]; then
    headless=1
  fi

  local args=(
    -avd "$INST_AVD"
    -port "$INST_CONSOLE_PORT"
    -gpu "$gpu"
    -accel "$ACCEL"
    -netdelay none
    -netspeed full
    -no-boot-anim
    -no-metrics
    -no-snapshot-load
  )
  (( headless )) && args+=(-no-window)

  local log_file="$INSTANCE_LOG_DIR/${name}.log"
  mkdir -p "$INSTANCE_LOG_DIR" "$(instance_dir "$name")"
  : > "$log_file"
  log "starting instance ${name}: ${args[*]}"
  nohup "$EMULATOR_BIN" "${args[@]}" >>"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$(instance_dir "$name")/emulator.pid"
  echo "emulator-${INST_CONSOLE_PORT}" > "$(instance_dir "$name")/device"
  instance_upsert_state "$name" "$INST_AVD" "$INST_CONSOLE_PORT" "$INST_CORES" "$INST_MEMORY_MB" "starting" "$pid" "${INST_SOURCE_AVD:-$INST_AVD}" "${INST_LAST_APP:-}"
  echo "instance=${name}"
  echo "pid=${pid}"
  echo "console_port=${INST_CONSOLE_PORT}"
  echo "adb_device=emulator-${INST_CONSOLE_PORT}"
  echo "emulator=starting"
  echo "log=${log_file}"
}

instance_stop() {
  local name="${1:-}"
  [[ -n "$name" ]] || die "usage: open-emu instance stop <name>"
  instance_exists "$name" || die "instance not found: $name"
  eval "$(instance_get_env "$name")"

  if [[ -x "${ADB_BIN:-}" ]]; then
    "$ADB_BIN" -s "emulator-${INST_CONSOLE_PORT}" emu kill >/dev/null 2>&1 || true
  fi
  local pid_file
  pid_file="$(instance_dir "$name")/emulator.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
  if [[ -n "${INST_PID:-}" ]]; then
    kill "$INST_PID" 2>/dev/null || true
    kill -9 "$INST_PID" 2>/dev/null || true
  fi
  pkill -f "qemu-system.*${INST_AVD}" 2>/dev/null || true
  pkill -f "emulator.*-avd ${INST_AVD}" 2>/dev/null || true
  rm -f "$(instance_dir "$name")/device"
  instance_upsert_state "$name" "$INST_AVD" "$INST_CONSOLE_PORT" "$INST_CORES" "$INST_MEMORY_MB" "stopped" "" "${INST_SOURCE_AVD:-$INST_AVD}" "${INST_LAST_APP:-}"
  echo "instance=${name}"
  echo "status=stopped"
  echo "emulator=stopped"
}

instance_delete() {
  local name="${1:-}"
  [[ -n "$name" ]] || die "usage: open-emu instance delete <name>"
  [[ "$name" != "main" ]] || die "refusing to delete the main machine — clone a new one instead"
  instance_exists "$name" || die "instance not found: $name"
  eval "$(instance_get_env "$name")"
  instance_stop "$name" >/dev/null 2>&1 || true
  rm -rf "$AVD_HOME/${INST_AVD}.avd" "$AVD_HOME/${INST_AVD}.ini" "$(instance_dir "$name")"
  instance_remove_state "$name"
  echo "deleted=${name}"
  echo "avd=${INST_AVD}"
}

instance_batch() {
  local action="${1:-}"
  shift || true
  [[ "$action" == "start" || "$action" == "stop" ]] || die "usage: open-emu instance batch start|stop [name...]"
  local names=("$@")
  if ((${#names[@]} == 0)); then
    mapfile -t names < <(instance_all_names)
  fi
  local rc=0 name
  for name in "${names[@]}"; do
    [[ -n "$name" ]] || continue
    if [[ "$action" == "start" ]]; then
      instance_start "$name" || rc=1
    else
      instance_stop "$name" || rc=1
    fi
  done
  return "$rc"
}

instance_main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    ""|-h|--help|help) instance_usage ;;
    list) instance_list "$@" ;;
    ensure-main) instance_ensure_main "$@" ;;
    create) instance_create "$@" ;;
    clone) instance_clone "$@" ;;
    start) instance_start "$@" ;;
    stop) instance_stop "$@" ;;
    delete|rm) instance_delete "$@" ;;
    batch) instance_batch "$@" ;;
    *) instance_usage; die "unknown instance command: $sub" ;;
  esac
}
