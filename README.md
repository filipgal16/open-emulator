# open-emulator

Step-by-step open Android emulator. **This repository currently implements step 1: a Type-2 virtual machine monitor (hypervisor userspace).**

## What this is

`open-vmm` is a minimal host program that:

1. Allocates guest physical memory
2. Loads a flat guest binary into that memory
3. Runs a virtual CPU until the guest executes `HLT`
4. Emulates a serial port (`COM1` / `0x3f8`) so the guest can print output

Two backends:

| Backend | When used | How it works |
|---------|-----------|--------------|
| **kvm** | `/dev/kvm` present | Linux KVM — hardware virtualization (Intel VT-x / AMD-V) |
| **soft** | fallback / `--backend=soft` | Tiny in-process 16-bit instruction interpreter |

`auto` (default) picks KVM when available, otherwise soft.

This is the foundation a later Android stack would sit on (bootloader → Linux/Android kernel → devices). It is **not** an Android emulator yet.

## Build

```bash
make
```

Produces:

- `build/open-vmm` — the VMM
- `build/guest/hello.bin` — demo real-mode guest

## Run

```bash
# Prefer software backend (works without /dev/kvm)
make run

# Or explicitly:
./build/open-vmm --backend=soft build/guest/hello.bin

# On a host with KVM:
./build/open-vmm --backend=kvm build/guest/hello.bin
```

Expected guest serial output:

```text
open-emulator: guest is alive
```

## Test

```bash
make test
```

## Layout

```text
include/     Public headers (vmm, serial, soft CPU)
src/         VMM, KVM backend, soft CPU, serial device
guest/       Guest assembly source
android/     Android 11 guest import + run scripts
scripts/     Guest assembler + smoke test
build/       Build outputs
```

## Requirements

- Linux, `gcc`, `make`, `python3`
- For the KVM backend: `/dev/kvm` (user in `kvm` group), CPU with VT-x/AMD-V

## Android guest (API 30 / Android 11)

Imported under [`android/`](android/). Control plane: `android/bin/open-emu`.

```bash
make android-fetch        # download SDK + Android 11 image (~4 GiB, once)
make android-setup
make android-provision    # cold boot, tune for real use, save fast snapshot
make android-start        # snapshot boot (seconds–minutes depending on KVM)
./android/bin/open-emu install path/to/app.apk
./android/bin/open-emu launch com.android.settings/.Settings
./android/bin/open-emu doctor
```

See [`android/README.md`](android/README.md).

## Install it

```bash
cd desktop && npm install && npm run dist:win
# -> desktop/release/open-emulator-Setup-<version>.exe
```

One click, no options, launches when it finishes. On first run the app installs WSL2, the Linux
packages Android needs, and the Android system image itself — no terminal, no commands. See
[`desktop/PACKAGING.md`](desktop/PACKAGING.md).

## Desktop shell

Electron app under [`desktop/`](desktop/), driving the WSL2-hosted Android backend.

```bash
make desktop-install
make desktop-dev
make desktop-test
```

It carries an optional ad-supported mode, **off by default** — a source build, a fork, or a distro
package ships no ads and renders no ad markup. See [`desktop/ADS.md`](desktop/ADS.md).

### Store

The shell's **Store** tab installs apps into the guest from three sources: the F-Droid catalogue
(searched locally, every download verified against its published digest), the real Google Play
client running inside the guest, and local APKs dropped onto the window. It also carries a
device-wide account that spans every guest profile. See [`desktop/STORE.md`](desktop/STORE.md).

Play needs the `play` guest profile, which uses Google's own Play-enabled system image:

```bash
ANDROID_PROFILE=play make android-fetch android-setup android-provision
OPEN_EMULATOR_ANDROID_PROFILE=play make desktop-dev
```

## Next steps

1. Grow `open-vmm` toward long mode + virtio/goldfish (replace Emulator QEMU)
2. Desktop UI: key mapping, audio routing
3. Multi-instance / profiles
