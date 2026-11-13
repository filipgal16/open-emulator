# Plan: a smooth 60 FPS guest display

**Status: draft, pending external review** (see [60fps-plan-review.md](60fps-plan-review.md)).
Nothing here is implemented yet. Every claim marked *verified* was checked against code in this
repository or against the Android Emulator 37.1.11 binaries and `.proto` files. Claims marked
*to verify on Windows* are assumptions that the phase-1 spike exists to settle.

---

## 1. What "smooth 60 FPS" means here

Measured while the guest scrolls a long list and while it runs a continuous animation (§8):

| Metric | Target: ROG Strix G15 (Ryzen 7 6800H) | Target: Latitude 5410 (4-core U-series) |
|---|---|---|
| Frames presented in the app, median over 10 s | **≥ 58 fps** | ≥ 50 fps |
| Present-to-present interval, p95 / p99 | ≤ 20 ms / ≤ 33 ms | ≤ 25 ms / ≤ 40 ms |
| Frames dropped between emulator and screen (from `seq` gaps) | < 1 % | < 5 % |
| Touch-down → first changed frame on screen | ≤ 50 ms | ≤ 70 ms |
| Guest composition rate (SurfaceFlinger) during the same test | ≥ 58 fps | ≥ 50 fps |

The last row matters. If the guest itself renders at 40 fps, no display path can show 60.

## 2. Where it is today (verified)

| Stage | Today | Ceiling it imposes |
|---|---|---|
| **Guest rendering, native runtime** | `-gpu host` when accelerated and windowed (`desktop/src/main/engine/sdk/host.ts` `chooseGpuMode`) | Fine. The real GPU renders |
| **Guest rendering, WSL runtime** | SwiftShader/lavapipe, CPU only (`android/lib/common.sh` `detect_host_profile`); `-gpu host` hangs headless there | Uncertain 60 even before display |
| **Frame source** | `adb exec-out screencap -p`: PNG-encoded **inside the guest** per frame | ~150–400 ms per frame is typical for PNG encoding at 720p *(estimate)* |
| **Frame pacing** | WSL: capture, then a fixed 300 ms sleep (`src/main/wsl/screen-mirror.ts`). Native: 250 ms interval, skipped while a capture is in flight (`src/main/engine/engine-mirror.ts`) | **≤ 3.3 fps / ≤ 4 fps by construction** |
| **Transport to UI** | Whole PNG over IPC → `Blob` → object URL → `<img>` (`src/renderer/hooks/useGuestScreen.ts`) | Decode per frame; no pacing |
| **Input** | `pointerup` → `adb shell input tap|swipe` (`GuestSurface.tsx`, `guest/input.ts`). A drag is replayed *after* release | ~100–300 ms per event *(estimate)*, no live drag, no fling, no multi-touch |
| **The emulator's own window** | Native engine launches it **visible** (`factory.ts` `windowed: true`) but never embeds it: `displayHandle()` returns `null` (`sdk-engine.ts`) | A second, floating emulator window sits on the desktop |

So there are two separate problems. **Frames**: 4 fps by design. **Input**: replayed on release.
Both need fixing for anything to feel smooth.

## 3. What the emulator offers (verified against 37.1.11)

From `emulator/lib/emulator_controller.proto` and `emulator -help` in the SDK this project downloads:

- `streamScreenshot(ImageFormat) → stream Image`. Frames come from the **host-side renderer**, with no
  guest-side encoding. A frame is sent **only when the guest posts a new one**. `format` can be
  `RGBA8888`, `RGB888` or `PNG`. `width`/`height` ask the emulator to **scale on the host**. Each
  `Image` has a `seq` (gaps = dropped frames) and a `timestampUs` (production time).
- `ImageTransport { channel: MMAP, handle }`: pixels are written **straight into shared memory
  or a `file:///` mapping** the client owns, and the gRPC message carries only metadata. The proto
  warns this "can result in tearing".
- `streamInputEvent(stream InputEvent)`: one long-lived stream of touch (multi-pointer, pressure),
  mouse, wheel and key events, injected on the host side with no adb and no process spawn.
  `KeyboardEvent` accepts W3C `key` values.
- `streamAudio`: guest audio, which would also fix "audio not routed" (not required for 60 fps).
- `rtc_service.proto`: WebRTC signalling (host-side encoding, for remote viewing).
- Flags: `-qt-hide-window` (Qt window, and so a GPU context, exists but stays hidden), `-grpc <port>`,
  `-grpc-use-token` (console-token auth; JWT is the default), `-idle-grpc-timeout`, `-share-vid`.
- The running emulator advertises itself in `…/avd/running/pid_<pid>.ini` (seen on Linux: "Advertising
  in: /root/.android/avd/running/pid_6376.ini"). *To verify on Windows:* its location and which
  `grpc.*` keys it carries.

To my knowledge this is also what Android Studio's embedded "Running Devices" emulator view is built
on (not verified here).

## 4. Options considered

| | A. Embed the emulator window | **B. gRPC frames → WebGL canvas** | C. scrcpy H.264 → WebCodecs | D. Emulator WebRTC → `<video>` |
|---|---|---|---|---|
| Frame source | Emulator paints its own HWND | Host renderer, shared memory | **Guest** MediaCodec encoder | Host encoder (VP8/H.264) |
| Existing code | `window-embed.ts` (+ 6 Win32 tests) | none | `cursor/mint-branding-57e9:desktop/lib/mirror.js` (old JS app) | none |
| Reaches 60? | Yes, natively | Likely; bounded by copy + IPC cost (§6) | Doubtful: the guest's software AVC encoder competes with the app for guest CPU | Likely, at host-encode CPU cost and jitter-buffer latency |
| Latency | Lowest | Low (no encode) | Encode + decode | Highest (jitter buffer) |
| HTML over the device (toasts, dialogs, rotation, Play frame) | **No**: the airspace rule; each overlay must hide the window | Yes, it is just a canvas | Yes | Yes |
| Cross-process `SetParent` hazards (attached input queues: a hung emulator can stall the UI thread; mixed-DPI scaling; focus) | **Yes** | No | No | No |
| Works for the WSL runtime | No (WSLg windows are RDP-remoted) | Degraded: no shared memory across the VM, so bytes over TCP | **Yes**: compressed, needs only adb | Yes |
| Measurable per frame | No | **Yes** (`seq`, `timestampUs`) | Partly (pts) | Partly (WebRTC stats) |
| Unlocks key mapping / recording / live drag | Input goes to the window, so key mapping needs gRPC anyway | **Yes** | Yes (control socket) | Partly |

**Decision: B is the primary path for the native runtime, with A as the fallback.** The choice is
confirmed by a short measured spike (phase 1) before any production code.

B keeps the UI exactly as designed (overlays, rotation, the Play frame reusing `GuestSurface`). It
avoids the cross-process window hazards, gives per-frame measurement for free, and fixes input
through the same channel. A is kept because it is the one option guaranteed to show 60 fps if B's
copy and IPC cost turns out too high on the Latitude.

**The WSL runtime is not a 60 fps target.** Its guest renders in software (§2). It gets C (a port
of the mint branch's scrcpy mirror) as a separate, lower-priority track, and the recommendation is to
make the native runtime the default.

## 5. Phases

Each phase ends with something measurable. Nothing in phases 2–5 starts until phase 1's gate is
passed.

### Phase 0: instrument before changing anything
- **Guest side.** Add an `fps` probe to `emu-compare.mjs` (`dumpsys SurfaceFlinger --latency <layer>`
  or `dumpsys gfxinfo <pkg> framestats`) during a scripted scroll. It runs unchanged against
  LDPlayer too, which gives the comparison figure.
- **App side.** A diagnostics overlay (dev toggle): presented fps, p95/p99 interval, dropped frames,
  and last input-to-frame latency. For the current PNG path it establishes the baseline. It must not
  sit over an embedded window (only relevant if A wins).
- **Workloads.** Settings list scrolled by `input swipe` in a loop; ApiDemos
  (`io.appium.android.apis`, fetched with `npm pack android-apidemos`) *Graphics → OpenGL ES → Kube*
  for continuous 60 fps content; *Views → Animation* for UI-thread animation.
- **Acceptance.** Baseline numbers recorded for both laptops, for open-emulator (native + WSL) and
  LDPlayer.

### Phase 1: spike and decision gate (1–2 days, throwaway code on a branch)
1. **Guest can render 60.** Launch natively with `-gpu host -qt-hide-window -grpc-use-token` (plus a
   fixed `-grpc <port>` if discovery is awkward). Confirm with SurfaceFlinger that composition reaches
   the §1 targets. If it can't, stop and fix this first (GPU driver, cores, resolution).
   `host.ts` treats "has a window" as the condition for `-gpu host`, so `-qt-hide-window` must count
   as having one.
2. **B, minimal.** A Node script using `@grpc/grpc-js` + `@grpc/proto-loader` with the protos loaded
   from the installed SDK (`<sdk>/emulator/lib/*.proto`, not vendored). It runs `streamScreenshot`
   `RGBA8888` at the viewport's device-pixel size, `MMAP` to a `file:///` mapping read through
   `koffi` (`CreateFileMappingW`/`MapViewOfFile`, the same FFI approach as `window-embed.ts`),
   copies each frame, and posts it over a `MessageChannelMain` to a bare WebGL2 page. Measure fps,
   intervals, drops and CPU.
   - *To verify:* the exact `handle` format on Windows (file URL vs named section). Fallback: bytes
     in the gRPC message (`RGB888`, scaled). That's more CPU, but no shared-memory unknowns.
3. **A, minimal.** Wire `displayHandle()` to `findMainWindowForProcessTree` (hidden-window aware:
   today it requires `IsWindowVisible`) + `embedWindow`, and measure the same workloads.
4. **Gate.** Choose B if it meets §1 on the ROG and ≥ 50 fps on the Latitude. Otherwise choose A and
   accept the airspace rule. Record the numbers in this file.

### Phase 2: frames (B, production)
- `src/main/engine/emulator-grpc.ts`: connection (discovery file or fixed port + token), proto
  loading, lifecycle tied to engine start/stop, reconnect on emulator restart. Localhost only,
  never an unauthenticated port.
- `src/main/engine/frame-stream.ts`: `streamScreenshot` + shared-memory mapping. Copy each frame out
  immediately on arrival (tearing mitigation). Latest-wins backpressure with ≤ 2 frames in flight to
  the renderer, so a slow renderer drops stale frames rather than queueing them. Restart the stream
  on size change (debounced ~150 ms).
- **IPC.** A dedicated `MessagePort` for frames, with metadata `{seq, width, height, timestampUs}`
  alongside the pixels, not the existing `mirror:frame` channel.
- **Renderer.** `GuestCanvas` (WebGL2, `texSubImage2D` into a persistent texture, one quad, vertical
  flip because rows arrive bottom-up) replaces the `<img>` inside `GuestSurface`. `GuestSurface`'s
  props and behaviour stay identical, so `AndroidScreen` and `PlayFrame` need no change. Present on
  `requestAnimationFrame`, newest frame only. Report the canvas's device-pixel size (`ResizeObserver`
  × `devicePixelRatio`, capped at the guest's native resolution) so the emulator scales on the host.
- **Fallback.** If gRPC fails to connect, keep today's `EngineMirror` (PNG) path and log why. The
  engine must never end up with no picture at all.
- **Power.** Pause the stream when the window is hidden or minimised, or the Screen/Play surface
  isn't mounted.
- CSP needs no change: WebGL and `blob:` are local. `connect-src 'none'` stays.

### Phase 3: input
- Pointer events → `streamInputEvent` `TouchEvent` on `pointerdown/move/up/cancel` (pointer id →
  touch identifier, pressure), sent immediately. This gives live drags, flings and multi-touch.
- Coordinates: map from canvas space to the **guest's native resolution**, not the scaled frame size.
  Reuse `GuestSurface`'s rotation-aware mapping, fed by the known display size.
- Wheel → `WheelEvent`. Keys → `KeyboardEvent` with W3C `key`/`code`, but only while the surface has
  focus, so the shell's keyboard shortcuts keep working.
- Keep `adb shell input text` for `typeText`/`typeSecret` (the sign-in flow) and for the WSL engine.

### Phase 4: tuning
- `RGBA8888` vs `RGB888` (less copy, but WebGL RGB upload may be slower). Measure both.
- Default device panel stays 720×1280. The 1080p device profiles (Pixel 5, Redmi Note 11) get
  their own measured row.
- High-refresh panels: the ROG's 144 Hz display shows a 60 fps stream with 2-/3-refresh cadence.
  Present on rAF; note it rather than fight it.
- Animation scales: `provision.sh` sets them to 0.5. Leave them; they affect duration, not smoothness.

### Phase 5: WSL track and defaults (separate, lower priority)
- Port `cursor/mint-branding-57e9:desktop/lib/mirror.js` (scrcpy v4.1, H.264, WebCodecs, control
  socket) to the TypeScript engine as `ScrcpyMirror`, `max_fps=60`, used only by the WSL engine.
  Its guest-side encoder cost is measured, not assumed.
- Propose making `OPEN_EMULATOR_ENGINE=sdk` (native) the default once phases 2–3 pass on both laptops.

### Phase 6: verification and docs
- Re-run §8 on both laptops. Record the §1 table for open-emulator native, WSL, and LDPlayer
  (guest-side fps only for LDPlayer).
- Unit tests (`node --test`, run on Linux CI): proto message builders, discovery-file parser,
  coordinate mapping incl. rotation, backpressure queue, stream-restart debounce, fallback selection.
  Windows-only tests (skipped elsewhere, like `window-embed`) cover shared-memory mapping.
- Update README (Status, Screen section) and `documentation.md` with the measured numbers.

## 6. Cost estimate for B (arithmetic, to be measured in phase 1)

A 1080p laptop display at 125 % scaling showing a device viewport ≈ 560 × 1000 device px:
RGBA ≈ **2.2 MB/frame → ≈ 134 MB/s at 60 fps**. That's per frame: one copy out of shared memory,
one IPC transfer, one texture upload, i.e. a few milliseconds of a 16.7 ms budget. At native 720 ×
1280 it is 3.7 MB/frame (221 MB/s). This is why the stream is requested at viewport size rather
than device size, and why IPC throughput is the first thing the spike measures.

## 7. Risks and open questions

| Risk | Mitigation |
|---|---|
| `MMAP` handle format on Windows is undocumented here | Spike step 2; fallback to bytes in the message (`RGB888`, scaled) |
| Main→renderer IPC can't sustain the rate on the Latitude | Measure in the spike; smaller frames; else window embedding (A) |
| `-gpu host` misbehaves on some drivers | Detect from the emulator log; fall back to `angle_indirect`, then `swiftshader_indirect`, and show the resulting fps honestly |
| gRPC auth changes across emulator versions (JWT is the default in 37.1.11; the native engine downloads the latest emulator, unpinned) | Use `-grpc-use-token`; load protos from the installed SDK; startup self-test with a clear error |
| Tearing with `MMAP` | Copy immediately on the frame message; compare `seq` before/after the copy in debug builds |
| `-qt-hide-window` + snapshots: a hidden-window boot may still record a renderer the next windowed boot rejects | Keep one launch mode for everything (always `-qt-hide-window`). Re-provision once, as for any GPU change |
| Cross-process `SetParent` (only if A is chosen) | Hide the window during overlays; test hung-emulator behaviour explicitly |

## 8. Test protocol on the laptops (when implementing)

1. Plugged in, performance power mode, other apps closed. The ROG on the dGPU; note which GPU the
   emulator log reports.
2. Per configuration, 3 runs × 10 s of each workload (scroll, Kube, animation), alternating open-emulator
   and LDPlayer runs as `bench_paired.ps1` does.
3. Record the §1 metrics, host CPU % (emulator + Electron processes), and GPU %.
4. Pass/fail against §1. Attach the raw numbers to the PR.

## 9. Out of scope for this plan
Key mapping, multi-instance, audio routing, recording. B makes all of them easier and none of them
is needed for 60 fps.
