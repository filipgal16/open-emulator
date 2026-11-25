# Android guest data

What the app reads to describe and configure an Android guest. The code that drives the guest
(downloading the SDK, creating the AVD, starting, provisioning and stopping the emulator) is in
`crates/oe-engine`; this folder is the data it works from, shipped beside `open-emulator.exe`.

## Layout

```text
android/
  profiles/*.env         The Android versions a user can choose (image, API level, RAM hint)
  devices/*.env          The identities a guest can report as (brand, model, panel, density)
  config/avd_config.ini  The AVD hardware template every AVD starts from
  apps/                  App files dropped here appear in the Store under "On this PC"
  imported/              Image identity and last verified results, kept for reference
  MODIFICATIONS.md       What the open-emulator ROM changes in Google's stock image
  VERSION.txt            The image versions these profiles were verified against
```

The SDK, AVDs, snapshots and per-guest state are not here: they live under
`%LOCALAPPDATA%\open-emulator` (or the folder chosen in Settings), because they are gigabytes and
belong to the machine, not to the app.

## Profiles and devices

A profile names a system image (`PROFILE_SYSTEM_IMAGE`, `PROFILE_IMAGE_TAG`), its API level, and
optionally the stock image a ROM of ours is built from (`PROFILE_BASE_IMAGE_TAG`) and a RAM hint.
The file name is the profile's id, which is what Settings stores and what the Android version menu
lists. A device file sets the build properties and panel the guest reports, so apps that refuse to
run on an emulator see a real handset.

## Performance model

| Host | Acceleration | Start |
|------|--------------|-------|
| Windows Hypervisor Platform (or AEHD) available | on | Quick Boot snapshot after the first provision: a warm start resumes in seconds |
| No hypervisor | off | A cold boot every time, on a software CPU, and much slower |

Cores and memory are measured defaults for the machine (see `crates/oe-engine/src/host.rs`) and can
be overridden in Settings. A change of hardware discards the snapshot, because the emulator refuses
to restore one onto different hardware, and the next start provisions again.
