# Third-party notices

open-emulator's desktop shell includes the software below. Their licences require that these
copyright notices travel with the distributed product; this file is that notice.

Everything here is permissive: MIT, ISC, BSD and Apache-2.0, plus the Python Software Foundation
and Blue Oak licences for two small dependencies of the updater. Nothing in the shipped application
is under a copyleft or non-commercial licence. See [`../LICENSING.md`](../LICENSING.md) for the full audit,
including the parts the app downloads at runtime rather than ships.

---

## Bundled into the renderer

These are compiled into `dist/renderer/bundle.js`.

### React, React-DOM, scheduler

MIT License — Copyright (c) Facebook, Inc. and its affiliates.

### loose-envify

The MIT License (MIT) — Copyright (c) 2015 Andres Suarez &lt;zertosh@gmail.com&gt;

### js-tokens

The MIT License (MIT) — Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell

---

## Loaded by the main process

Not bundled into the renderer, but shipped with the application.

### koffi

MIT License — Copyright (c) Niels Martignène

A foreign-function interface, used to call `user32` and `kernel32` so the emulator's own window can
be embedded in the app rather than photographed frame by frame. Chosen over a native addon because
it ships prebuilt binaries, which keeps node-gyp, MSVC, and `electron-rebuild` out of the build.

### electron-updater, and what it depends on

The in-app updater (`src/main/update/`). It checks this project's GitHub releases, and downloads and
installs a new version only when asked. Everything below ships inside `app.asar` because of it.

| Package | Licence | Copyright |
|---|---|---|
| electron-updater, builder-util-runtime | MIT | Copyright (c) 2015 Loopline Systems |
| fs-extra | MIT | Copyright (c) 2011-2017 JP Richardson |
| jsonfile | MIT | Copyright (c) 2012-2015, JP Richardson |
| universalify | MIT | Copyright (c) 2017, Ryan Zimmerman |
| js-yaml | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin |
| lazy-val | MIT | Vladimir Krivosheev |
| lodash.escaperegexp | MIT | Copyright jQuery Foundation and other contributors |
| lodash.isequal | MIT | Copyright JS Foundation and other contributors |
| tiny-typed-emitter | MIT | Copyright (c) 2020 Zurab Benashvili |
| debug | MIT | Copyright (c) 2014-2017 TJ Holowaychuk |
| ms | MIT | Copyright (c) 2020 Vercel, Inc. |
| semver | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| graceful-fs | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors |
| sax | Blue Oak Model License 1.0.0 | Isaac Z. Schlueter — licence text: <https://blueoakcouncil.org/license/1.0.0> |
| argparse | Python Software Foundation License 2.0 | A port of Python's argparse. Copyright (c) Python Software Foundation; the full licence ships as `node_modules/argparse/LICENSE` inside `app.asar` |

---

## The MIT License

Applies to every package above marked MIT.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## The ISC License

Applies to every package above marked ISC.

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without
> fee is hereby granted, provided that the above copyright notice and this permission notice appear
> in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
> THIS SOFTWARE.

---

## Electron and Chromium

The Electron runtime (MIT) and the Chromium engine inside it carry their own notices, which
electron-builder copies into the installed application rather than duplicating here:

- `LICENSE.electron.txt` — Electron, MIT, Copyright (c) Electron contributors / GitHub Inc.
- `LICENSES.chromium.html` — every third-party component inside Chromium.

Both are installed alongside the executable.

### A note on ffmpeg

Electron bundles FFmpeg with the H.264 and AAC decoders enabled. That raises a *patent* question
rather than a copyright one, and it is only relevant if the shell ever decodes video — which it does
not. Electron publishes an FFmpeg build with those codecs removed; swapping it in closes the
question. See `../LICENSING.md`.

---

## Not distributed

The Android SDK, the emulator, and the system images are **downloaded by the user's own machine**
under Google's licence and are not part of this package. The F-Droid catalogue is fetched from
f-droid.org at runtime. Apps installed through the Store carry their own licences, which the Store
shows on each app's page.
