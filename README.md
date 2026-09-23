<p align="center">
  <img src="./logo.webp" width="120" alt="SpotiDuck Logo" />
</p>

<h1 align="center">SpotiDuck Releases 🦆</h1>

<p align="center">
  <a href="https://github.com/23fpsz/SpotiDuck-Releases/releases/latest">
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
> The screenshots above show the **previous** injected UI. A new mobile shell
> (bottom tab bar, mini player, full-screen player, mobile library) is being
> built in `src/inject/` — see **[docs/UI-REWORK.md](./docs/UI-REWORK.md)** for
> the full list of interface bugs it fixes.

---

## 🧩 Mobile UI layer (development)

The interface that turns the desktop Spotify web player into the native mobile
layout lives in this repository and is built into a single injectable file:

```
src/inject/10-base.css      design tokens, viewport, web-player takeover
src/inject/20-shell.css     tab bar, mini player, full-screen player, queue sheet
src/inject/30-sheets.css    options & settings sheets, login page, offline banner
src/inject/spotiduck-ui.js  runtime (reads the player, drives playback, gestures)
dist/spotiduck-ui.js        ← built bundle, this is what the app injects
demo/                       mock Spotify web player + phone-frame preview
```

```bash
npm run build    # rebuild dist/spotiduck-ui.js
npm run smoke    # 30 behaviour tests against the built bundle
npm run demo     # http://localhost:5173 — preview in a phone frame
```

The preview ships a mock web player (same `data-testid`s as the real one) plus
scenario buttons: **transfer from another device**, **login page**, **offline**,
open the player / the settings, and an A/B switch that disables the whole layer.

Everything is scoped to `html.sd-mobile`, so the layer can be shipped, disabled
or A/B-compared (`demo/player.html?off=1`) without touching the app. Settings
live in `localStorage['sd.ui.settings']` and are also exposed at runtime:

```js
window.SpotiDuckUI.set("theme", "light");
window.SpotiDuckUI.openSettings();
window.SpotiDuckUI.back();   // call from onBackPressed, returns true if consumed
```

---

## 📥 Installation & Setup Guide

1. **Download the APK**: Download the latest `.apk` file from the [Releases](https://github.com/23fpsz/SpotiDuck-Releases/releases/latest) page.
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