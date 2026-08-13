# open-emulator

A mint-branded, LDPlayer-class Android emulator: a native desktop shell
around isolated, multi-instance Android virtual machines, built on top of
a from-scratch Type-2 virtual machine monitor. **Early access — no ads, no
account, no telemetry.** See [Product status](#product-status) below for
what that means and what's next.

The rest of this README covers the low-level VMM this is built on. For the
product itself — install wizard, tabs, isolated machines, packaging — see
[Brand & desktop shell](#brand--desktop-shell).

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
desktop/     Mint-branded host control shell (GUI, packaged with electron-builder)
brand/       Color tokens, logo, typography guidelines
web/         Static marketing/download site (see web/README.md)
docs/        Roadmap, monetization plan, legal/privacy/EULA/notices
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

## Next steps

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full breakdown. Short
version: sign and publish real installers, then live screen mirroring
(the biggest gap versus a "real" LDPlayer-class feel), then the
monetization plan in [`docs/MONETIZATION.md`](docs/MONETIZATION.md), then
a cross-platform (Windows-first) control plane, then growing `open-vmm`
itself toward an independent guest image that no longer depends on
Google's Android SDK at all.

## Brand & desktop shell

Host-side identity (mint palette, logo, fonts) lives in [`brand/`](brand/).
The control GUI is a **native window**: guest screen, **top tabs** (one per
isolated machine), and a mint **sidebar**. First launch opens a themed
install wizard — host check, an explicit Android SDK License Agreement
step (nothing downloads before that's accepted), the SDK fetch, and your
first isolated machine. A desktop shortcut is optional.

```bash
cd desktop && npm install && npm start
# or: make desktop
```

```bash
./android/bin/open-emu instance list
./android/bin/open-emu instance create game-2
./android/bin/open-emu --instance game-2 start
```

## Distribution & website

```bash
make dist   # cd desktop && npm run dist — AppImage + deb via electron-builder
make web    # node web/build.mjs — builds the static site into web/dist/
```

[`desktop/electron-builder.yml`](desktop/electron-builder.yml) ships only
the `android/` control-plane code and `brand/` assets inside installers —
never the SDK, AVDs, or any other runtime data (see
[`desktop/lib/paths.js`](desktop/lib/paths.js) for where that lives once
packaged). [`.github/workflows/release.yml`](.github/workflows/release.yml)
builds all three platforms' installers in CI on a tagged push. See
[`web/README.md`](web/README.md) for the site and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what's left before these are
signed, published installers instead of CI artifacts.

## Product status

No ads, no account, no telemetry, no paid tier — today. That's a
deliberate starting point, not the end state:

- [`docs/MONETIZATION.md`](docs/MONETIZATION.md) — concrete examples of
  how ads/monetization could work later (self-hosted ad rail, affiliate
  offers, a Pro tier, website display ads), none of them wired up yet.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — sequencing for that plus
  distribution, screen mirroring, and cross-platform support.
- [`LICENSE`](LICENSE) (Apache-2.0) and [`docs/NOTICES.md`](docs/NOTICES.md)
  — this project's own license and third-party attributions.
- [`docs/LEGAL.md`](docs/LEGAL.md) — why the Android SDK is fetched, never
  bundled, and why standard AdSense/Ad Manager can't run inside the app.
- [`docs/EULA.md`](docs/EULA.md) / [`docs/PRIVACY.md`](docs/PRIVACY.md) —
  end-user terms and what is (and isn't) collected.
