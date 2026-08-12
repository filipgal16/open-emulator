# open-emulator desktop

Native emulator window: Android guest on the left, mint **host-control
sidebar** on the right, **LDPlayer-style tabs** on top (one tab per isolated
machine). First launch is a themed install wizard.

Brand assets live in [`../brand/`](../brand/).

## Install & run

```bash
cd desktop
npm install
npm start
```

Or `make desktop` from the repo root. The launcher script is
[`bin/open-emulator`](bin/open-emulator); the wizard can install a `.desktop`
shortcut.

## Layout

```text
┌──────── tabs (machines) ── [+] ── Start/Stop ─┐───┬──────────────┐
│                                               │ R │              │
│   Active machine screenshot                   │ u │  tool panel  │
│                                               │ n │  (scoped to  │
│                                               │ … │   this tab)  │
└───────────────────────────────────────────────┴───┴──────────────┘
```

| Rail tab | Host feature |
|----------|----------------|
| Run | Start / stop, status for the **active tab** |
| APK | Install packages onto that machine |
| Keys | On-screen keymap |
| Inst | Create / clone / delete isolated VMs |
| Macro | Tap automation |
| Perf | CPU / RAM / GPU |
| Files | Push / pull |
| GPS | Location spoof |

`+` on the tab bar clones a new isolated AVD (separate userdata and adb port).
Background machines keep running; the viewport multiplexes screenshots.

The shell wraps `../android/bin/open-emu --instance <name>`.
