# Legal posture (contributor notes)

This is the reasoning behind a few decisions in this repo, for whoever
touches the SDK download path, the wizard, or ad/monetization code next.
User-facing terms live in [`docs/EULA.md`](EULA.md) and
[`docs/PRIVACY.md`](PRIVACY.md); license text/attribution lives in
[`LICENSE`](../LICENSE) and [`docs/NOTICES.md`](NOTICES.md). This is not
legal advice — get real counsel before relying on it for a commercial
launch.

## Why the SDK is fetched, never bundled

The [Android SDK License Agreement](https://developer.android.com/studio/terms)
(§3.3 in the version current as of this writing) says:

> "you may not copy ..., modify, adapt, redistribute, decompile, reverse
> engineer, disassemble, or create derivative works of the SDK or any part
> of the SDK ... or distribute any software or device incorporating a part
> of the SDK."

That rules out shipping the emulator, platform-tools, or a system image
inside this project's installer. [`android/scripts/fetch_android.sh`](../android/scripts/fetch_android.sh)
downloads them straight from Google's own servers, on the end user's
machine, under the end user's own acceptance — never through this
project's infrastructure. [`desktop/electron-builder.yml`](../desktop/electron-builder.yml)'s
`extraResources` filter deliberately ships only `android/bin`, `lib`,
`scripts`, and `config` (the control-plane code), never `sdk/`, `avd/`,
`state/`, or `logs/`.

Google's license also requires informed acceptance, not just a mechanical
`yes |` pipe — hence the wizard's License step
([`desktop/public/wizard.html`](../desktop/public/wizard.html)) shows the
terms and a real checkbox before [`desktop/lib/setup.js`](../desktop/lib/setup.js)
will run the fetch step at all (see `acceptSdkLicense` /
`ANDROID_SDK_LICENSE_ACCEPTED`).

## Why there's no AdSense/Ad Manager inside the app

Google's ad placement policy is explicit:

> "Publishers are not permitted to distribute Google ads or AdSense for
> search boxes through software applications including, but not limited
> to toolbars, browser extensions, and desktop applications."

So standard AdSense/Ad Manager tags cannot run inside the Electron shell
at all, regardless of how they're embedded. This is the main reason
[`docs/MONETIZATION.md`](MONETIZATION.md) splits in-app monetization
(self-hosted creatives, affiliate/CPI offers, a paid tier) from the
**website**, where programmatic display ads are policy-compliant.

## The long-term fix: stop depending on Google's SDK entirely

Fetching-not-bundling is compliant, but it's still a dependency on Google
continuing to publish x86_64 system images and terms this project doesn't
control (see §14(D) of the same agreement: Google can stop providing the
SDK to a country or decide it's "no longer commercially viable" for them).
[`src/`](../src/) already contains the beginning of an independent path —
a minimal Type-2 VMM (`open-vmm`) that this could grow toward a
self-built AOSP or android-x86 guest image, at which point the Google SDK
license constraint (and the "never bundle" rule that follows from it)
stops applying, because there's no Google-licensed SDK in the loop at all.
That's a substantial undertaking (bootloader, kernel, HAL/goldfish
devices) and is tracked as a roadmap item, not a near-term change — see
[`docs/ROADMAP.md`](ROADMAP.md).

## Trademarks and naming

Apache-2.0 (§6) explicitly excludes trademark rights from the code grant.
Forks should rename and re-brand rather than reuse `open-emulator`'s name
or the mint leaf-device mark. "Android" is a trademark of Google LLC; this
project is unaffiliated with Google.
