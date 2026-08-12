# open-emulator desktop

Native emulator window with a **mint host-control sidebar** docked beside the
Android guest screen. This is a desktop app (Electron) — not a browser website.

Brand assets live in [`../brand/`](../brand/).

## Install & run

```bash
cd desktop
npm install
npm start
```

## Layout

```text
┌─────────────────────────────┬───┬──────────────┐
│                             │ R │              │
│   Android guest screen      │ u │  tool panel  │
│   (live screenshot)         │ n │  (forms for  │
│                             │ … │   keymap,    │
│                             │   │   perf, …)   │
└─────────────────────────────┴───┴──────────────┘
         viewport              rail   drawer
```

| Rail tab | Host feature |
|----------|----------------|
| Run | Start / stop, status |
| APK | Install packages |
| Keys | On-screen keymap |
| Inst | Instance profiles |
| Macro | Tap automation |
| Perf | CPU / RAM / GPU |
| Files | Push / pull |
| GPS | Location spoof |

The sidebar wraps `../android/bin/open-emu`. Optional CLI subcommands that are
not on your branch yet return a soft error in the panel log.
