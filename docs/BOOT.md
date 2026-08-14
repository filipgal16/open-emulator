# Boot speed

The ~30 second start target is a **KVM snapshot restore** after the guest
has been provisioned once. It is not a cold boot of Android 11, and it is
not available under TCG (no `/dev/kvm`, or `/dev/kvm` present but not
readable/writable by this user).

## What you should see

| Path | When | Typical time to `sys.boot_completed=1` |
|------|------|----------------------------------------|
| **Warm** | Emulator process already running | Immediate (no reboot) |
| **Snapshot** | `/dev/kvm` usable **and** a provisioned `booted` snapshot exists **and** cores/RAM/GPU have not changed since that snapshot | **≤30s** (often 8–20s) |
| **Cold (KVM)** | First boot, `--cold`, snapshot missing/incompatible, or hardware changed | A few minutes |
| **Cold (TCG)** | No usable KVM | ~3 minutes on the hosts we've measured; keep the process alive and subsequent `start` is warm |

`open-emu status` prints `boot_path=warm|snapshot|cold` and `stage=stopped|adb|booting|ready` so you can tell which path a launch actually took. The desktop boot overlay shows the same `boot_path` next to the stage.

## What has to be true for ≤30s

1. The user can read **and** write `/dev/kvm` (membership in the `kvm` group, Intel VT-x / AMD-V enabled). Presence of the device node is not enough.
2. `make android-provision` (or the install wizard's first-machine step) has completed once. That saves the named snapshot `booted` with setup-wizard skipped, animations off, and network up.
3. Later starts do **not** change `hw.cpu.ncore`, `hw.ramSize`, or `hw.gpu.mode`. The control plane now leaves `config.ini` alone when those already match; changing them in the Performance panel is a deliberate cold-boot.

Clones that keep the source's cores and RAM also keep the source snapshot, so a new tab's first start is a snapshot restore rather than a cold boot.

## What we changed to make that path actually run

The desktop and `open-emu start` always go through `instance start`. That path previously passed **`-no-snapshot-load` on every launch**, so the provisioned snapshot was never used. Snapshot load now goes through the same helper as the (rarely used) non-instance `start_emulator` path:

- Load `-snapshot booted -no-snapshot-save` on KVM when the snapshot exists and hardware is unchanged.
- Fall back to a cold boot if the emulator log reports a snapshot load failure.
- TCG still skips named snapshots — upstream QEMU/Emulator often rejects or segfaults them without KVM.

Other launch costs that were eating time even on a good snapshot:

- `config.ini` was rewritten every start (and GPU was forced to `swiftshader` even on KVM, which also made snapshots incompatible). Writes now happen only when a value actually changes (`android/lib/avd_config.py`).
- Software GL is `swiftshader_indirect` (the mode the Emulator actually recommends), not the older `swiftshader`.
- No 5-second sleep after spawn; adb/boot polls are 0.2s / 0.4s instead of 1s / 2s.
- Snapshot restore uses a **45s** failure timeout for adb and `boot_completed`, not the 3–30 minute cold-boot timeouts.
- Headless launches (the desktop default) pass `-no-window -no-audio`.
- `-skip-adb-auth` and `-no-boot-anim` are always on.
- `setup_avd.sh` no longer writes a `hardware-qemu.ini` with a different RAM size than `config.ini`.
- Provision turns animation scales to 0 and polls for the snapshot directory in 0.25s steps instead of 2s.

## What this sandbox cannot measure

This environment has an empty `android/sdk/emulator/emulator` stub, no `adb`, no system image, and `/dev/kvm` is not readable by the agent user. Helper logic is covered by `make android-test` (`android/scripts/test_boot_helpers.sh`). A real ≤30s number needs `make android-fetch && make android-setup && make android-provision && make android-start` on a KVM host; `start finished in Ns` in the runtime log is the measurement.

TCG cold boot was previously measured here at **~175–180s**. That number is unchanged in kind: TCG will not hit 30s until the process is already running (warm path).
