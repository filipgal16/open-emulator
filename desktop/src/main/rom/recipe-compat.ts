import { deepFreeze, type RomRecipe } from './recipe';

/**
 * `openemu-compat`: the ROM for running what people actually install — ARM games — rather than
 * the licence-clean minimum.
 *
 * `openemu` is built from the AOSP image, which is x86-only: an app that ships only ARM libraries
 * (nearly every game) does not install on it. The only ARM translators that exist are Google's
 * and Intel's, and Google's is inside its **Google APIs** image. This recipe therefore starts
 * from that image instead and takes things away, which the builder can do, rather than grafting
 * the translator into the AOSP one, which it cannot: the translator is several hundred files and
 * the AOSP volumes have 88 MB and 174 inodes free.
 *
 * What that costs is written down in `design/openemu-rom.md` ("openemu-compat"): the result
 * contains Google Mobile Services and is derived from a Google binary, so it is built on the
 * user's machine from their own download and is never ours to redistribute.
 *
 * Three rules shape it.
 *
 * **Compatibility first.** Google's identity stays exactly as shipped (`identity: null`): Play
 * services decides from the build fingerprint whether the device may sign in, and a game's
 * "Sign in with Google" goes through it. Anything an app can reach by API — Play services, the
 * services framework, WebView, Chrome (custom tabs are how most games show a login page), the
 * keyboard, text-to-speech, the licence checker, the document and photo pickers — stays, however
 * large.
 *
 * **Every core visible.** The translator tells ARM apps the device has one CPU; see
 * `arm-cpuinfo.ts`. Both of its cpuinfo files are rewritten to list the guest's cores.
 *
 * **Lightweight where it is free.** What goes is what a person would open by hand on a phone and
 * never on an emulator, plus the Google services that run in the background for a phone's sake:
 * the Google app (Assistant, hotword, the launcher's feed), Digital Wellbeing, Android System
 * Intelligence and its Private Compute companion, the dialer and SMS app, Android Auto and
 * supervision stubs, and the restore-from-backup flow of a setup wizard this image never shows.
 * Removing an app's directory does not remove a provider other apps query: every `*Provider`
 * stays, as on `openemu`.
 */

const VERSION = 1;

const under = (dir: string, names: string[]): string[] => names.map((name) => `${dir}/${name}`);

/**
 * Apps this recipe must never remove, and why. A test holds `debloat` to it, as `KEPT` does for
 * `openemu`.
 */
export const COMPAT_KEPT: Readonly<Record<string, string>> = {
  PrebuiltGmsCore: 'Google Play services: sign-in, push, ads, Play Games — what most games call first',
  GoogleServicesFramework: 'Play services cannot register the device or hold an account without it',
  ConfigUpdater: 'delivers the server-side configuration Play services runs on',
  GoogleOneTimeInitializer: 'sets the Google defaults on first boot; Play services expects them',
  PartnerSetupPrebuilt: 'the client id Google apps identify the device by',
  GoogleSdkSetup: "the emulator image's stand-in for the setup wizard; without it the device never finishes provisioning",
  WebViewGoogle: 'the WebView provider: in-game browsers, login pages, ads',
  'WebViewGoogle-Stub': "the provider's compressed stub, which the framework resolves first",
  TrichromeLibrary: 'the shared library WebView and Chrome are both built on',
  'TrichromeLibrary-Stub': 'its stub, as above',
  Chrome: 'custom tabs: how a game opens "Sign in with …" and its terms pages',
  'Chrome-Stub': 'its stub, as above',
  LatinIMEGooglePrebuilt: 'the only keyboard on the image',
  GoogleTTS: 'the only text-to-speech engine; costs nothing while unused',
  LicenseChecker: 'the Play licensing service paid apps bind to',
  ModuleMetadataGoogle: 'names the mainline modules; the module updater reads it at boot',
  NexusLauncherRelease: 'the home screen',
  SettingsGoogle: 'the Settings app, which apps and system dialogs deep-link into',
  SystemUIGoogle: 'the status bar, navigation and every system dialog',
  SettingsIntelligenceGooglePrebuilt: 'search inside Settings; Settings binds it',
  DocumentsUIGoogle: 'the file picker behind ACTION_OPEN_DOCUMENT',
  GooglePackageInstaller: 'the install and permission dialogs',
  NetworkStackGoogle: 'DHCP and connectivity checks; without it there is no network',
  CaptivePortalLoginGoogle: 'opened by the network stack when a sign-in page is detected',
  Camera2: 'ACTION_IMAGE_CAPTURE needs a handler',
  ContactsProvider: 'removing the Contacts app does not remove its provider, which telephony and other apps use',
  CalendarProvider: 'removing the Calendar app does not remove its provider, which other apps use',
  TelephonyProvider: "telephony's own data; the framework starts it regardless of the apps removed",
  BlockedNumberProvider: 'Telecom checks incoming calls against it',
  SettingsProvider: 'Settings.System/Secure/Global live in it; without it nothing boots',
  DownloadProvider: 'DownloadManager is a framework API any app may call — games fetch their data with it',
  MediaProviderLegacy: 'migrates media data for the MediaProvider module',
  ExternalStorageProvider: 'serves /sdcard to the file picker',
  TeleService: 'com.android.phone; the framework starts it regardless of the apps removed',
  Telecom: 'call routing in the framework; runs whether or not a dialer is installed',
  NfcNci: 'kept until a boot shows whether this image declares android.hardware.nfc; openemu removed it only after checking',
  SecureElement: 'paired with NFC; same reason',
};

export const OPENEMU_COMPAT_RECIPE: RomRecipe = deepFreeze({
  id: 'openemu-compat',
  version: VERSION,
  displayName: 'open-emulator Android (Google APIs)',
  baseTag: 'google_apis',
  apiLevel: 34,
  identity: null,
  // Android 14 keeps system_ext's and product's under /etc (checked on a boot of this image);
  // API 30 had them at the volume root.
  buildPropPath: {
    system: '/system/build.prop',
    system_ext: '/etc/build.prop',
    product: '/etc/build.prop',
    vendor: '/build.prop',
  },
  debloat: {
    system: [
      // The same user-facing extras `openemu` removes, under the names this image gives them:
      // screensavers, the easter egg, Bluetooth MIDI, partner bookmarks, the SIM toolkit screens,
      // print recommendations and the tracing tool. None is needed to boot.
      ...under('/system/app', [
        'BasicDreams',
        'BluetoothMidiService',
        'EasterEgg',
        'GooglePrintRecommendationService',
        'PartnerBookmarksProvider',
        'SimAppDialog',
        'Stk',
        'Traceur',
      ]),
      // The default print plugin (the spooler stays), the call-log backup agent (no dialer left to
      // log calls), legacy cell broadcast, the GSI installer, the audio effects panel, the
      // opportunistic network service, live wallpapers and the NFC tag viewer.
      ...under('/system/priv-app', [
        'BuiltInPrintService',
        'CallLogBackup',
        'CellBroadcastLegacyApp',
        'DynamicSystemInstallationService',
        'LiveWallpapersPicker',
        'MusicFX',
        'ONS',
        'TagGoogle',
      ]),
    ],
    system_ext: [
      // The emergency information screen, the accessibility shortcut menu, the "send feedback to
      // Google" reporter and the lock-screen wallet tile: phone features, none bound at boot.
      ...under('/priv-app', ['AccessibilityMenu', 'EmergencyInfo', 'GoogleFeedback', 'QuickAccessWallet']),
    ],
    product: [
      // Google's bundled user apps. Nothing binds them by package: calendar and contact data live
      // in the providers (which stay), a photo is picked through the system picker, and a link
      // opens in Chrome.
      ...under('/app', [
        'CalendarGooglePrebuilt',
        'Drive',
        'GoogleContacts',
        'Maps',
        'MarkupGoogle',
        'NexusWallpapersStubPrebuilt2018',
        'Photos',
        'PixelThemesStub',
        'PrebuiltDeskClockGoogle',
        'PrebuiltGmail',
        'YouTube',
        'YouTubeMusicPrebuilt',
        'talkback',
      ]),
      // The Google app (Assistant, hotword, the launcher feed — the heaviest background process on
      // the stock image), Digital Wellbeing, Android System Intelligence and the Private Compute
      // services it talks through, the dialer and the SMS app (no telephony UI on an emulator, as
      // on `openemu`), the Android Auto and supervision stubs, and restore-from-backup, which only
      // the setup wizard this image never shows can start.
      ...under('/priv-app', [
        'AndroidAutoStubPrebuilt',
        'DeviceIntelligenceNetworkPrebuilt',
        'DevicePersonalizationPrebuiltPixel2021',
        'GoogleDialer',
        'GoogleRestorePrebuilt',
        'KidsSupervisionStub',
        'PrebuiltBugle',
        'Velvet',
        'WellbeingPrebuilt',
      ]),
    ],
    // Nothing: vendor holds the goldfish HALs.
    vendor: [],
  },
  systemProps: {
    'ro.openemu.rom': '1',
    'ro.openemu.rom.version': String(VERSION),
    'ro.openemu.rom.recipe': 'openemu-compat',
    // The one line of identity that is ours: the build number Settings → About shows. It is
    // display text; nothing derives a fingerprint from it.
    'ro.build.display.id': `open-emulator Android 14 (openemu-compat ${VERSION})`,
  },
  edits: [
    { volume: 'system', path: '/system/etc/cpuinfo.arm64.txt', transform: 'arm-cpuinfo' },
    { volume: 'system', path: '/system/etc/cpuinfo.arm.txt', transform: 'arm-cpuinfo' },
  ],
  files: [],
});
