# open-emulator

Step-by-step open Android emulator. **This repository currently implements step 1: a Type-2 virtual machine monitor (hypervisor userspace).**

## What this is

`open-vmm` is a minimal host program that:

1. Allocates guest physical memory
2. Loads a flat guest binary into that memory
3. Runs a virtual CPU until the guest executes `HLT`
4. Emulates a serial port (`COM1` / `0x3f8`) so the guest can print output
5. Prepares long-mode page-table/GDT scaffolding and a virtio-mmio stub for
   future 64-bit guests

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
make test-long
```

## Layout

```text
include/     Public headers (vmm, serial, soft CPU, long mode, virtio-mmio)
src/         VMM, KVM backend, soft CPU, serial, long-mode, virtio-mmio
guest/       Guest assembly source
android/     Android 11 guest import + run scripts
desktop/     Desktop shell prototype
docs/        Design notes and implementation status
scripts/     Guest assembler + smoke test
tests/       Native C tests
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
./android/bin/open-emu keymap run          # host key → on-screen tap
./android/bin/open-emu doctor
cd desktop && npm install && npm run server   # LDPlayer-style control UI
```

See [`android/README.md`](android/README.md) and [`desktop/README.md`](desktop/README.md).

## Next steps

1. Finish long-mode CPU entry and concrete virtio/goldfish devices (boot Linux/Android on open-vmm)
2. Harden multi-instance sync under real multi-AVD load
3. Package the desktop shell for Windows/Linux installers
