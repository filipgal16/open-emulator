# Shell redesign

The chrome around the device. Written first; the code follows this.

## 1. What is wrong with the shell today

The current shell is four products sharing a window.

The left rail is a place-switcher borrowed from an IDE: 72px of stacked icon-plus-caption for four destinations you visit a handful of times per session. The right rail is a guest-operator borrowed from an emulator: 48px of icon-only squares, three groups, nine buttons. The titlebar is a website header (brand left, account right, nothing in the middle). The bottom bar is a terminal status line that happens to hold Start — the one control that decides whether anything else in the window is real.

Those four dialects never got reconciled. Two vertical rails of different widths, different button shapes, and different labelling conventions face each other across the viewport and read as bolted-together apps. The device, which is the only reason the window exists, is the leftover rectangle in the middle — padded, shadowed, sitting in a well.

The scarce resource is horizontal space. A landscape PC window showing an Android surface already fights aspect ratio; 120px of permanent side chrome is a tax paid every minute, for a nav column whose contents do not act on the guest and a tool column that is half-dead whenever the guest is off. Seven of the nine tool buttons currently sit greyed out before the device is running. They do not explain themselves. They advertise that the chrome was designed for the running state and never given an idle one.

Start lives in the least prominent bar. The empty viewport already has a large “Start device” CTA; the status bar duplicates it at thumbnail size, next to a version picker and a phase label. The most important button in the app is visually equal to a dropdown of build flavours.

Theater mode almost understands the job — it kills the titlebar, the nav, and the status bar — but it leaves the mismatched right rail standing, and it has no opinion about leaving theater when you leave the device.

## 2. The concept

**The guest has a physical edge. The app has a titlebar. They share a corner, not a language.**

The window is a Γ: a horizontal member (where you are, whether the machine is on, who you are) and a vertical member (the keys a phone has on its edge). The rectangle they frame is Android. Navigation does not sit beside the device because it does not act on the device; it changes *which surface this window is showing*. Guest keys do not sit in the titlebar because they are not window chrome; they are the bezel of the thing you came to use. The bottom bar goes away. Start moves up into the titlebar, where it is reachable from every workspace and readable as the primary action. The bezel is floor-to-ceiling, so it reads as a phone edge rather than a toolbar glued to the stage. When you are not looking at the device, the bezel is not on screen — the panel (Apps, Store, Settings) is allowed to be the whole window. When the device is off, the bezel does not display seven corpses; it keeps the two window-level tools that still mean something and waits.

This suits an app whose entire purpose is to show one large rectangle of Android because it stops spending the scarce axis on a place-switcher, stops treating guest keys as a second application, and makes the idle and running states different shapes instead of the same shape with opacity.

LDPlayer’s reasoning, kept: guest-acting controls live on one edge, next to the surface they operate, and secondary things collapse. LDPlayer’s layout, not kept: we do not have instance tabs, we do not dump product features into a right-hand junk drawer, and we do not leave a sidebar up when the device is not the view.

## 3. Alternatives considered and rejected

**Hover-reveal / proximity bezel.** The brief asks whether the strip must be permanently visible. Overlay is illegal: a native child HWND will paint over anything that floats on `.viewport`, including a hover toolbar and its tooltips. In-flow reveal (bezel width 0→44px as the pointer nears the edge) is legal but resizes `.viewport` on every hover, which will resize the reparented guest. A running Android window that jitters when you move the mouse is worse than 44px of permanent chrome. Rejected.

**Unified left rail** (nav and tools stacked in one column, VS Code style). One edge is tidier than two, but it still taxes the scarce axis for place-switching, and it puts two kinds of thing in one stack: “go to Store” and “press Home” are not the same gesture. The idle problem remains — a taller column of dead buttons. Rejected.

**All chrome in the titlebar** (nav, Start, Back/Home/Recents, volume, account in one row). Legal, and it would give the device the entire width. It also puts Android system keys on the wrong axis, jams nine tool buttons into a bar that already has to hold identity and Start, and fails in a narrow window without a second row — which is a status bar by another name. Rejected.

**LDPlayer clone** (right junk-drawer, top instance tabs, tools that never leave). We have one instance, not a tab strip of them. A clone would copy the shape and miss the reason. Rejected on purpose.

## 4. ASCII wireframes

### Default window — Device workspace, guest running

```
┌─ app (row) ────────────────────────────────────────┬─ bezel ─┐
│ shell-head                                         │         │
│ ┌ titlebar 44px ─────────────────────────────────┐ │  [<]    │
│ │ [■] open-emu  ( Device │ Apps │ Store )  [⚙]   │ │  [⌂]    │
│ │                     ⋯  ● Running  [Stop] [Play Store ▾] [F]│
│ └────────────────────────────────────────────────┘ │  [▭]    │
│                                                    │  ────   │
│  stage / .viewport                                 │  [rot]  │
│  ┌──────────────────────────────────────────────┐  │  [cam]  │
│  │                                              │  │  [⛶]    │
│  │                 Android                      │  │         │
│  │                                              │  │  [vol-] │
│  │                                              │  │  [vol+] │
│  │                                              │  │  [pwr]  │
│  └──────────────────────────────────────────────┘  │         │
└────────────────────────────────────────────────────┴─────────┘
```

The bezel is a sibling of `.workspace`, not a child of the stage: it runs the full window height, titlebar included. Titlebar and bezel share `--chrome`, so the top-right corner is one material.

### Default window — Device workspace, guest stopped

```
┌─ app (row) ────────────────────────────────────────┬─ bezel ─┐
│ ┌ titlebar ──────────────────────────────────────┐ │  [rot]  │
│ │ [■] open-emu  ( Device │ Apps │ Store )  [⚙]   │ │  [⛶]    │
│ │                     ⋯  ● Stopped  [Start] [Play Store ▾] [F]│
│ └────────────────────────────────────────────────┘ │         │
│                                                    │         │
│  stage                                             │         │
│     waiting-mark + “Start device” (unchanged CTA)  │         │
└────────────────────────────────────────────────────┴─────────┘
```

Back, Home, Recents, Screenshot, Volume ±, and Power are omitted — not disabled. They return when the guest is live. Rotate and Fullscreen stay: they are window-level.

### Default window — Apps / Store / Settings

```
┌─ app (column, no bezel) ─────────────────────────────────────┐
│ ┌ titlebar ────────────────────────────────────────────────┐ │
│ │ [■] open-emu  ( Device │ Apps │ Store )  [⚙]             │ │
│ │                     ⋯  ● Running  [Stop] [Play Store ▾] [F]│
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  stage fills the remaining window                            │
│  (library / store / settings / account page)                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Start remains available without switching back to Device. Alt+← still sends Back: the tool rail stays mounted, hidden with `display: none`.

### Version menu open (in-flow, never over the viewport)

```
┌ shell-head ──────────────────────────────────────────────────┐
│ titlebar  (cluster includes the profile button, expanded)    │
├──────────────────────────────────────────────────────────────┤
│  Android version                                             │
│  [ Fast ]  [ Google apps ]  [ Play Store ]                   │
│  Each version keeps its own device…                          │
├──────────────────────────────────────────────────────────────┤
│  stage (viewport shrinks; HWND resizes once)                 │
└──────────────────────────────────────────────────────────────┘
```

Same contract as today: the menu is in-flow, it pushes the viewport, it does not float.

### Narrow window (≤860px)

```
┌──────────────────────────────────────────┬─ bezel ─┐
│ [■]  ( ■ │ ⊞ │ 👜 )  [⚙]   ● [Start] [▾] [F] │  keys  │
│                                          │         │
│  stage                                   │         │
└──────────────────────────────────────────┴─────────┘
```

Brand word, nav captions, phase text, Android meta, error line, and account caption hide. Every *control* remains: logo, four workspace targets, Start/Stop, profile picker, account chip, bezel keys.

At ≤640px the three-column version menu stacks to one column.

### Theater

```
┌─ stage (no titlebar, no nav, no status) ─────────┬─ bezel ─┐
│                                                  │  [<]    │
│                                                  │  [⌂]    │
│              Android, edge to edge               │  [▭]    │
│              (no well padding, no image radius)  │  ────   │
│                                                  │  [rot]  │
│                                                  │  [cam]  │
│                                                  │  [⛶]    │  ← pressed; Esc exits
│                                                  │  [vol]  │
│                                                  │  [pwr]  │
└──────────────────────────────────────────────────┴─────────┘
```

Theater is a state of the Device workspace. Switching to Apps/Store/Settings exits it. Escape still exits it and returns focus to the fullscreen button.

## 5. Full inventory of controls

Nothing is dropped. A few things move, merge visually, or hide in a state where they cannot act.

| Control | Today | After | Notes |
|---|---|---|---|
| Brand (logo + “open-emulator”) | Titlebar left | Titlebar left | Word hides at ≤860px; logo stays |
| Workspace: Device | Left rail, icon+label | Titlebar segmented control | Alt+1, `aria-current`, roving tabindex kept |
| Workspace: Apps | Left rail | Same segment | Alt+2 |
| Workspace: Store | Left rail | Same segment | Alt+3 |
| Workspace: Settings | Left rail, spacer-pushed to bottom | Icon-only button after the segment, still in the same nav | Alt+4. Not a fourth peer tab: it is still “a place you visit”. Accessible name remains “Settings” |
| Account chip | Titlebar right | Titlebar far right | Caption hides at ≤860px; avatar stays. Logic untouched |
| Sign-in / account page | Replaces stage | Unchanged | Still not over the viewport |
| Back | Right rail | Bezel, live only | Hidden (not disabled) when `!live`. Alt+← remains, listener stays mounted when the bezel is visually hidden |
| Home | Right rail | Bezel, live only | Same |
| Recents | Right rail | Bezel, live only | Same |
| Rotate | Right rail | Bezel, always when Device (or theater) is showing | Window-level; kept while stopped |
| Screenshot | Right rail | Bezel, live only | Same rule as Back |
| Fullscreen / Exit fullscreen | Right rail | Bezel, always when Device (or theater) is showing | Escape still exits. Pressed state kept |
| Volume down | Right rail | Bezel, live only | Same |
| Volume up | Right rail | Bezel, live only | Same |
| Power | Right rail | Bezel, live only | Same |
| Phase dot + label | Bottom bar | Titlebar cluster | Label hides at ≤860px; dot stays, `aria-live` kept |
| Android version meta (`Android 13 · API 33`) | Bottom bar, visible | Titlebar cluster when there is room; `title` on the phase otherwise | Display adaptation, not a removal |
| Error string | Bottom bar | Titlebar cluster, ellipsis | Hides at ≤860px (the Device idle placeholder already shows it) |
| Prepare device | Bottom bar, when unprovisioned | Titlebar cluster, same condition | |
| Start / Stop | Bottom bar | Titlebar cluster | Still Alt+S. Primary style when Start, danger style when Stop. The idle placeholder CTA stays — that is the empty *viewport*, not chrome; the titlebar button is how you start from Apps/Store/Settings |
| Android profile picker | Bottom bar | Titlebar cluster | Menu still in-flow: now a row *below* the titlebar, pushing the viewport down. Focus returns to the trigger. Escape closes it first |
| Theater mode | Class on `.app` | Class on `.app` | Hides `.shell-head` (titlebar + nav + cluster + menu). Bezel remains. Leaving Device exits theater |

**Bezel visibility.** The rail stays in the DOM whenever the app is ready, so Alt+← cannot vanish. It is `display: none` when the active workspace is not Device and theater is off.

**Roving tabindex, `role="toolbar"`, `aria-orientation="vertical"`, `aria-keyshortcuts`, focus-return on dialog close, `prefers-reduced-motion`:** all carried. Nav roving is now a horizontal group; `rovingIndex` already treats Left/Right as prev/next.

## 6. New / changed design tokens

All defined in the `:root` block of `desktop/src/renderer/index.html` and redefined for light where they are colours. No hex outside those blocks.

**New (scale — both themes, same values):**

| Token | Value | Role |
|---|---|---|
| `--titlebar-height` | `44px` | Command bar; slightly taller than today’s 40px so a segmented control and Start can sit on one baseline |
| `--bezel-width` | `44px` | Floor-to-ceiling guest edge. Down from 48px because the left 72px is gone and the bezel no longer has to impersonate a second app |
| `--bezel-btn-size` | `36px` | Tool hit target, named instead of hardcoded |

**New (colour — dark default, then light / `prefers-color-scheme: light`):**

| Token | Dark | Light | Role |
|---|---|---|---|
| `--nav-track` | `#12141a` | `#e2e5ec` | Inset well of the segmented control. Darker (or, in light, equal to `--bg-deep`) than `--chrome` so Device/Apps/Store read as one widget, not four titlebar links |

**Unchanged on purpose:** `--chrome` is still the material of both the titlebar and the bezel, so the Γ is one frame. `--accent-soft` / `--accent` still mark the active Settings icon and pressed Fullscreen. `--ok` / `--warn` / `--idle` still drive the phase dot. `--danger-*` still drives Stop.

**Contrast:** `--nav-track` sits behind `--text` / `--faint` labels on `--chrome`; selected segment uses `--surface` + `--text` (not `--faint` on `--accent-soft`) so the active workspace meets AA on both themes. Existing `--border` on the titlebar already meets AA against `--chrome`.

## 7. File-by-file change list

Off-limits (`src/main/**`, `src/shared/**`, Store/Account logic, hooks, `global.d.ts`) are not touched. Paths are under `desktop/`.

| File | Change |
|---|---|
| `design/shell-redesign.md` | This document |
| `desktop/src/renderer/index.html` | New tokens in `:root` and both light blocks. Replace the shell-chrome section: `.app` becomes a row (body column + bezel); `.workspace` becomes that column (head + stage); `.shell-head` / `.titlebar` / horizontal `.nav-rail` / `.nav-track` / `.device-cluster`; bezel width tokens; theater hides `.shell-head` and unbevels the guest image; version menu sits under the titlebar; `@media (max-width: 860px)` and `640px` compact rules; `.tool-rail.is-hidden` |
| `desktop/src/renderer/App.tsx` | Layout: `.app` → `.workspace` (head + stage) + `ToolRail`. `DeviceBar` owns the header and takes leading/trailing slots. `selectWorkspace` and Alt+1..4 exit theater when leaving Device. ToolRail always mounted |
| `desktop/src/renderer/components/NavRail.tsx` | Horizontal: Device/Apps/Store in a track, Settings as a utility icon in the same roving group. Labels stay in the DOM (accessible name); Settings label is visually hidden; all labels visually hidden at the narrow breakpoint via CSS |
| `desktop/src/renderer/components/DeviceBar.tsx` | Renders `<header class="shell-head">`: titlebar row (leading, spacer, cluster, trailing) and, when open, the in-flow version menu below it. Same state, shortcuts, focus, and listbox behaviour |
| `desktop/src/renderer/components/ToolRail.tsx` | `visible` prop toggles `.is-hidden`. Guest-only buttons omitted when `!live`. Rotate + Fullscreen remain. Window-level Alt+← listener unchanged. Toolbar a11y unchanged |
| `desktop/src/renderer/components/Icon.tsx` | No change (existing sprite covers every control) |
| `desktop/src/renderer/components/Account/AccountChip.tsx` | No logic change. Caption collapse is CSS (`.account-caption`) |
| `desktop/src/renderer/keyboard.ts` | Unchanged. Alt+1..4, Alt+S, Alt+←, Escape remain. `SHORTCUT_HELP` already describes them |
| `desktop/src/renderer/theme.ts` | Unchanged |
| `desktop/test/renderer/contrast.test.mjs` | Adds `--faint`/`--nav-track` and titlebar `--text`/`--muted` on `--chrome` to the AA pair list |

Theater CSS also zeroes `.android-screen` padding and the guest image’s radius/shadow, so in theater the rectangle *is* the window, with only the bezel left standing.
