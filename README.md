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
scripts/     Guest assembler + smoke test
build/       Build outputs
```

## Requirements

- Linux, `gcc`, `make`, `python3`
- For the KVM backend: `/dev/kvm` (user in `kvm` group), CPU with VT-x/AMD-V

## Next steps (not in this PR)

1. Multiboot / Linux kernel boot (64-bit long mode, page tables, e820)
2. Virtio devices (console, block, net)
3. Android / AOSP guest image bring-up
4. Host UI: APK install, key mapping, audio routing
