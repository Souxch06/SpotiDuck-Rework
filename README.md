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
> The screenshots above show the **previous** injected UI. The new mobile shell
> (bottom tab bar, mini player, full-screen player, mobile library) is being
> built in `src/inject/` — see **[docs/UI-REWORK.md](./docs/UI-REWORK.md)** for
> the full list of interface bugs it fixes.

---

## 🧩 The interface (v2.5): Spotify's, or ours

SpotiDuck ships **two interfaces**, switchable at runtime:

| | **Native** (default) | **SpotiDuck** (injected layer) |
| --- | --- | --- |
| What you see | **Spotify's own mobile page** — the app sends Chrome-Android's user-agent, so Spotify serves its real mobile interface (bottom bar, compact lists, full-screen player). Nothing is redrawn, only the "open in the app" banners are hidden. | Our own shell on top of the desktop web player: bottom tab bar, mini player, queue sheet, settings, offline banner, interface-size setting. |
| Switch to it | default | **long-press anywhere for 3 s** → *Interface SpotiDuck*, or *Settings → Interface* |
| Notification | drives Spotify's real buttons (play/pause, next, previous, like, seek) and mirrors title/artist/cover | drives the layer's playback API |

The choice is stored in `SharedPreferences` and survives restarts.

## 🧩 The injected layer (development)

The layer above (mode *SpotiDuck*) that turns the desktop Spotify web player into
the native mobile layout lives in this repository and is built into a single
injectable file:

```
src/inject/10-base.css      design tokens, viewport, web-player takeover
src/inject/20-shell.css     tab bar, mini player, full-screen player, queue sheet
src/inject/30-sheets.css    options & settings sheets, login page, offline banner
src/inject/40-audit.css     interface hardening (touch targets, overflow, modals…)
src/inject/50-android.css   Android/Material 3 pass (Roboto, 48 dp, shapes, motion)
src/inject/spotiduck-ui.js  runtime (reads the player, drives playback, gestures)
dist/spotiduck-ui.js        ← built bundle, this is what the app injects in this mode
demo/                       mock Spotify web player + phone-frame preview
android/                    the APK: WebView wrapper around the built layer
android/app/src/main/assets/native-mode.js
                            ← the native mode: hides the browser banners and wires
                              the Android notification to Spotify's real controls
```

```bash
npm run build          # rebuild dist/spotiduck-ui.js
npm run smoke          # 47 behaviour tests (bundle + native mode)
npm run demo           # http://localhost:5173 — preview in a phone frame
npm run android        # build + copy the bundle into android/app/src/main/assets
```

The preview ships a mock web player (same `data-testid`s as the real one) plus
scenario buttons: **transfer from another device**, **logged out (welcome
screen)**, **login page**, **offline**, open the player / the settings, and an
A/B switch that disables the whole layer.

The layer is styled for Android rather than for the desktop web: Roboto,
48 dp touch targets, 16 dp gutters, Material 3 shapes and surfaces, Material
motion curves, and an edge-to-edge layout driven by the real window insets
(the app forwards them to `--sd-safe-*-override`).

The web player itself is reflowed to the **mobile app metrics** (2 cards per
row at ~160 dp, 56 dp rows, 20 px section titles, 200 dp hero art, 16 dp page
gutters) — otherwise it keeps its desktop dimensions squeezed into a phone.

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
    spotiduck-ui.js        ← copy of dist/spotiduck-ui.js (npm run sync:android)
    native-mode.js         ← the native mode (script injected when ui_mode=native)
    adblock_hosts.txt      ← copy of the repository list
```

`MainActivity` picks the user-agent and the script from the stored mode
(`native` by default · `inject`): Chrome-Android + `native-mode.js`, or desktop +
the injected bundle. `Bridge` exposes `uiMode()`, `setUiMode(mode)` and
`showUiChooser()`; the runtime calls the latter when it receives a long press.

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

**Signing.** Android only installs an update over an existing app when both
builds carry the same signature, so:

* **default** — the workflow derives a fixed key from a public seed
  (`android/tools/derive-key.py`), so every release is signed identically and
  updates install straight over the previous version;
* **your own key** — generate one with `android/tools/make-keystore.py`, store
  it as the repository secrets `SD_KEYSTORE_BASE64`, `SD_KEYSTORE_PASSWORD`,
  `SD_KEY_ALIAS`, `SD_KEY_PASSWORD`, and the workflow uses it instead.

Switching keys later means users must uninstall once, so choose before the
first public APK. (Regardless of the key, the official SpotiDuck build is not
signed by the original Spotifuck key: uninstall the old app before installing.)

---

## 📥 Installation & Setup Guide

1. **Download the APK**: Download the latest `.apk` file from the [Releases](https://github.com/Souxch06/SpotiDuck-Rework/releases/latest) page — it is built and signed by [GitHub Actions](./.github/workflows/android.yml), never by hand.
2. **Enable Unknown Sources**: If prompted by Android, allow installation from unknown sources (*Settings > Apps > Special app access > Install unknown apps*).
3. **Install & Open**: Open the downloaded `.apk` file and tap **Install**.
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