# The Store

A **Store** tab in the desktop shell that finds apps, installs them into the guest, and remembers
the account those installs belong to.

Before this, the only way to get an app into the guest was `open-emu install app.apk` from a
terminal. The Store is what turns the runtime into something usable without one.

## Three sources, one search box

| Source | Where apps come from | How it renders |
|---|---|---|
| **F-Droid** | The published `index-v2.json` catalogue, downloaded once and searched locally | Native tiles |
| **Play** | The real Google Play app, running inside the guest | Mirrored guest surface in our chrome |
| **Local** | APKs in `android/apps/`, plus anything dropped onto the window | Native tiles |

### F-Droid

The whole catalogue is fetched once, distilled down to the fields the UI renders
(`src/main/store/fdroid-index.ts`), cached under `userData`, and refreshed with a conditional GET
at most every 12 hours.

Searching locally rather than per-keystroke is not only faster — it means no request leaves the
machine while you type, the Store works with the network down, and F-Droid's servers see one
conditional GET a day instead of one per character.

Every download is verified against the `sha256` the index publishes for that exact APK, **before**
the file is offered to the guest. A mismatch deletes it and fails the job. An APK is executable
code: "came from the right URL" is a weaker claim than "is the artefact the catalogue published",
and only the second one is worth acting on.

> Not yet done: verifying the index's *own* signature (`entry.jar` is JAR-signed and names the
> index digest). Today the index is trusted over pinned TLS and each APK is checked against it.

### Play

There is no Play API client anywhere in this codebase, and no scraped listings. Google's own client
runs in the guest; the Store mirrors it, frames it, and steers it with `market://` intents. Input —
tap, drag-to-swipe — is forwarded through the same `GuestSurface` the Screen tab uses.

That is a deliberate choice over reimplementing Play's private protobuf API (what Aurora Store
does). Wrapping the real client means Play's UI, its account handling, and its installs are exactly
current because they are Play's; nothing here can break when Google changes an interface we were
never calling; and no one's Google account is at risk for automating an endpoint that forbids it.

It needs the `play` guest profile — Google's own `google_apis_playstore` system image, which is the
only one that ships `com.android.vending`:

```bash
ANDROID_PROFILE=play make android-fetch
ANDROID_PROFILE=play make android-setup
ANDROID_PROFILE=play make android-provision
```

Then start the shell with `OPEN_EMULATOR_ANDROID_PROFILE=play` so it drives that guest.

If `make` reports `unknown profile 'play'`, the backend copy inside the distro predates this build.
The setup wizard's *Backend synced into distro* step now checks for every profile this build ships,
not just that `open-emu` exists, so re-running it refreshes the copy.

> That sync also normalises line endings, and has to. Git's `core.autocrlf=true` — the usual
> Windows default — checks these scripts out with CRLF, and bash cannot parse those: `open-emu`
> fails with `/usr/bin/env: 'bash\r': No such file or directory`. `.gitattributes` pins LF for
> fresh clones; the sync's `sed` covers working copies that already have CRLF on disk.

**Play certification and device spoofing are mutually exclusive.** The Play image is certified
against its own build fingerprint. Rewriting `build.prop` to impersonate a Pixel
(`customize_device.sh` / `build_custom_image.sh`) produces *"device is not Play Protect certified"*
and blocks sign-in. The Play tab detects a spoofed fingerprint and says so rather than letting you
fight a login that cannot succeed. Use `full` (`google_apis`) for device-spoofing work.

Also note the Play image is a user build: `adb root` is refused on it.

### Local

Drag an APK onto the window. The package name is deliberately *not* parsed out of the file —
`installer.ts` diffs `pm list packages -3` across the install and learns the real package from the
guest, which knows the answer exactly and for free.

## The device-wide account

One profile that spans every AVD and device profile the shell manages, rather than living inside
one guest. It is in the tab bar, so "the account" means one thing across the whole shell.

Sign-in is a ladder, each rung falling through to the next:

1. **Already signed in.** `dumpsys account` finds a `com.google` account. This is the usual state:
   accounts live in userdata and `open-emu provision` snapshots userdata, so once you have signed
   in, every later start comes back signed in.
2. **Assisted sign-in.** Opens Google's own add-account screen in the guest and offers to type a
   stored address and password into the focused field. You complete the flow, including any
   two-factor or verification step.
3. **Manual.** The flow is on screen; drive it yourself.

**What this cannot do is silently log you into Google.** Google's sign-in is deliberately resistant
to automation, and a helper app cannot add a Google account either — `addAccountExplicitly` is
signature-gated to GMS. Rung 2 is autofill, in the sense a password manager is: your own credential,
into Google's real UI, with every challenge left to you. Automating past a human-verification step
is exactly what those steps exist to prevent.

### Where the password goes

Storing a Google password locally is a real risk, so:

- It is **opt-in and off by default**; the Store works fine on rungs 1 and 3 without it.
- It is encrypted by the OS keychain via Electron's `safeStorage`. With no working keychain the
  vault stores **nothing** rather than falling back to a file — a password manager that silently
  degrades to plaintext is worse than none, because you would believe the first one.
- It crosses IPC exactly once, inbound, when you type it into the dialog. Nothing ever reads it back
  out to the renderer: the renderer asks for the *action*, not the value.
- Typing it does not put it in a command line. It is handed to WSL as an environment variable
  (`WslBridge.runOpenEmuWithEnv`) rather than interpolated into the `wsl.exe` argv, where any
  process listing could read it.

## Layout

```
src/shared/store-types.ts        StoreApp, AppDetail, InstallJob, StoreState
src/shared/account-types.ts      AccountProfile, GuestAccountState, AccountState
src/main/image-cache.ts          https-only, byte-sniffed, hex ids
src/main/guest-input.ts          tap/swipe/key/text command builders + escaping
src/main/shell-quote.ts          POSIX quoting for the two shells between here and the guest
src/main/store/
  index.ts                       ← the only file here that imports electron
  fdroid-index.ts                pure distil/search over index-v2
  catalog.ts                     merges the searchable sources
  installer.ts                   download → verify → push → install
  guest-facts.ts                 API level, Play presence, spoofed identity, AVD name
  play.ts                        drives the guest's Play client
  sources/{source,fdroid,local}.ts
src/main/account/
  index.ts                       ← the only file here that imports electron
  profile.ts  vault.ts  guest-account.ts  signin-driver.ts
src/renderer/components/Store/   StoreView, AppCard, AppDetail, InstallQueue, PlayFrame
src/renderer/components/Account/ AccountChip, SignInDialog
src/renderer/components/GuestSurface.tsx   mirror + input, shared by Screen and Play
```

Everything under `store/` and `account/` except the two `index.ts` files is plain Node with no
electron import, which is what lets the logic be tested against the compiled output with
`node --test`.

## Renderer boundaries

The window keeps `default-src 'self'` with `connect-src 'none'`. It issues no network request of
its own, so no repository can fingerprint or track it. Icons and screenshots reach it over
`oe-app://`, served by the main process from its own on-disk cache after the bytes have been
sniffed.

For the same reason, an app's website and source links render as selectable text rather than
clickable links: the shell deliberately has no "open this URL" primitive reachable from the
renderer, and a store page is not a good enough reason to add one.
