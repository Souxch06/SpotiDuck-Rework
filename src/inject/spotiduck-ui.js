/* ==========================================================================
   SpotiDuck — Mobile UI runtime
   --------------------------------------------------------------------------
   Turns the desktop Spotify web player into the native mobile app shell:

     · bottom tab bar (Accueil · Recherche · Bibliothèque)
     · mini player (cover, title, artist, like, play/pause, next, progress)
     · full-screen player sheet (swipe down to close, drag the seek bar)
     · library page + queue bottom sheet + back button on sub-pages

   Design rules this file follows (and the old injected script did not):
     1. NOTHING is written into Spotify's React tree. Everything lives in one
        `.sd-layer` we own, so re-renders can never delete our UI.
     2. Event driven: a MutationObserver + one rAF ticker replace the four
        `setInterval(…, 2000|5000)` loops that made the old bar laggy and
        drained the battery.
     3. No global variables: a single namespaced handle `window.SpotiDuckUI`.
     4. Every Spotify selector is a *candidate list* with a fallback, so a web
        player redesign degrades gracefully instead of killing the UI.
     5. Optional `AndBridge` (the Android JavascriptInterface): every call is
        feature-detected, so the exact same bundle runs in a plain browser.

   NOTE for the app side: the wrapper fakes `window.innerWidth/Height`
   (1920×1080) so that Spotify serves the desktop layout. Layout code here
   therefore NEVER reads `window.innerWidth` — it uses
   `document.documentElement.clientWidth/Height`, which is the real device
   viewport. (The old script mixed the two, which is why some measurements
   were off on tablets.)
   ========================================================================== */
(function () {

  "use strict";
  /**
   * La page de connexion e-mail + mot de passe.
   *
   * Mesuré en CI : `accounts.spotify.com/fr/login` ne demande que l'e-mail,
   * `?allow_password=1` affiche les deux champs, et « /login » sur le lecteur
   * (l'adresse utilisée jusqu'ici) **répond 404** — le bouton « connexion
   * classique » menait donc à une page d'erreur.
   */
  var CLASSIC_LOGIN = "https://accounts.spotify.com/fr/login?allow_password=1";

  if (window.SpotiDuckUI && window.SpotiDuckUI.version) return; // idempotent

  /* La version de la **coque**, estampillée par le bundler (`tools/build.mjs`
     pose `window.__SD_VERSION__` avec la version de `package.json`).
     Elle était écrite à la main (« 2.9.0 ») et n'a plus jamais bougé : le
     diagnostic d'un téléphone en 2.11 annonçait donc « SpotiDuck 2.9.0 », ce
     qui rendait toute remontée de bug inexploitable. `dev` n'apparaît que si
     le fichier est chargé hors build (banc, mise au point). */
  var VERSION = (window.__SD_VERSION__ || "dev");
  var STYLE_ID = "spotiduck-ui-style";
  var BODY_CLASS = "sd-mobile";

  /* @@MODULES@@ */

})();
