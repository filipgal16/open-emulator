#!/usr/bin/env bash
# Connectivity helpers: audio, network, bluetooth for open-emu.
# shellcheck disable=SC2034

ensure_host_audio() {
  # Start PulseAudio when possible so the emulator can play/record.
  if ! command -v pulseaudio >/dev/null 2>&1; then
    echo "none"
    return 0
  fi
  if ! pulseaudio --check 2>/dev/null; then
    pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
    sleep 1
  fi
  if command -v pactl >/dev/null 2>&1; then
    if ! pactl list short sinks 2>/dev/null | grep -q openemu_out; then
      pactl load-module module-null-sink \
        sink_name=openemu_out \
        sink_properties=device.description=OpenEmulator >/dev/null 2>&1 || true
    fi
    pactl set-default-sink openemu_out >/dev/null 2>&1 || true
  fi
  if pulseaudio --check 2>/dev/null; then
    echo "pulse"
    return 0
  fi
  echo "none"
}

detect_audio_backend() {
  local forced="${ANDROID_AUDIO_BACKEND:-auto}"
  case "$forced" in
    none|pulse|alsa|sdl|wasapi) echo "$forced"; return 0 ;;
  esac
  # auto
  local host
  host="$(ensure_host_audio)"
  if [[ "$host" == "pulse" ]]; then
    echo "pulse"
  elif [[ -d /dev/snd ]]; then
    echo "alsa"
  else
    echo "none"
  fi
}

apply_guest_network() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  "$adb" -s "$device" shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell svc wifi enable >/dev/null 2>&1 || true
  "$adb" -s "$device" shell svc data enable >/dev/null 2>&1 || true
  "$adb" -s "$device" shell cmd wifi set-wifi-enabled enabled >/dev/null 2>&1 || true
  "$adb" -s "$device" shell settings put global mobile_data 1 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell settings put global wifi_on 1 >/dev/null 2>&1 || true
  # Prefer automatic DNS; fall back to public resolvers if private DNS is stuck.
  "$adb" -s "$device" shell settings put global private_dns_mode opportunistic >/dev/null 2>&1 || \
    "$adb" -s "$device" shell settings put global private_dns_mode off >/dev/null 2>&1 || true
  # Unmetered Wi-Fi for downloads / Play.
  "$adb" -s "$device" shell cmd netpolicy set restrict-background false >/dev/null 2>&1 || true
}

apply_guest_audio() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  # Max media / notification / system volumes (stream types 3/5/1).
  "$adb" -s "$device" shell media volume --show --stream 3 --set 15 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell media volume --show --stream 5 --set 15 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell media volume --show --stream 1 --set 7 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell settings put system volume_music 15 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell settings put system notification_sound_enabled 1 >/dev/null 2>&1 || true
  # Ensure audioserver is up.
  "$adb" -s "$device" shell start audioserver >/dev/null 2>&1 || true
}

apply_guest_bluetooth() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  "$adb" -s "$device" shell settings put global bluetooth_on 1 >/dev/null 2>&1 || true
  "$adb" -s "$device" shell svc bluetooth enable >/dev/null 2>&1 || true
  "$adb" -s "$device" shell cmd bluetooth_manager enable >/dev/null 2>&1 || true
  # Allow scanning / connections from apps.
  "$adb" -s "$device" shell settings put global ble_scan_always_enabled 1 >/dev/null 2>&1 || true
}

guest_network_report() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  echo "== wifi =="
  "$adb" -s "$device" shell dumpsys wifi 2>/dev/null | awk '/^Wi-Fi is |mNetworkInfo|SSID:|mWifiInfo/{print; if(++n>=6) exit}'
  echo "== data =="
  "$adb" -s "$device" shell dumpsys telephony.registry 2>/dev/null | awk '/mDataConnectionState|mServiceState/{print; if(++n>=4) exit}' || true
  echo "== reachability =="
  if "$adb" -s "$device" shell ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
    echo "ping_8.8.8.8=ok"
  else
    echo "ping_8.8.8.8=fail"
  fi
  if "$adb" -s "$device" shell ping -c 1 -W 2 dns.google >/dev/null 2>&1; then
    echo "ping_dns.google=ok"
  else
    echo "ping_dns.google=fail"
  fi
  "$adb" -s "$device" shell ip addr show wlan0 2>/dev/null | awk '/inet /{print "wlan0="$2}' | head -1 || true
}

guest_audio_report() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  echo "== host_backend =="
  echo "backend=$(detect_audio_backend)"
  echo "== guest =="
  "$adb" -s "$device" shell getprop init.svc.audioserver | tr -d '\r' | awk '{print "audioserver="$1}'
  "$adb" -s "$device" shell getprop ro.hardware.audio.primary | tr -d '\r' | awk '{print "audio_hal="$1}'
  "$adb" -s "$device" shell dumpsys audio 2>/dev/null | awk '/- STREAM_MUSIC:/{p=1} p&&/streamVolume|Muted:/{print} p&&/^$/{if(++c>1) exit}' | head -10
}

guest_bluetooth_report() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  echo "== bluetooth =="
  "$adb" -s "$device" shell dumpsys bluetooth_manager 2>/dev/null | awk '
    /^Bluetooth Status$/{p=1}
    p && /enabled:|state:|address:|name:/{print}
    p && /^$/{exit}
  '
  echo "note=Emulator provides a virtual Bluetooth controller; host HCI passthrough needs BlueZ + KVM/QEMU BT and is optional"
}

play_audio_smoke() {
  local device="$1"
  local adb="${ADB_BIN:-adb}"
  # Soft system tick — proves the audio path is alive even on null sinks.
  "$adb" -s "$device" shell cmd media_session dispatch play >/dev/null 2>&1 || true
  "$adb" -s "$device" shell twoway msg -d media >/dev/null 2>&1 || true
  # Play a short UI sound if present.
  if "$adb" -s "$device" shell ls /system/media/audio/ui/Effect_Tick.ogg >/dev/null 2>&1; then
    "$adb" -s "$device" shell cmd media play /system/media/audio/ui/Effect_Tick.ogg >/dev/null 2>&1 || \
      "$adb" -s "$device" shell am start -a android.intent.action.VIEW -t audio/\* -d file:///system/media/audio/ui/Effect_Tick.ogg >/dev/null 2>&1 || true
  fi
  echo "audio_smoke=triggered"
}
