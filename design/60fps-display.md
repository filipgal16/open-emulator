# 60fps: show the guest's window instead of photographing it

## The problem, stated exactly

`EngineMirror` polls `adb exec-out screencap -p` on a 250ms timer. That caps the device at 4fps and
measures ~2.8fps, because a capture takes ~400ms. Every frame is a full PNG encoded in the guest,
piped over adb, and decoded in the renderer.

**No amount of tuning reaches 60fps down this path.** Halving the interval does not help when a
single capture costs 400ms. The approach is the ceiling.

## The fix, and why it is not speculative

The emulator is *already* rendering the guest at full speed on the real GPU, into its own Qt
window. `factory.ts:83` launches it with `windowed: true`, so `emulatorArgs` omits `-no-window` and
that window exists right now — we are simply photographing it instead of showing it.

`engine/window-embed.ts` is a complete, unit-tested Win32 embedding API that reparents that window
into ours with `SetParent`. It is referenced from nowhere.

The one missing link: **`SdkEngine.displayHandle()` is a stub that returns `null`**
(`sdk-engine.ts:428`). The window is never located, so nothing can embed it.

After this change the frame rate is the emulator's own — no polling, no encode, no decode. Input
also stops paying an `adb shell input` round trip per gesture, because mouse and keyboard go
straight to the emulator window.

## Design

### 1. The engine exposes a pid, not a handle

Rename `displayHandle(): Promise<number | null>` to **`displayPid()`** across the `AndroidEngine`
interface, both engines, and `client.ts`.

An `HWND` from koffi is an opaque pointer, not a number, so the current signature cannot carry one.
More importantly, embedding is presentation: it belongs in main beside the `BrowserWindow`, not in
the engine. The engine knows the emulator's pid (`sdk-engine.ts:239-253` already tracks it); main
turns that into a window.

WSL returns `null` — it has no window — and that null is what selects the mirror fallback.

### 2. A `GuestWindow` controller in main

New `src/main/guest/guest-window.ts`, owning the embedded window's whole lifecycle:

- `attach(pid, parentHandle)` — `waitForWindow`, then `embedWindow`
- `setBounds(rect)` — `moveWindow`
- `setVisible(v)` — the airspace escape hatch
- `detach()` — on guest stop
- `isLive()` — the emulator may have exited underneath us

Every call is guarded: if koffi fails to load, or the window never appears, the controller reports
failure and the app falls back to the mirror rather than showing nothing.

### 3. The renderer reports the viewport's rectangle

`useDisplayScale` already measures the viewport with a `ResizeObserver` and converts to device
pixels. Extend it to send **position as well as size**, plus a `visible` flag.

Page coordinates map straight onto the parent window's client area, so device pixels are
`getBoundingClientRect()` values times `devicePixelRatio` — the same conversion already there.

### 4. The airspace rule, enforced

A child HWND paints over the page; nothing in HTML can be drawn on top of it. The embedded window
is visible **only** when the Device workspace is showing, the guest is running, and no dialog is
open. Everything else hides it.

The shell redesign already assumes this — its panels expand in-flow rather than floating — so the
two changes fit together rather than fighting.

### 5. Consequences that must be handled, not discovered later

- **The mirror stops driving the device view.** It stays alive only for the Store's Play frame,
  where a slow still is fine.
- **The screenshot button breaks.** It reads the last mirrored frame (`peekGuestFrame`), and with
  embedding there are no frames. It must call a main-side `screencap()` on demand — better anyway,
  since it then captures at full resolution rather than whatever the mirror last managed.
- **Tap/swipe forwarding becomes dead weight for the device view.** The embedded window takes its
  own input. Forwarding stays for the Play frame.

## Verification

- `dumpsys gfxinfo` / `SurfaceFlinger` frame stats from inside the guest, as evidence of the render
  rate actually achieved — an honest number, not an assertion that polling stopped.
- Confirm the window embeds, tracks the viewport on resize, and hides on workspace switch.
- Confirm the fallback: with `OPEN_EMULATOR_ENGINE=wsl`, `displayPid()` returns null and the mirror
  still works.
- Unit tests for the controller against a fake embedding API.
- Full suite stays green.

## Risk

The honest one: `SetParent` across processes can fail, and a Qt window may not take being
reparented cleanly on every driver. If it misbehaves, the fallback to the mirror must be automatic
and silent, not a broken window. That is why every step is guarded and why the mirror is kept
rather than deleted.
