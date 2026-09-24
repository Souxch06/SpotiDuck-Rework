<p align="center">
  <img src="./logo.webp" width="120" alt="SpotiDuck Logo" />
</p>

<h1 align="center">SpotiDuck Releases 🦆</h1>

<p align="center">
  <a href="https://github.com/Souxch06/SpotiDuck-Rework/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest_APK-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Download Latest APK" height="40" />
  </a>
</p>

<p align="center">
  <a href="https://discord.gg/NNXDGZEDFs">
    <img src="https://img.shields.io/badge/Join-Discord_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord Community" height="40" />
  </a>
</p>

<p align="center">
  <a href="https://23fpsz.github.io/SpotiDuck-Releases/">
    <img src="https://img.shields.io/endpoint?url=https://23fpsz.github.io/SpotiDuck-Releases/status.json&style=for-the-badge&cacheSeconds=60" alt="Spotify Status" height="40" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Android-3DDC84?logo=android&logoColor=white&style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Kotlin-1.9+-7F52FF?logo=kotlin&logoColor=white&style=flat-square" alt="Kotlin" />
  <img src="https://img.shields.io/badge/License-GNU_GPLv3-blue?style=flat-square" alt="License" />
</p>

> [!WARNING]
> **Official Source Only:** SpotiDuck is **only** published and distributed on this official GitHub repository. Do not download or trust builds of this application from any other websites, app stores, or third-party channels, as they are unverified and may contain malicious modifications.

Welcome to the download and releases page for **SpotiDuck**—a high-performance, web-wrapped Spotify client for Android featuring built-in ad-blocking, media controls, and widgets.

By wrapping the Spotify Web Player in a highly optimized Android WebView, SpotiDuck combines the full feature set of Spotify's web browser experience with native Android integrations—such as background service control, built-in ad-blocking, lock screen media sessions, widgets, and Android Auto.

> [!NOTE]
> **Credits:** SpotiDuck is built upon and inspired by **Spotifuck**, the original unofficial Android Spotify web wrapper developed by **deviato**. We would like to express our gratitude to the original creator for laying the groundwork for this project.

---

## 📸 App Interface Showcase

<p align="center">
  <img src="./screenshots/home_screen.jpg" width="31%" alt="Home Screen" />
  <img src="./screenshots/library_menu.png" width="31%" alt="Library Menu" />
  <img src="./screenshots/fullscreen_player.png" width="31%" alt="Full Screen Player" />
</p>

<p align="center">
  <img src="./screenshots/lockscreen_player.jpg" width="47%" alt="Lock Screen Player" />
  <img src="./screenshots/widget.png" width="47%" alt="Widget Support" />
</p>

<p align="center">
  <img src="./screenshots/landscape_mode.png" width="60%" alt="Landscape Mode" />
</p>

> [!NOTE]
> Those screenshots are the interface shipped **by default**: the project's
> original display, restored as-is in `src/original/`. The tweaked shell that
> was being written in `src/inject/` is still there, as a secondary interface —
> see **[docs/UI-REWORK.md](./docs/UI-REWORK.md)**.

---

## 🧩 The interface: the project's original one, restored as-is

The app ships the interface it started with, **unedited**: the original injected
script (navigation at the top — home · library · search · logo · notifications ·
friends · profile — compact home rows, library opening full screen, and a
complete player at the bottom with a red gradient), taken from the decompiled
`Spotifuck` source and rebuilt in `src/original/`. Nothing was written by hand;
see **[src/original/README.md](./src/original/README.md)** for the exact
provenance and the fingerprints that guard it.

Three interfaces, switchable at runtime (**long-press anywhere** → the chooser,
or *Settings → Interface* in our own shell):

| | **Original** (default) | **Our shell** | **“Native”** (beta) |
| --- | --- | --- | --- |
| What you see | The project's original display: the **desktop** web player arranged by the original stylesheet | Our own mobile shell on the same desktop player: bottom/top navigation, sheets, settings, density setting | The **mobile web page** Spotify serves when the app pretends to be Chrome on Android |
| Sign-in | e-mail/password works (desktop player) | e-mail/password works | social buttons only (WebViews often reject them) |
| Notification | the original script reports the track to Android; the shim relays play/pause/next/previous/like/seek | the layer's playback API | clicks Spotify's real buttons and mirrors title/artist/cover |

Either way the nuisance windows are removed: cookie/consent banners, “open in
the app” prompts, promo banners, tooltips, browser long-press menus and
scrollbars. The choice is stored in `SharedPreferences` and survives restarts.

## 🧩 The injected layer (development)

The layer above (mode *SpotiDuck*) that turns the desktop Spotify web player into
the native mobile layout lives in this repository and is built into a single
injectable file:

```
src/original/spotiduck-original.js
                            the default interface: the original injected script,
                            its stylesheet and a labelled shim — see the README
                            in that folder
src/inject/10-base.css      design tokens, viewport, web-player takeover
src/inject/20-shell.css     tab bar, mini player, full-screen player, queue sheet
src/inject/30-sheets.css    options & settings sheets, login page, offline banner
src/inject/40-audit.css     interface hardening (touch targets, overflow, modals…)
src/inject/50-android.css   Android/Material 3 pass (Roboto, 48 dp, shapes, motion)
src/inject/70-original.css the shell's own layout: top navigation bar, full mini
                            player (shuffle/prev/play/next/repeat + progress),
                            2-column home shortcuts
src/inject/spotiduck-ui.js  runtime (reads the player, drives playback, gestures)
dist/spotiduck-ui.js        ← built bundle of our shell (mode “inject”)
dist/spotiduck-original.js  ← built bundle of the original interface (default)
demo/                       mock Spotify web player + phone-frame preview
android/                    the APK: WebView wrapper around the built layer
android/app/src/main/assets/native-mode.js
                            ← the native mode: hides the browser banners and wires
                              the Android notification to Spotify's real controls
```

```bash
npm run build          # rebuild both dist/ bundles (original + our shell)
npm run build:original # the original interface only, with its fingerprints checked
npm run smoke          # 67 behaviour tests (bundle + original + native mode)
npm run demo           # http://localhost:5173 — preview in a phone frame
npm run android        # build + copy the bundle into android/app/src/main/assets
```

The preview ships a mock web player (same `data-testid`s as the real one) plus
scenario buttons: **transfer from another device**, **logged out (welcome
screen)**, **login page**, **offline**, open the player / the settings, and an
A/B switch that disables the whole layer.

**Viewport.** A WebView without a `<meta name="viewport">` lays the page out on
**980 px** — every `vw` unit, `clamp()` and media query then targets a screen two
to three times wider than the phone. Our shell is written in dp, so it pins the
meta to `width=device-width` before applying its styles (`MainActivity` does the
same as early as the page starts loading); the **original** interface does the
opposite — it keeps the original app's WebView settings (`useWideViewPort`,
`loadWithOverviewMode`, `setInitialScale(100)`, zoom allowed) and lets Spotify's
page decide its own layout. The **Affichage** line in the settings
says so out loud (`⚠ mise en page 980px pour un écran de 393px`) when the two
disagree — tap it to copy.

The layer is styled for Android rather than for the desktop web: Roboto,
48 dp touch targets, 16 dp gutters, Material 3 shapes and surfaces, Material
motion curves, and an edge-to-edge layout driven by the real window insets
(the app forwards them to `--sd-safe-*-override`).

The web player itself is reflowed to the **mobile app layout**: each home
section is a **row that scrolls horizontally** (tiles ~148 dp, a bit more than
two visible) instead of a vertical grid, list rows are 56 dp (64 dp in the
library) with 40/48 dp covers, section titles 20 px, hero art 200 dp, page
gutters 16 dp — otherwise it keeps its desktop dimensions squeezed into a phone.
The desktop column header of tracklists is removed, the way the app has none.

Renderers differ from one Android device to the next, so the size of the whole
interface is a setting: **Paramètres → Taille de l'interface** (Compacte 80 %,
Normale 100 %, Grande 112 %), and the same sheet shows a live **Affichage**
diagnostic line (`360×640 · 2.75× · 100 %`).

Everything is scoped to `html.sd-mobile`, so the layer can be shipped, disabled
or A/B-compared (`demo/player.html?off=1`) without touching the app. Settings
live in `localStorage['sd.ui.settings']` and are also exposed at runtime:

```js
window.SpotiDuckUI.set("theme", "light");
window.SpotiDuckUI.openSettings();
window.SpotiDuckUI.back();   // call from onBackPressed, returns true if consumed
```

---

## 🤖 The Android app (APK)

`android/` contains the wrapper that ships this interface: a single
`MainActivity` with a WebView, a foreground playback service, the `AndBridge`
object the layer talks to, ad-host blocking and the hardware back button.

```
android/app/src/main/java/com/spotiduck/app/
    MainActivity.kt        WebView, desktop UA, injection, insets, back button
    Bridge.kt              AndBridge (media status, wake/sleep locks, messages)
    PlaybackService.kt     media notification + lock screen / headset controls
    AdBlocker.kt           host-list blocking (assets/adblock_hosts.txt)
android/app/src/main/assets/
    spotiduck-original.js  ← copy of dist/spotiduck-original.js (the default UI)
    spotiduck-ui.js        ← copy of dist/spotiduck-ui.js (npm run sync:android)
    native-mode.js         ← the native mode (script injected when ui_mode=native)
    adblock_hosts.txt      ← copy of the repository list
```

`MainActivity` picks the user-agent, the layout settings and the script from the
stored mode:

| Mode | User agent | Layout | Script |
| --- | --- | --- | --- |
| `original` (default) | desktop Chrome | the original app's settings, no viewport meta forced | `spotiduck-original.js` |
| `inject` | desktop Chrome | meta pinned to `width=device-width` | `spotiduck-ui.js` |
| `native` (beta) | Chrome Android | meta pinned by the script | `native-mode.js` |

`Bridge` exposes `uiMode()`, `setUiMode(mode)` and `showUiChooser()`; the runtime
calls the latter when it receives a long press, and `MainActivity` does the same
on a long press in the original mode (which has no settings screen of its own).

### Installing: the Play Protect screen

Google Play Protect scans every APK installed from outside the Play Store. It is
a Google service on the phone, not something an app can switch off for itself —
but the two things it complains about, and the fixes, are worth knowing:

| What you see | Why | What to do |
| --- | --- | --- |
| “Play Protect n'a pas pu vérifier cette appli” / *unknown developer* | SpotiDuck is not published on the Play Store and is signed with its own key | tap **Installer quand même** (or ⋮ → *Plus de détails*), or turn the scan off (below) |
| “Application non sécurisée bloquée” — the install button is the only option | the on-device classifier has a negative verdict for this APK | turn the scan off (below); *Installer quand même* is not offered on this screen |

**Turn the scan off for good** (2 taps from inside the app):

1. **Long-press the page → Play Protect** — the app opens the setting for you
   (in our own shell: *Settings → À propos → Vérification Play Protect*).
2. In the Play Store screen that opens: **⚙️ → uncheck “Analyser les applis avec
   Play Protect”**.

Manually, that screen is *Play Store → profile icon → Play Protect → ⚙️ →
“Analyser les applis avec Play Protect”*. You can re-enable it afterwards; the
app you already installed keeps working.

Two more ways around it, for reference: `adb install -r SpotiDuck-….apk`
(no installer UI, so no prompt), or installing the APK from a device where the
scan is off. Publishing on the Play Store, or [appealing to Play
Protect](https://support.google.com/googleplay/android-developer/contact/protectappeals),
are the only ways to get a *trusted* verdict — neither is possible for a Spotify
wrapper.

Nothing in the APK can suppress that screen: `REQUEST_INSTALL_PACKAGES` or a
bundled installer would only make Play Protect more suspicious, not less.

**Build it**

```bash
cd android
gradle assembleRelease        # needs a JDK 17 and the Android SDK
# → android/app/build/outputs/apk/release/app-release.apk
```

The APK is also built by CI: pushing a tag (or publishing a release) runs
[`.github/workflows/android.yml`](./.github/workflows/android.yml), which
assembles the release build and attaches it to the matching GitHub release —
that is where the downloadable `.apk` comes from.

**Package name.** `com.spotiduck.rework` — deliberately *not*
`com.spotiduck.app`: if another SpotiDuck (a different distributor, a different
signing key) is already installed under that name, Android refuses the install
with *“package conflicts with an existing package”*. A distinct id means the
APK always installs, and the app can live next to the old one until you delete
it.

**Signing.** Android installs an update over an existing app only when the two
builds carry the **same signer certificate** — not merely the same key. So:

* **default** — the CI uses the project's public key: its certificate lives in
  [`android/keystore/spotiduck.crt`](./android/keystore/README.md) with a fixed
  serial number and fixed validity dates. Both files are public on purpose (the
  key material is already in this repository), and being *frozen* is what makes
  updates install over the previous release. Re-generating a certificate per
  build — what the CI used to do — changes the signature and triggers the
  “conflicts with an existing package” error;
* **your own key** — generate one with `android/tools/make-keystore.py`, store
  it as the repository secrets `SD_KEYSTORE_BASE64`, `SD_KEYSTORE_PASSWORD`,
  `SD_KEY_ALIAS`, `SD_KEY_PASSWORD`, and the workflow uses it instead.

Changing the certificate later means users must uninstall once, so pick one
before the first public APK.

---

## 📥 Installation & Setup Guide

1. **Download the APK**: Download the latest `.apk` file from the [Releases](https://github.com/Souxch06/SpotiDuck-Rework/releases/latest) page — it is built and signed by [GitHub Actions](./.github/workflows/android.yml), never by hand.
2. **Enable Unknown Sources**: If prompted by Android, allow installation from unknown sources (*Settings > Apps > Special app access > Install unknown apps*).
3. **Install & Open**: Open the downloaded `.apk` file and tap **Install**. SpotiDuck installs as its own app (`com.spotiduck.rework`), so an older SpotiDuck copy that refuses to update can simply be deleted afterwards.
4. **Background Playback Optimization**: To prevent Android's power manager from killing the audio service in the background:
   - Navigate to **Settings > Apps > SpotiDuck > Battery / App battery usage**.
   - Select **Unrestricted** (or disable battery optimization).

---

## ⚠️ Compatibility & Playback Warnings

The application might not function correctly under the following conditions:

1. **Account Limitations**: Free accounts may experience playback loading errors on mobile WebViews. While SpotiDuck includes settings to handle platform compatibility, server-side changes to player browser policies may affect playback stability.
2. **Third-Party Logins**: Google or Facebook sign-ins may occasionally block authentications inside embedded browsers. Adjusting the compatibility configuration or user-agent scaling in settings may resolve these sign-in hurdles.
3. **DRM & Media Pipelines**: Secure media playback requires device-level DRM support. Custom ROMs or devices lacking proper security certifications may fail to start media streams.
4. **Aggressive Filters**: Loading custom or overly restrictive filter blocklists in settings can block essential server endpoints, preventing tracks from playing.
5. **System WebView Version**: For proper compatibility with preloading and layout adjustments, keep your device's System WebView updated to the latest version via the Google Play Store.

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>Why does playback pause when locking my phone or switching apps?</b></summary>

Android battery optimization often aggressively terminates background WebViews. Ensure battery usage is set to **Unrestricted** under *Settings > Apps > SpotiDuck > Battery*.
</details>

<details>
<summary><b>How do I fix Google or third-party login errors?</b></summary>

Google prevents sign-ins inside certain custom WebViews. If you encounter a "disallowed_useragent" error, log in using your Spotify email and password directly, or set your password in Spotify account management.
</details>

<details>
<summary><b>The app shows a blank screen or won't load music.</b></summary>

Update **Android System WebView** to the latest release via Google Play Store and restart the application.
</details>