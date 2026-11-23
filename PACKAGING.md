# Shipping open-emulator

```bash
cargo xtask dist     # -> target/dist/open-emulator-Setup-<version>.exe and latest.yml
```

`cargo xtask dist` (source: `xtask/src/dist.rs`) does three things, each of which can be run on its
own:

1. `cargo build --release -p oe-ui` builds the app, one executable (`open-emulator.exe`). The
   release profile uses fat LTO, one codegen unit, `panic = "abort"` and stripped symbols.
2. It stages the app in `target/dist/app/`: the executable, the subset of `android/` the app reads
   at run time (profiles, devices, the AVD config template), and the licence files (`LICENSE` if
   present, `LICENSING.md`, `THIRD-PARTY-NOTICES.md`). Generated trees such as the SDK, AVDs, state,
   logs, images and APKs are never copied.
3. `makensis` turns the stage into `open-emulator-Setup-<version>.exe` using
   `packaging/windows/installer.nsi`, and `latest.yml` is written next to it.

Options: `--skip-build` reuses the last release build; `--stage-only` stops after step 2, for a
machine without NSIS.

The version comes from `[workspace.package]` in `Cargo.toml`.

## Requirements

- Rust 1.90 or newer, MSVC toolchain, Visual Studio Build Tools (C++ workload).
- [NSIS](https://nsis.sourceforge.io/) with `makensis` on `PATH` or in
  `%ProgramFiles(x86)%\NSIS`. Not needed with `--stage-only`.

## What the installer does

One click, per user, no UAC prompt, offers to start the app when it finishes. It installs to
`%LOCALAPPDATA%\Programs\open-emulator` by default; the folder can be changed. Nothing large lands
in the install directory, so there is no reason to make anyone choose a drive: the Android SDK and
images are downloaded by the app, to a folder chosen in the app.

- It closes a running copy first, with the same request as the window's close button, so the
  emulator's window is handed back cleanly.
- It writes the Apps & features entry under `HKCU`, and Start menu and desktop shortcuts.
- Given `--force-run` (which updaters pass), it starts the app again when it finishes.
- **Uninstalling** removes the app files and shortcuts and leaves the install folder if anything
  else is in it. Settings, the account and the downloaded Android are never touched, by installing
  or by uninstalling.

## Updating from the Electron version

Installs of version 0.2.x and earlier were Electron apps installed in the same folder, under the
same name. This installer takes over from them:

- The Electron updater reads `latest.yml` from the latest GitHub release and runs the new installer
  with `--updated /S --force-run` into the folder it is installed in. Because this installer is
  per-user and `latest.yml` keeps the shape electron-builder wrote, that works without the old app
  knowing anything changed.
- The installer finds the Electron files in the install folder (recognised by
  `resources\app.asar`) and deletes them one by one, never the folder as a whole. It also removes
  the Electron version's Apps & features entry, found by the name of its uninstaller, then installs
  itself in its place.
- Shortcuts keep their paths, so the ones the user already has keep working.
- App data lives in the same places, so settings, the account and the downloaded Android carry
  over. A password stored by the Electron version is migrated to the new account store on first
  run.

This only works if the new version number is higher than the installed one.

## What a user still has to download

The installer is small. On first run the app downloads the emulator and a system image (about
1.1 GB) and builds its ROM, which the setup screen does by itself. **Say this on the download
page.** It is not a "download and run" app, and finding that out after double-clicking is a bad first
impression.

## Code signing

The installer is unsigned, so Windows SmartScreen shows *"Windows protected your PC"* and the user
has to click through **More info → Run anyway**. There is no way around this except a certificate:

- A standard OV certificate (about $200–400/yr) works immediately but builds SmartScreen reputation
  slowly: early downloaders still see the warning.
- An EV certificate costs more and carries reputation from the first signature.

Nothing in `cargo xtask dist` signs yet. With a certificate, sign `open-emulator.exe` before the
installer is built and the installer afterwards (for example with `signtool`); that is the step to
add to `xtask/src/dist.rs`. Until then the update check proves only that a file is the one published
on this repository's releases, because `latest.yml` and the installer come from the same place.

## Icon

The icon is generated rather than checked in as an opaque binary: `cargo xtask icon` regenerates the
PNG and ICO, and `cargo xtask dist` passes the ICO to NSIS.

## Version and releases

Bump the version in `[workspace.package]` in `Cargo.toml` before a release: installed copies only
update to a version higher than their own.

Releases are published by `.github/workflows/release.yml` when a `v<version>` tag is pushed:

```bash
# edit Cargo.toml: version = "0.3.1"
cargo check                                # updates Cargo.lock
git commit -am "Release 0.3.1" && git push
git tag v0.3.1 && git push origin v0.3.1   # tests, builds, publishes
```

The workflow, on a Windows runner:

1. Checks that the tag equals the workspace version (`v` plus the version of `oe-ui`) and refuses to
   continue otherwise.
2. Runs `cargo test --workspace`.
3. Installs NSIS if the runner image lacks it.
4. Runs `cargo xtask dist`.
5. For tags, creates the GitHub release with the installer and `latest.yml` attached, and
   generated notes.
6. Keeps both files as the workflow artifact `open-emulator-windows` for a week.

Both release files matter:

| File | Why |
|---|---|
| `open-emulator-Setup-<version>.exe` | The installer, for new users and for updates |
| `latest.yml` | Version, file name and SHA-512: what installed copies read to decide whether to update, and what the download is verified against |

Running the workflow by hand (**Actions → Release → Run workflow**) builds without publishing.

`.github/workflows/ci.yml` runs on pushes and pull requests: `cargo test --workspace` on Windows and
`cargo test -p oe-vmm` on Linux, where the KVM backend is compiled.

The README links to `releases/latest` rather than to a file, because the file name carries the
version and changes every release.

> **While the repository is private, release assets are private too.** A download link only works
> for people with repo access, and installed copies cannot see new releases: GitHub answers 404 to
> them, and Settings → Updates says so. Updating starts working for everyone the moment the
> repository is public. No token is built into the app to get around this: it would be readable by
> anyone who has the installer.

## How the app updates itself

The updater is in `oe-core`. It reads `latest.yml` from the latest release of this repository.

- **Checks are automatic; downloads are not.** The check only ever reports. Downloading and
  installing are each a button in Settings → Updates, and a dot on Settings says when there is
  something to do.
- **Never backwards.** A version that is not higher than the running one is never offered.
- **Verified, to a point.** The download is checked against `latest.yml`'s SHA-512 before it can
  install. Until the installer is code-signed, this proves it is the file published on this
  repository's releases and nothing more: whoever controls the repository controls what installs.
- **Installs silently, per user.** "Restart to update" quits, runs the installer without its pages
  (it already knows where the app lives), and reopens the app. Closing the app after a download
  installs it too.
- **Development runs do not update.**

## Troubleshooting a build

**`makensis` not found.** Install NSIS, or use `cargo xtask dist --stage-only`.

**Linker errors about `link.exe`.** The MSVC toolchain and the Visual Studio Build Tools are
missing, or Rust is set to the GNU toolchain. Run `rustup default stable-x86_64-pc-windows-msvc`.
