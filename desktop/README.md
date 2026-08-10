# open-emulator desktop

LDPlayer-style desktop control shell for the `open-emulator` Android runtime.

## Install

```bash
cd /workspace/desktop
npm install
```

## Run

Start the HTTP control server:

```bash
npm run server
```

Open the Electron shell:

```bash
npm run electron
```

The server listens on `http://127.0.0.1:8787` and serves the SPA from
`desktop/public/`.

## API

- `GET /api/status`
- `POST /api/start`, `POST /api/stop`
- `POST /api/install` with JSON `{ "path": "/path/app.apk" }` or multipart APK
- `GET /api/screenshot`
- `GET /api/keymap`, `PUT /api/keymap`
- `POST /api/keymap/fire` with `{ "key": "j" }`
- `GET /api/instances`, `POST /api/instances`
- `POST /api/instances/:name/start`
- `POST /api/instances/:name/stop`
- `POST /api/instances/:name/clone`
- `GET /api/macros`, `POST /api/macros/:name/run`
- `GET /api/performance`, `POST /api/performance`
- `POST /api/files/push`, `POST /api/files/pull`
- `POST /api/gps`
- `POST /api/display`, `POST /api/audio`, `POST /api/network`

## Notes

The desktop shell wraps `../android/bin/open-emu` for emulator actions. Some
LDPlayer-style features, such as instance profiles and macros, store desktop
metadata under `desktop/data/` while the current Android control plane remains a
single AVD runtime.
