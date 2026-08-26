# Becoming an LDPlayer-class emulator

A plan, written before any of it is built. Ordered by what actually blocks the goal, not by what
is easiest or most visible.

## Where we actually are

Honest inventory, verified against the code rather than remembered:

**Real and working.** A native Windows runtime that boots Android with no WSL (cold 37s, warm 4.9s,
1.1 GB first-run download). A product shell with four workspaces, an app library, an app store with
F-Droid and sideloading, a device-wide Google account with autofill, a setup wizard, real settings
(theme, device identity spoofing, CPU/RAM, storage, keyboard), an NSIS installer, and 363 tests.

**Built but not connected.** `engine/window-embed.ts` — a complete Win32 embedding API
(`findMainWindowForProcessTree`, `waitForWindow`, `embedWindow`, `moveWindow`, `clientSize`),
unit-tested, and referenced from **nowhere** in `index.ts`.

**Half-built.** `QemuEngine` — the hard parts (ISO9660, cpio, initrd, args) are done; the process
orchestration and the ext4 `/data` question are not.

**The default is still WSL.** `resolveEngineId` returns `wsl`. The native path is opt-in via an
environment variable that no user will ever set.

## The two facts that separate us from LDPlayer

Everything else in this document is downstream of these. They are not polish.

### 1. We show Android as a slideshow

`EngineMirror` polls `adb exec-out screencap -p` on a 250ms timer — a 4fps ceiling, and measured at
**~2.8fps** because a capture takes ~400ms. Each frame is a full PNG: encoded in the guest,
transferred, decoded in the renderer, turned into a blob URL.

LDPlayer does not do this. It renders the guest with the GPU into its own window at 60fps.

No GUI feature fixes this. A keymapping editor, a multi-instance manager, and a macro recorder all
inherit the 3fps ceiling and are all useless on top of it. **This is the single highest-value
change in the codebase, and the code to fix it is already written and sitting unwired.**

### 2. Every tap spawns a process

`client.tap` → `engine.shell('input tap x y')` → `adb.exec` → `ProcessRunner.run` → `spawn(adb.exe)`.

One `adb.exe` process per tap. Worse, `run()` is the **queued** variant (`runUnqueued` exists and is
used elsewhere), so taps serialise behind one another. Realistic cost is 30–80ms of process startup
per event before Android sees anything.

That is survivable for tapping a Settings toggle. It is fatal for anything a person would call
gaming, which is the entire reason LDPlayer's audience uses LDPlayer.

## Phase 1 — Make the device real

Nothing in Phase 2 is worth starting before this lands.

### 1.1 Wire the native window into the viewport

The emulator already has a real GPU-accelerated window; we are photographing it instead of showing
it. `window-embed.ts` reparents that HWND into our viewport with `SetParent`.

- Reparent the guest window into `.viewport` once `waitForWindow` resolves.
- Track the viewport's bounds and `moveWindow` the child to match.
- Hide it when the workspace is not Device; show it on return.
- Keep `EngineMirror` alive **only** for the Store's Play frame and for screenshots, where a slow
  still is perfectly adequate.

*Pairs directly with the window-scaled resolution work just landed:* `wm size` sets the guest's
logical display, `moveWindow` sizes the host window showing it. Both are needed and they are not
the same lever.

**Risk, and it is real:** an embedded child HWND paints over everything. No HTML can float above it
— that constraint is why the shell redesign put every panel in-flow. It also captures its own
input, which collides with 1.2 below.

### 1.2 A persistent input channel

Replace process-per-tap with a channel that stays open.

Two candidates, in preference order:

1. **The emulator's gRPC endpoint.** `emulator -grpc <port>` exposes `sendKey`, `sendTouch`, and
   `streamScreenshot`. Purpose-built, low latency, and the screenshot stream may also improve the
   Play-frame mirror as a side effect.
2. **A long-lived `adb shell`** holding one process open and writing events into it, bypassing
   per-event spawn. Cruder, but engine-agnostic and it works on both runtimes.

Success is measured, not asserted: **median input latency under 20ms**, versus the current
30–80ms-plus-queueing.

### 1.3 Make native the default, and decide about WSL

The comment guarding `resolveEngineId` says WSL stays until the native engine has booted a guest on
a real machine. It has. The condition has expired.

Flip to `sdk` after one verified end-to-end run, then decide honestly whether the WSL engine earns
its maintenance. Two runtimes means every guest feature is written twice — the quoting-depth bug
was exactly that tax being paid.

### 1.4 Cut QemuEngine

A second unfinished runtime is a liability, not an asset. The SDK emulator is what LDPlayer-class
performance actually requires. Recommend deleting it or parking it on a branch; keep the pure
codecs (`iso9660`, `cpio`), which are independently useful and already tested.

## Phase 2 — The GUI that defines the category

This is where "mainly GUI" gets spent, and it is only affordable once Phase 1 is done.

### 2.1 Keymapping — the reason people choose LDPlayer

Map WASD and the mouse onto touch points, saved per app.

- A visual editor: drop a key onto a spot on the screen, name it, save.
- Presets for the common shapes — a twin-stick MOBA layout, an FPS aim/fire layout.
- Per-app profiles that activate when that package comes to the foreground.

**The overlay conflict, and the way through it.** The editor needs to draw controls on top of the
device, and an embedded HWND makes that impossible. But the overlay is only needed while *editing*.
So: **edit in mirror mode, play with the embedded window.** Editing is a rare, deliberate mode where
3fps is irrelevant; playing is where the frames matter. This costs one mode switch and avoids
writing a layered Win32 overlay.

Depends entirely on 1.2. Keymapping on a spawn-per-tap input path would be a worse experience than
no keymapping at all.

### 2.2 Multi-instance

LDPlayer's other defining feature: several Android instances at once, with a manager to clone,
rename, start, and batch-operate them.

Be clear-eyed — **this is the largest refactor in the plan.** `index.ts` holds exactly one `engine`,
one `openEmu`, one `mirror`, one `DisplayScaler`, and every IPC handler closes over them. It needs
an instance registry, per-instance IPC addressing, and a manager UI.

Worth it, but it should be scheduled as its own project, not slipped in beside a feature.

### 2.3 Performance controls with feedback

Settings already has cores and RAM. What is missing is the part that makes it usable: telling the
user what their choice actually *did*.

- Resolution and DPI presets alongside the new window-scaled mode.
- FPS cap, GPU renderer choice.
- A live readout: current FPS, CPU, RAM, and whether hardware acceleration is genuinely on.
- Surface the WHPX/acceleration state in the GUI rather than only during setup.

### 2.4 A shared folder

A Windows folder visible inside Android, and screenshots and recordings landing somewhere a person
can find them. Today a screenshot goes through a browser download of a blob URL.

### 2.5 Macro recording

Record a sequence of taps and replay it. Cheap once 1.2 exists, and it is table stakes in this
category.

## Phase 3 — Commercial polish

- **Auto-update.** Shipping an installer with no update path means version one is forever.
- **Virtual GPS** and sensor spoofing.
- **Proxy and network settings.**
- **First-run onboarding** that explains what is downloading and why 1.1 GB is unavoidable.
- **Diagnostics** the user can export when something breaks.

## Ordering, and why

```
1.1 embed the window ─┐
                      ├─→ 1.3 native default ─→ 2.1 keymapping ─→ 2.5 macros
1.2 input channel ────┘                     ─→ 2.3 perf controls
                                            ─→ 2.4 shared folder

1.4 cut QEMU        (independent, anytime)
2.2 multi-instance  (its own project, after 1.x)
```

1.1 and 1.2 are independent of each other and can run in parallel. Everything in Phase 2 depends on
at least one of them.

## What I would do first

**1.1.** The code exists, it is unit-tested, and it converts the product from a 3fps slideshow into
a real Android window. It is the largest visible improvement available for the least new code, and
it is the honest prerequisite for calling this LDPlayer-class at all.
