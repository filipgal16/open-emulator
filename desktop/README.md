# open-emulator desktop

Mint-branded host control shell for the `open-emulator` Android runtime.

Brand tokens, logos, and voice live in [`../brand/`](../brand/).

## Install

```bash
cd desktop
npm install
```

## Run

```bash
npm run server
# open http://127.0.0.1:8787
```

Electron (optional):

```bash
npm run electron
```

## What it covers (host-side)

| Panel | Purpose |
|-------|---------|
| Home | Start/stop, live screenshot, APK drag-drop |
| Keymap | Visual on-screen button bindings |
| Instances | Named profiles / clones |
| Macros | Tap & keyevent automation |
| Performance | CPU / RAM / GPU / FPS + device toggles |
| Files | Push / pull with the guest |
| Location | GPS spoof via emulator console |

The shell wraps `../android/bin/open-emu`. Features that need newer CLI
subcommands degrade gracefully with a clear message.

## Brand

- Palette: mint leaf on cool paper (`brand/tokens.css`)
- Type: Fraunces (display) + Sora (UI) + IBM Plex Mono (logs)
- Mark: leaf-device monogram in `brand/logo/`
