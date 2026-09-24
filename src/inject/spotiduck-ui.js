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

  if (window.SpotiDuckUI && window.SpotiDuckUI.version) return; // idempotent

  var VERSION = "2.7.9";
  var STYLE_ID = "spotiduck-ui-style";
  var BODY_CLASS = "sd-mobile";

  /* ------------------------------------------------------------------ *
   * 0. Tiny helpers
   * ------------------------------------------------------------------ */
  function $(sel, root) {
    return (root || document).querySelector(sel) || null;
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  /** First element matching any selector of the list (ordered by priority). */
  function pick(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = $(selectors[i]);
      if (el) return el;
    }
    return null;
  }
  function viewW() {
    return document.documentElement.clientWidth || 360;
  }
  function viewH() {
    return document.documentElement.clientHeight || 640;
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function buzz(ms) {
    try {
      if (Settings.haptics && navigator.vibrate) navigator.vibrate(ms || 8);
    } catch (e) {
      /* not supported — ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 1. Settings (persisted in the WebView, restored on next launch)
   * ------------------------------------------------------------------ */
  var Settings = {
    /* Appearance */
    theme: "auto", // auto | dark | light
    accentFromArt: true, // colour the player with the cover art
    reduceMotion: false, // kill our animations (battery / low-end devices)
    /* Playback */
    takeControl: true, // click Spotify's "Écouter sur cet appareil" prompt
    resume: false, // resume playback when something else pauses it
    /* Interface */
    /* Barre d'onglets en BAS : désactivée par défaut depuis la v2.6.4 — la
       navigation est celle de l'application d'origine, en HAUT (`.sd-nav`).
       Le réglage reste disponible pour ceux qui préfèrent les onglets. */
    tabbar: false,
    haptics: true,
    /* Densité d'affichage : le seul réglage qui change la taille de TOUTE
       l'interface (voir `applyDensity`) — compact | normal | large. */
    density: "normal",
    labels: {
      app: "SpotiDuck",
      home: "Accueil",
      search: "Rechercher",
      library: "Bibliothèque",
      back: "Retour",
      queue: "File d'attente",
      devices: "Appareils",
      share: "Partager",
      lyrics: "Paroles",
      like: "Ajouter aux Titres likés",
      unlike: "Retirer des Titres likés",
      play: "Lecture",
      pause: "Pause",
      next: "Suivant",
      prev: "Précédent",
      notifications: "Notifications",
      friends: "Activité des amis",
      profile: "Profil",
      notAvailable: "Indisponible ici — Spotify ne propose pas cet écran sur cette page",
      progress: "Position de lecture",
      shuffle: "Lecture aléatoire",
      repeat: "Répéter",
      nowPlaying: "Lecture en cours",
      noTrack: "Aucun titre en lecture",
      volume: "Volume",
      close: "Fermer",
      queueEmpty: "La file d'attente est vide",
      /* sheets */
      options: "Options",
      settings: "Paramètres",
      groupLook: "Apparence",
      groupPlay: "Lecture",
      groupUi: "Interface",
      groupAbout: "À propos",
      groupUiNative: "Interface",
      nativeUi: "Utiliser l'interface Spotify",
      nativeUiHint: "Ouvre le choix : interface Spotify native ou couche SpotiDuck",
      playProtect: "Vérification Play Protect",
      playProtectHint: "Ouvre le réglage qui bloque les installations d'applications venues d'ailleurs : dans le Play Store, décoche « Analyser les applis avec Play Protect ».",
      playProtectManual: "Play Store → Play Protect → ⚙️ → décocher « Analyser les applis »",
      display: "Affichage",
      displayHint: "Appuie pour copier les infos d'affichage",
      theme: "Thème",
      themeAuto: "Auto",
      themeDark: "Sombre",
      themeLight: "Clair",
      accent: "Couleur de la pochette",
      reduceMotion: "Réduire les animations",
      takeControl: "Prendre la main sur la lecture",
      resume: "Relancer la lecture automatiquement",
      showTabbar: "Barre de navigation",
      haptics: "Retour haptique",
      viewArtist: "Voir l'artiste",
      viewAlbum: "Voir l'album",
      reload: "Recharger le lecteur",
      reset: "Réinitialiser les réglages",
      version: "Version de l'interface",
      takeover: "Lecture transférée sur cet appareil",
      unlock: "Déblocage du lecteur…",
      reloadPlayer: "Session expirée — rechargement du lecteur…",
      resetDone: "Réglages réinitialisés",
      copied: "Lien copié",
      classicLogin: "Se connecter avec e-mail et mot de passe",
      offline: "Hors connexion — lecture indisponible",
      /* écran d'accueil (session déconnectée) */
      density: "Taille de l'interface",
      densityCompact: "Compacte",
      densityNormal: "Normale",
      densityLarge: "Grande",
      welcomeTitle: "SpotiDuck",
      welcomeText: "Connecte-toi à ton compte Spotify pour retrouver ta musique.",
      welcomeCta: "Se connecter",
      welcomeNote: "Connexion par e-mail et mot de passe disponible",
      /* haptic patterns, in milliseconds */
      buzzTap: 8,
      buzzAction: 10,
    },
  };

  function loadSettings() {
    try {
      var raw = localStorage.getItem("sd.ui.settings");
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === "object") {
        if (o.theme) Settings.theme = o.theme;
        if (o.density) Settings.density = o.density;
        ["haptics", "accentFromArt", "tabbar", "takeControl", "resume", "reduceMotion"].forEach(function (k) {
          if (typeof o[k] === "boolean") Settings[k] = o[k];
        });
      }
    } catch (e) {
      /* private mode / quota — defaults are fine */
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(
        "sd.ui.settings",
        JSON.stringify({
          theme: Settings.theme,
          haptics: Settings.haptics,
          accentFromArt: Settings.accentFromArt,
          tabbar: Settings.tabbar,
          takeControl: Settings.takeControl,
          resume: Settings.resume,
          reduceMotion: Settings.reduceMotion,
          density: Settings.density,
        })
      );
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. Spotify adapter — the only place that touches the web player's DOM
   * ------------------------------------------------------------------ */
  var SEL = {
    mainView: ["#main-view", "main", ".main-view-container__scroll-node"],
    sidebar: ["#Desktop_LeftSidebar_Id"],
    panel: ["#Desktop_PanelContainer_Id"],
    navBar: ["#global-nav-bar"],
    homeBtn: ['#global-nav-bar button[data-testid="home-button"]', 'button[data-testid="home-button"]'],
    searchBtn: [
      '#global-nav-bar a[href="/search"]',
      '#global-nav-bar button[data-testid="search-button"]',
      'a[href="/search"]',
      'button[data-testid="search-button"]',
    ],
    searchInput: ['input[data-testid="search-input"]', 'form[role="search"] input'],
    npBar: ['aside[data-testid="now-playing-bar"]', 'aside[data-testid="now-playing-bar"] root'],
    widget: ['div[data-testid="now-playing-widget"]'],
    cover: [
      'div[data-testid="now-playing-widget"] img[data-testid="cover-art-image"]',
      'aside[data-testid="now-playing-bar"] img[data-testid="cover-art-image"]',
      'img[data-testid="cover-art-image"]',
    ],
    title: ['a[data-testid="context-item-link"]', '[data-testid="context-item-link"]'],
    artist: [
      'a[data-testid="context-item-info-artist"]',
      'a[data-testid="context-item-info-show"]',
      '[data-testid="context-item-info-artist"]',
    ],
    like: [
      'div[data-testid="now-playing-widget"] > div:last-child > button',
      'button[data-testid="add-button"]',
      'button[data-testid="now-playing-widget-like-button"]',
    ],
    play: [
      'aside button[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-playpause"]',
    ],
    next: ['aside button[data-testid="control-button-skip-forward"]', 'button[data-testid="control-button-skip-forward"]'],
    prev: ['aside button[data-testid="control-button-skip-back"]', 'button[data-testid="control-button-skip-back"]'],
    shuffle: ['aside button[data-testid="control-button-shuffle"]', 'button[data-testid="control-button-shuffle"]'],
    repeat: ['aside button[data-testid="control-button-repeat"]', 'button[data-testid="control-button-repeat"]'],
    progress: [
      'div[data-testid="playback-progressbar"] input[type="range"]',
      'aside input[type="range"][max]',
    ],
    lyrics: ['button[data-testid="lyrics-button"]'],
    /* --- session extras (take control, links, login) --- */
    trackLink: ['a[data-testid="context-item-link"]', '[data-testid="context-item-link"]'],
    albumLink: [
      'div[data-testid="now-playing-widget"] a[href*="/album/"]',
      'aside[data-testid="now-playing-bar"] a[href*="/album/"]',
      'div[data-testid="now-playing-widget"] img[data-testid="cover-art-image"]',
    ],
    /* Spotify's "this device is not playing" call-to-action. The native app
       auto-clicks it (the old layer did it from a 5 s interval); we look for
       it with an explicit selector first and a label regex as a fallback. */
    takeover: [
      'button[data-testid="takeover-button"]',
      'div[data-testid="now-playing-bar"] div.encore-bright-accent-set button',
      'aside[data-testid="now-playing-bar"] div.encore-bright-accent-set button',
      'aside[data-testid="now-playing-bar"] button[aria-label]',
    ],
    takeoverRows: ['aside[data-testid="now-playing-bar"] ul[role="list"] li[role="listitem"] div[role="button"]'],
    loginPage: ['div[data-testid="login-page"]', 'form[data-testid="login-form"]', '#login-username'],
    webPlayerLink: ['button[data-testid="web-player-link"]', 'a[data-testid="web-player-link"]'],
    pageH1: ['main h1', '#main-view h1'],
    pageSection: ["main section[data-testid]", "#main-view section[data-testid]"],
  };

  var Spotify = {
    /* ---- locate the live progress <input type=range> (position/duration) ---- */
    progressInput: function () {
      return pick(SEL.progress);
    },

    /** True when the web player has booted far enough to be driven. */
    ready: function () {
      return !!(pick(SEL.npBar) && (pick(SEL.play) || this.progressInput()));
    },

    /* ---------------------------------------------------------------- *
     * Read the now-playing state out of the DOM.
     * Everything is defensive: a missing node means "keep last value",
     * never "reset to null" (that bug made the notification flicker).
     * ---------------------------------------------------------------- */
    read: function () {
      var out = {};
      var titleEl = pick(SEL.title);
      if (titleEl) out.title = (titleEl.textContent || "").trim();

      var artistEl = pick(SEL.artist);
      if (artistEl) {
        var a = (artistEl.textContent || "").trim();
        // Spotify sometimes leaves a trailing "· Artist" separator in the node
        out.artist = a.replace(/^[·•\s]+/, "").replace(/[·•\s]+$/, "");
      }

      var coverEl = pick(SEL.cover);
      if (coverEl) out.cover = bestCoverUrl(coverEl);

      var input = this.progressInput();
      if (input) {
        var dur = parseFloat(input.getAttribute("max"));
        var pos = parseFloat(input.value);
        if (isFinite(dur) && dur > 0) out.duration = dur * 1000;
        if (isFinite(pos)) out.position = pos * 1000;
      }

      var like = pick(SEL.like);
      if (like) {
        var checked = like.getAttribute("aria-checked");
        if (checked === "true" || checked === "false") out.liked = checked === "true";
        else {
          var lbl = (like.getAttribute("aria-label") || "").toLowerCase();
          if (/retirer|remove|enlever/.test(lbl)) out.liked = true;
          else if (/ajouter|add|save|liked/.test(lbl)) out.liked = false;
        }
      }

      var repeat = pick(SEL.repeat);
      if (repeat) {
        var rc = repeat.getAttribute("aria-checked");
        out.repeat = rc === "true" ? "context" : rc === "mixed" ? "track" : "off";
      }

      var shuf = pick(SEL.shuffle);
      if (shuf) out.shuffle = shuf.getAttribute("aria-checked") === "true";

      var playing = this.readPlaying();
      if (playing !== null) out.playing = playing;

      out.isEpisode = !!(pick(['a[data-testid="context-item-info-show"]']));
      return out;
    },

    /**
     * Play/pause detection.
     * The old script compared `aria-label === 'Play'` (English only) — on a
     * French device the label is "Lecture", so the mini player never flipped.
     * Strategy: localized word lists → icon shape → video element → last known.
     */
    readPlaying: function () {
      var btn = pick(SEL.play);
      if (btn) {
        var label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label) {
          if (/(pause|pausa|pausar|pauze|pausieren|暂停|一時停止|일시정지|pauza)/.test(label)) return true;
          if (/(^|\s)(play|lecture|reprendre|reanudar|ressortir|afspelen|wiedergabe|播放|再生|재생|воспроизв)/.test(label)) return false;
        }
        // Shape fallback: the pause glyph is 2 shapes, the play glyph is 1.
        var svg = btn.querySelector("svg");
        if (svg) {
          var shapes = svg.querySelectorAll("path, rect, polygon").length;
          if (shapes === 2) return true;
          if (shapes === 1) return false;
        }
      }
      if (document.querySelector(".VideoPlayer__container video")) return true;
      return null; // unknown → caller keeps its optimistic value
    },

    /* ---------------------------------------------------------------- *
     * Control the player. All writes go through Spotify's own buttons so
     * playback bookkeeping, shuffle order and the media session stay
     * consistent — the old layer did this too, we just guard every call
     * and report whether it worked so the UI can roll back.
     * ---------------------------------------------------------------- */
    click: function (selectors) {
      var el = pick(selectors);
      if (!el) return false;
      try {
        el.click();
        return true;
      } catch (e) {
        return false;
      }
    },
    playPause: function () {
      return this.click(SEL.play);
    },
    next: function () {
      return this.click(SEL.next);
    },
    prev: function () {
      return this.click(SEL.prev);
    },
    toggleShuffle: function () {
      return this.click(SEL.shuffle);
    },
    cycleRepeat: function () {
      return this.click(SEL.repeat);
    },
    toggleLike: function () {
      return this.click(SEL.like);
    },

    /**
     * Seek. Two things the old code got wrong:
     *  • `input.value = x` followed by a bare `change` event is silently
     *    dropped by React unless the value is set through the *native*
     *    setter, so half of the seeks did nothing;
     *  • it wrote `pos + 1` (a 1-second offset) with no clamping.
     * We clamp, use the native setter, and dispatch both `input` and `change`.
     */
    seek: function (ms) {
      var input = this.progressInput();
      if (!input) return false;
      var max = parseFloat(input.getAttribute("max")) || 0;
      var seconds = clamp(ms / 1000, 0, max);
      try {
        var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
        var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(input, String(seconds));
        else input.value = String(seconds);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    },

    /** The page the web player currently shows. */
    route: function () {
      if ($('section[data-testid="home-page"]')) return "home";
      if ($('section[data-testid="search-page"]')) return "search";
      var sections = $$(SEL.pageSection.join(","));
      for (var i = 0; i < sections.length; i++) {
        var t = sections[i].getAttribute("data-testid") || "";
        if (/-page$/.test(t) && t !== "home-page" && t !== "search-page") return "page";
      }
      return "other";
    },

    /** Title of the page currently open (playlist/album/artist…). */
    pageTitle: function () {
      var h1 = pick(SEL.pageH1);
      return h1 ? (h1.textContent || "").trim() : "";
    },

    goHome: function () {
      if (this.click(SEL.homeBtn)) return true;
      try {
        location.assign("/");
        return true;
      } catch (e) {
        return false;
      }
    },
    goSearch: function () {
      if (this.click(SEL.searchBtn)) return true;
      try {
        location.assign("/search");
        return true;
      } catch (e) {
        return false;
      }
    },
    /** Internal history, with a guard so we never leave the app. */
    goBack: function () {
      if (History.depth > 0) {
        History.depth--;
        try {
          history.back();
          return true;
        } catch (e) {
          /* fall through */
        }
      }
      return this.goHome();
    },
    focusSearch: function () {
      var input = pick(SEL.searchInput);
      if (!input) return false;
      try {
        input.focus({ preventScroll: true });
        return true;
      } catch (e) {
        return false;
      }
    },
    queueButton: function () {
      return this.findBarButton(/file d'attente|queue/i);
    },
    devicesButton: function () {
      return this.findBarButton(/appareil|device|connect/i);
    },
    lyricsButton: function () {
      return pick(SEL.lyrics);
    },
    /** Absolute URL of the track that is playing (used by "Partager"). */
    trackHref: function () {
      var a = pick(SEL.trackLink);
      var href = a && a.getAttribute("href");
      if (href && href !== "#") {
        return href.indexOf("http") === 0 ? href : "https://open.spotify.com" + href;
      }
      return "https://open.spotify.com/";
    },
    /** Clickable album/artist cover of the now-playing widget. */
    albumLink: function () {
      var el = pick(SEL.albumLink);
      if (!el) return null;
      if (el.tagName === "A" && el.getAttribute("href")) return el;
      var a = el.closest && el.closest("a[href]");
      return a || null;
    },
    /** Scan the (hidden) desktop bar for a button by aria-label. */
    findBarButton: function (re) {
      var bar = pick(SEL.npBar);
      if (!bar) return null;
      var buttons = $$("button[aria-label], [role=\"button\"][aria-label]", bar);
      for (var i = 0; i < buttons.length; i++) {
        var l = buttons[i].getAttribute("aria-label") || "";
        if (re.test(l)) return buttons[i];
      }
      return null;
    },
  };

  /** Highest-resolution URL available for a cover <img>. */
  function bestCoverUrl(img) {
    var srcset = img.getAttribute("srcset");
    if (srcset) {
      var best = null;
      srcset.split(",").forEach(function (part) {
        var bits = part.trim().split(/\s+/);
        if (!bits[0]) return;
        var w = parseFloat(bits[1]) || 0;
        if (!best || w >= best.w) best = { url: bits[0], w: w };
      });
      if (best) return best.url;
    }
    return img.currentSrc || img.src || "";
  }

  /* ------------------------------------------------------------------ *
   * 3. Android bridge (optional)
   * ------------------------------------------------------------------ */
  var Bridge = {
    has: function (name) {
      return !!(window.AndBridge && typeof window.AndBridge[name] === "function");
    },
    call: function (name) {
      if (!this.has(name)) return null;
      var args = Array.prototype.slice.call(arguments, 1);
      try {
        return window.AndBridge[name].apply(window.AndBridge, args);
      } catch (e) {
        return null;
      }
    },
    /** Payload keys kept identical to the previous implementation so the
     *  existing Kotlin/Java notification code keeps working untouched. */
    mediaStatus: function (s) {
      this.call(
        "recMediaStatus",
        JSON.stringify({
          track: s.title || "",
          artist: s.artist || "",
          playing: !!s.playing,
          repeat: s.repeat === "context" ? "true" : s.repeat === "track" ? "mixed" : "false",
          fav: !!s.liked,
          duration: s.duration || 0,
          position: Math.round(s.position || 0),
          cover: s.cover || "",
        })
      );
    },
    mediaPosition: function (ms) {
      this.call("recMediaPosition", Math.round(ms || 0));
    },
    playLoaded: function () {
      this.call("playLoaded");
    },
    uiReady: function () {
      this.call("cssInjected");
    },
    shutdownLock: function (wantShut) {
      this.call("manageTShut", !!wantShut);
    },
    sleepLock: function (wantSleep) {
      this.call("manageTSleep", !!wantSleep);
    },
    wakeUp: function () {
      this.call("wakeUp");
    },
    wakeOff: function () {
      this.call("wakeOff");
    },
    isWoke: function () {
      return this.call("isWoke") === true;
    },
    defer: function (message) {
      this.call("deferMessage", message);
    },
  };

  /* ------------------------------------------------------------------ *
   * 4. State store
   * ------------------------------------------------------------------ */
  var State = {
    title: "",
    artist: "",
    cover: "",
    playing: false,
    position: 0,
    duration: 0,
    liked: false,
    repeat: "off",
    shuffle: false,
    hasTrack: false,
    route: "other",
    tab: "home",
    /* local interpolation between two DOM reads, for a smooth progress bar */
    anchorPos: 0,
    anchorAt: 0,
    seeking: false,
    seekPreview: 0,
  };

  var listeners = [];
  function onState(fn) {
    listeners.push(fn);
  }
  function emit(patch, reason) {
    var before = JSON.stringify(State);
    for (var k in patch) if (patch[k] !== undefined && patch[k] !== null) State[k] = patch[k];
    if (before === JSON.stringify(State)) return;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](State, reason);
      } catch (e) {
        /* one broken listener must not break the UI */
      }
    }
  }

  /** The position to display right now (extrapolated while playing). */
  function livePosition() {
    if (State.seeking) return State.seekPreview;
    if (!State.playing) return State.anchorPos;
    var dt = performance.now() - State.anchorAt;
    return clamp(State.anchorPos + dt, 0, State.duration || Infinity);
  }

  /* ------------------------------------------------------------------ *
   * 5. Mirror — DOM → State (event driven, no 2 s polling loop)
   * ------------------------------------------------------------------ */
  var lastPush = { key: "", at: 0 };

  function syncFromDom(reason) {
    var patch = Spotify.read();
    if (patch.position !== undefined) {
      State.anchorPos = patch.position;
      State.anchorAt = performance.now();
    }
    if (patch.title !== undefined) patch.hasTrack = !!patch.title;
    emit(patch, reason || "sync");
  }

  function pushToAndroid() {
    var key = [State.title, State.artist, State.playing, State.repeat, State.liked, State.cover].join("|");
    var now = Date.now();
    if (key === lastPush.key && now - lastPush.at < 30000) return;
    lastPush.key = key;
    lastPush.at = now;
    Bridge.mediaStatus(State);
    Bridge.mediaPosition(livePosition());
  }

  var Mirror = {
    observer: null,
    probe: null,
    start: function () {
      var bar = pick(SEL.npBar);
      if (!bar) {
        /* La barre « lecture en cours » n'existe qu'une fois le web player
           prêt (et la session ouverte). On la guette au lieu d'abandonner :
           la coque, elle, est déjà affichée. */
        if (!this.probe && window.MutationObserver) {
          var self = this;
          this.probe = new MutationObserver(function () {
            if (!pick(SEL.npBar)) return;
            self.probe.disconnect();
            self.probe = null;
            self.start();
            startPlayer();
          });
          this.probe.observe(document.body, { childList: true, subtree: true });
        }
        return false;
      }
      if (this.observer) this.observer.disconnect();
      this.observer = new MutationObserver(function () {
        syncFromDom("dom");
      });
      this.observer.observe(bar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-checked", "aria-label", "src", "value"],
      });
      // The progress <input> fires native input events while playing.
      var input = Spotify.progressInput();
      if (input) {
        input.addEventListener("input", function () {
          State.anchorPos = (parseFloat(input.value) || 0) * 1000;
          State.anchorAt = performance.now();
        });
      }
      return true;
    },
  };

  /* ------------------------------------------------------------------ *
   * 6. rAF ticker — only runs while something actually moves
   * ------------------------------------------------------------------ */
  var Ticker = {
    raf: 0,
    last: 0,
    lastPush: 0,
    start: function () {
      if (this.raf) return;
      var self = this;
      self.raf = requestAnimationFrame(function tick(now) {
        self.raf = requestAnimationFrame(tick);
        if (now - self.last < 100) return; // 10 fps is plenty for a progress bar
        self.last = now;
        if (!State.playing || State.seeking) return;
        UI.paintProgress();
        /* Keep the Android media session / lock-screen scrubber honest: the
           old layer pushed a position only when it happened to scrape the DOM
           (>4 s drift, every 2 s), which made the lock screen lag behind. */
        if (now - self.lastPush > 15000) {
          self.lastPush = now;
          Bridge.mediaPosition(livePosition());
        }
      });
    },
  };

  /* ------------------------------------------------------------------ *
   * 7. Icons (24×24). Line icons where a stroked glyph reads better on a
   *    small screen, filled where Spotify's own design is solid.
   * ------------------------------------------------------------------ */
  var ICONS = {
    homeLine:
      '<path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z"/>',
    homeSolid:
      '<path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z"/>',
    searchLine:
      '<path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z"/>',
    searchSolid:
      '<path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-4.8 9.279c0-2.77 2.03-4.8 4.8-4.8 2.77 0 4.8 2.03 4.8 4.8 0 2.77-2.03 4.8-4.8 4.8-2.77 0-4.8-2.03-4.8-4.8z"/>',
    libraryLine:
      '<path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6.5 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.8 3.2a1 1 0 0 1 1.2-.7l1.6.4a1 1 0 0 1 .7 1.2l-4.6 17.6a1 1 0 0 1-1.2.7l-1.6-.4a1 1 0 0 1-.7-1.2l4.6-17.6z"/>',
    librarySolid:
      '<path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM9 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm7.4-19.6a1 1 0 0 1 1.2-.7l1.5.4a1 1 0 0 1 .7 1.2l-4.4 17.6a1 1 0 0 1-1.2.7l-1.5-.4a1 1 0 0 1-.7-1.2l4.4-17.6z"/>',
    play: '<path d="M7.05 3.606l13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"/>',
    pause:
      '<path d="M5.7 3a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7H5.7zm9 0a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-3.6z"/>',
    next: '<path d="M17.7 3a.7.7 0 0 0-.7.7v6.805L5.05 3.606A.7.7 0 0 0 4 4.212v15.576a.7.7 0 0 0 1.05.606L17 13.495V20.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-1.6z"/>',
    prev: '<path d="M6.3 3a.7.7 0 0 1 .7.7v6.805l11.95-6.899A.7.7 0 0 1 20 4.212v15.576a.7.7 0 0 1-1.05.606L7 13.495V20.3a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7V3.7a.7.7 0 0 1 .7-.7h1.6z"/>',
    shuffleLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4.5 21 7.5l-3 3"/><path d="M18 13.5l3 3-3 3"/><path d="M3 7.5h3.7a4 4 0 0 1 3.4 1.9l3 5.2a4 4 0 0 0 3.4 1.9H21"/><path d="M3 16.5h3.7a4 4 0 0 0 3.4-1.9l3-5.2A4 4 0 0 1 16.5 7.5H21"/></g>',
    repeatLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5l3 3-3 3"/><path d="M20 6.5H7a4 4 0 0 0-4 4v1"/><path d="M7 20.5l-3-3 3-3"/><path d="M4 17.5h13a4 4 0 0 0 4-4v-1"/></g>',
    heartLine:
      '<path d="M12 20.7 4.9 13.9A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 7.1 6.7L12 20.7z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    heartSolid:
      '<path d="M12 20.7 4.9 13.9A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 7.1 6.7L12 20.7z"/>',
    checkCircle:
      '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.7 7.7-5.4 5.4a1 1 0 0 1-1.4 0l-2.6-2.6 1.4-1.4 1.9 1.9 4.7-4.7 1.4 1.4z"/>',
    /* Tête de canard du logo — écran d'accueil et icône de notification. */
    duck:
      '<path d="M13.5 2.3a6.3 6.3 0 0 0-6.1 7.9L2.7 12a1 1 0 0 0 0 1.9l4.7 1.8A6.3 6.3 0 1 0 13.5 2.3zm1.6 4.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>',
    queueLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 12h12M4 18h7"/><path d="M17.5 14.5 21.5 17l-4 2.5z" fill="currentColor" stroke="none"/></g>',
    deviceLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="1.5"/><circle cx="12" cy="9.5" r="2.6"/><circle cx="12" cy="16.5" r="1.6"/></g>',
    lyricsLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8.5L18 7v13.5H6z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 8h3.5"/></g>',
    shareLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><path d="M8.5 7 12 3.5 15.5 7"/><path d="M5.5 11.5v8h13v-8"/></g>',
    plusLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></g>',
    chevronDown:
      '<path d="M5.3 9.1a1 1 0 0 1 1.4 0L12 14.4l5.3-5.3a1 1 0 1 1 1.4 1.4L12 17.2 5.3 10.5a1 1 0 0 1 0-1.4z"/>',
    chevronLeft:
      '<path d="M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 0 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0z"/>',
    ellipsis:
      '<path d="M6 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zm7.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zm7.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z"/>',
    musicNote:
      '<path d="M20 3.2v12.3a3.5 3.5 0 1 1-2-3.2V6.6l-8 1.7v9.2a3.5 3.5 0 1 1-2-3.2V5.6l12-2.4z"/>',
    gearLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.2 1.9 2.2-.5.6 2.2 2 .9-.9 2 1.2 1.9-1.2 1.9.9 2-2 .9-.6 2.2-2.2-.5L12 21.2l-1.2-1.9-2.2.5-.6-2.2-2-.9.9-2L5.7 12l1.2-1.9-.9-2 2-.9.6-2.2 2.2.5z"/></g>',
    discLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></g>',
    /* Barre de navigation supérieure (disposition d'origine de SpotiDuck). */
    bellLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.2 5.6 2.2 6.6.5.5.1 1.4-.6 1.4H4.4c-.7 0-1.1-.9-.6-1.4C4.8 15.1 6 13.5 6 9.5z"/><path d="M9.8 20.2a2.4 2.4 0 0 0 4.4 0"/></g>',
    friendsLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.2" cy="8.6" r="3.4"/><path d="M2.8 19.4c0-3 2.9-5 6.4-5s6.4 2 6.4 5"/><path d="M16.4 6.2a3.2 3.2 0 0 1 0 6.2"/><path d="M17.6 14.8c2.2.5 3.6 1.9 3.6 4"/></g>',
    spotifyLogo:
      '<g><circle cx="12" cy="12" r="10"/><g fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round"><path d="M7 9c3.3-.9 6.7-.5 9.6 1.3"/><path d="M7.6 12.6c2.7-.7 5.4-.4 7.8 1.1"/><path d="M8.2 15.9c2.1-.5 4.2-.3 6 .9"/></g></g>',
    personLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.4c0-3.3 3.2-5.6 7.2-5.6s7.2 2.3 7.2 5.6"/></g>',
    refreshLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.6V8h-4.4"/></g>',
    cloudOffLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 18h8a4 4 0 0 0 .8-7.9 5.5 5.5 0 0 0-8-2.6M6.6 18a3.8 3.8 0 0 1-.4-7.6"/><path d="M3.5 3.5l17 17"/></g>',
    checkLine: '<path d="M9.6 16.3 5.3 12l-1.4 1.4 5.7 5.7L20.4 7.4 19 6z"/>',
    shieldLine:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9.5 12l1.8 1.8L14.8 10"/></svg>',
    arrowUndo:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></g>',
    plusCircle:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></g>',
  };

  function svg(paths, cls) {
    return (
      '<svg class="' +
      (cls || "") +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      paths +
      "</svg>"
    );
  }

  /* ------------------------------------------------------------------ *
   * 8. UI construction
   * ------------------------------------------------------------------ */
  var UI = {
    layer: null,
    el: {},
    built: false,

    build: function () {
      if (this.built) return;
      var L = document.createElement("div");
      L.className = "sd-layer";
      L.setAttribute("data-sd-version", VERSION);

      /* ---- top bar (library title / back button on sub-pages) ---- */
      var topbar = document.createElement("header");
      topbar.className = "sd-topbar";
      topbar.innerHTML =
        '<button class="sd-iconbtn sd-back" type="button" aria-label="' +
        Settings.labels.back +
        '">' +
        svg(ICONS.chevronLeft) +
        "</button>" +
        '<div class="sd-topbar-title"></div>' +
        '<button class="sd-iconbtn sd-topbar-gear" type="button" aria-label="' +
        Settings.labels.settings +
        '">' +
        svg(ICONS.gearLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-topbar-close" type="button" aria-label="' +
        Settings.labels.close +
        '">' +
        svg(ICONS.chevronDown) +
        "</button>";

      /* ---- barre de navigation supérieure (disposition d'origine) ----
         Maison · Bibliothèque · Recherche sont les trois vues ; le logo rappelle
         l'application, et les trois icônes de droite ouvrent les écrans de
         Spotify (notifications, amis, profil). Sur les sous-pages, la barre de
         titre ci-dessus reprend la main. */
      var nav = document.createElement("nav");
      nav.className = "sd-nav";
      nav.setAttribute("role", "tablist");
      nav.setAttribute("aria-label", Settings.labels.app);
      nav.innerHTML = [
        navItem("home", ICONS.homeLine, ICONS.homeSolid, Settings.labels.home),
        navItem("library", ICONS.libraryLine, ICONS.librarySolid, Settings.labels.library),
        navItem("search", ICONS.searchLine, ICONS.searchSolid, Settings.labels.search),
        '<span class="sd-nav-logo" aria-hidden="true">' + svg(ICONS.spotifyLogo) + "</span>",
        '<button class="sd-iconbtn sd-nav-bell" type="button" aria-label="' +
          Settings.labels.notifications +
          '">' +
          svg(ICONS.bellLine) +
          "</button>",
        '<button class="sd-iconbtn sd-nav-friends" type="button" aria-label="' +
          Settings.labels.friends +
          '">' +
          svg(ICONS.friendsLine) +
          "</button>",
        '<button class="sd-iconbtn sd-nav-profile" type="button" aria-label="' +
          Settings.labels.profile +
          '">' +
          svg(ICONS.personLine) +
          "</button>",
      ].join("");

      /* ---- mini player : le lecteur complet, comme dans l'application ----
         Ligne 1 · pochette, titre, artiste, j'aime
         Ligne 2 · aléatoire, précédent, lecture, suivant, répétition
         Ligne 3 · temps écoulé, barre de progression, durée totale */
      var mini = document.createElement("div");
      mini.className = "sd-mini";
      mini.setAttribute("role", "button");
      mini.setAttribute("tabindex", "0");
      mini.setAttribute("aria-label", Settings.labels.nowPlaying);
      mini.innerHTML =
        '<div class="sd-mini-top">' +
        '<div class="sd-mini-art"><img alt="" decoding="async"></div>' +
        '<div class="sd-mini-meta">' +
        '<span class="sd-mini-title"></span>' +
        '<span class="sd-mini-artist"></span>' +
        "</div>" +
        '<button class="sd-iconbtn sd-mini-like" type="button" aria-label="' +
        Settings.labels.like +
        '">' +
        svg(ICONS.heartLine, "sd-icon-line") +
        svg(ICONS.heartSolid, "sd-icon-solid") +
        "</button>" +
        "</div>" +
        '<div class="sd-mini-row">' +
        '<button class="sd-iconbtn sd-mini-shuffle" type="button" aria-label="' +
        Settings.labels.shuffle +
        '">' +
        svg(ICONS.shuffleLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-prev" type="button" aria-label="' +
        Settings.labels.previous +
        '">' +
        svg(ICONS.prev) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-play" type="button"></button>' +
        '<button class="sd-iconbtn sd-mini-next" type="button" aria-label="' +
        Settings.labels.next +
        '">' +
        svg(ICONS.next) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-repeat" type="button" aria-label="' +
        Settings.labels.repeat +
        '">' +
        svg(ICONS.repeatLine) +
        "</button>" +
        "</div>" +
        '<div class="sd-mini-seek-row">' +
        '<span class="sd-mini-time sd-mini-cur">0:00</span>' +
        '<div class="sd-mini-seek" role="slider" tabindex="0" aria-label="' +
        Settings.labels.progress +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        "<i></i>" +
        "</div>" +
        '<span class="sd-mini-time sd-mini-dur">0:00</span>' +
        "</div>";

      /* ---- tab bar ---- */
      var tabbar = document.createElement("nav");
      tabbar.className = "sd-tabbar";
      tabbar.setAttribute("role", "tablist");
      tabbar.innerHTML = [
        tab("home", ICONS.homeLine, ICONS.homeSolid, Settings.labels.home),
        tab("search", ICONS.searchLine, ICONS.searchSolid, Settings.labels.search),
        tab("library", ICONS.libraryLine, ICONS.librarySolid, Settings.labels.library),
      ].join("");

      /* ---- full player sheet ---- */
      var player = document.createElement("section");
      player.className = "sd-player";
      player.setAttribute("role", "dialog");
      player.setAttribute("aria-modal", "true");
      player.setAttribute("aria-label", Settings.labels.nowPlaying);
      player.setAttribute("aria-hidden", "true");
      player.innerHTML =
        '<header class="sd-player-head">' +
        '<button class="sd-iconbtn sd-player-close" type="button" aria-label="' +
        Settings.labels.close +
        '">' +
        svg(ICONS.chevronDown) +
        "</button>" +
        '<div class="sd-player-title"></div>' +
        '<button class="sd-iconbtn sd-player-menu" type="button" aria-label="' +
        Settings.labels.queue +
        '">' +
        svg(ICONS.ellipsis) +
        "</button>" +
        "</header>" +
        '<div class="sd-player-body">' +
        '<div class="sd-player-art">' +
        '<img alt="" decoding="async">' +
        '<div class="sd-player-art-empty">' +
        svg(ICONS.musicNote) +
        "</div>" +
        "</div>" +
        '<div class="sd-player-right">' +
        '<div class="sd-player-meta">' +
        '<div class="sd-player-text">' +
        '<h1 class="sd-player-track"></h1>' +
        '<span class="sd-player-artist"></span>' +
        "</div>" +
        '<button class="sd-iconbtn sd-like" type="button">' +
        svg(ICONS.heartLine, "sd-icon-line") +
        svg(ICONS.heartSolid, "sd-icon-solid") +
        "</button>" +
        "</div>" +
        '<div class="sd-seek" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<div class="sd-seek-rail"><div class="sd-seek-track">' +
        '<div class="sd-seek-fill"></div><div class="sd-seek-thumb"></div>' +
        "</div></div>" +
        '<div class="sd-times"><span class="sd-t-cur">0:00</span><span class="sd-t-dur">0:00</span></div>' +
        "</div>" +
        '<div class="sd-player-controls">' +
        '<button class="sd-iconbtn sd-ctrl-shuffle" type="button" aria-label="' +
        Settings.labels.shuffle +
        '">' +
        svg(ICONS.shuffleLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-prev" type="button" aria-label="' +
        Settings.labels.prev +
        '">' +
        svg(ICONS.prev) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-play" type="button"></button>' +
        '<button class="sd-iconbtn sd-ctrl-next" type="button" aria-label="' +
        Settings.labels.next +
        '">' +
        svg(ICONS.next) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-repeat" type="button" aria-label="' +
        Settings.labels.repeat +
        '">' +
        svg(ICONS.repeatLine) +
        "</button>" +
        "</div>" +
        '<div class="sd-player-bottom">' +
        '<button class="sd-iconbtn sd-ctrl-device" type="button" aria-label="' +
        Settings.labels.devices +
        '">' +
        svg(ICONS.deviceLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-queue" type="button" aria-label="' +
        Settings.labels.queue +
        '">' +
        svg(ICONS.queueLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-lyrics" type="button" aria-label="' +
        Settings.labels.lyrics +
        '">' +
        svg(ICONS.lyricsLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-ctrl-share" type="button" aria-label="' +
        Settings.labels.share +
        '">' +
        svg(ICONS.shareLine) +
        "</button>" +
        "</div>" +
        '<div class="sd-player-empty">' +
        Settings.labels.noTrack +
        "</div>" +
        "</div>" +
        "</div>";

      /* ---- écran d'accueil (session déconnectée) ---- */
      var welcome = document.createElement("section");
      welcome.className = "sd-welcome";
      welcome.setAttribute("aria-hidden", "true");
      welcome.innerHTML =
        '<div class="sd-welcome-card">' +
        '<span class="sd-welcome-logo">' +
        svg(ICONS.duck) +
        "</span>" +
        '<h1 class="sd-welcome-title">' +
        Settings.labels.welcomeTitle +
        "</h1>" +
        '<p class="sd-welcome-text">' +
        Settings.labels.welcomeText +
        "</p>" +
        '<a class="sd-btn sd-welcome-cta" href="/login?allow_password=1">' +
        Settings.labels.welcomeCta +
        "</a>" +
        '<p class="sd-welcome-note">' +
        Settings.labels.welcomeNote +
        "</p>" +
        "</div>";

      /* ---- queue sheet scrim + grabber ---- */
      var scrim = document.createElement("div");
      scrim.className = "sd-scrim";
      var grabber = document.createElement("div");
      grabber.className = "sd-sheet-grabber";

      /* ---- login helper + offline banner ---- */
      var loginCta = document.createElement("a");
      loginCta.className = "sd-login-cta";
      loginCta.href = "/login?allow_password=1";
      loginCta.textContent = Settings.labels.classicLogin;
      var offlineBar = document.createElement("div");
      offlineBar.className = "sd-offline-bar";
      offlineBar.setAttribute("role", "status");
      offlineBar.innerHTML =
        '<span class="sd-offline-icon">' + svg(ICONS.cloudOffLine) + "</span>" +
        "<span>" + Settings.labels.offline + "</span>";

      L.appendChild(nav);
      L.appendChild(topbar);
      L.appendChild(mini);
      L.appendChild(tabbar);
      L.appendChild(scrim);
      L.appendChild(grabber);
      L.appendChild(player);
      L.appendChild(loginCta);
      L.appendChild(offlineBar);
      L.appendChild(welcome);
      document.body.appendChild(L);

      this.layer = L;
      /* The sheets live in the same layer, so they are built once the layer
         handle exists. */
      Sheets.build();

      this.el = {
        topbar: topbar,
        topbarBack: $(".sd-back", topbar),
        topbarTitle: $(".sd-topbar-title", topbar),
        topbarGear: $(".sd-topbar-gear", topbar),
        topbarClose: $(".sd-topbar-close", topbar),
        mini: mini,
        miniImg: $(".sd-mini-art img", mini),
        miniTitle: $(".sd-mini-title", mini),
        miniArtist: $(".sd-mini-artist", mini),
        miniLike: $(".sd-mini-like", mini),
        miniShuffle: $(".sd-mini-shuffle", mini),
        miniPrev: $(".sd-mini-prev", mini),
        miniPlay: $(".sd-mini-play", mini),
        miniNext: $(".sd-mini-next", mini),
        miniRepeat: $(".sd-mini-repeat", mini),
        miniCur: $(".sd-mini-cur", mini),
        miniDur: $(".sd-mini-dur", mini),
        miniSeek: $(".sd-mini-seek", mini),
        miniProgress: $(".sd-mini-seek > i", mini),
        nav: nav,
        navItems: $$(".sd-nav-item", nav),
        navBell: $(".sd-nav-bell", nav),
        navFriends: $(".sd-nav-friends", nav),
        navProfile: $(".sd-nav-profile", nav),
        tabbar: tabbar,
        tabs: $$(".sd-tab", tabbar),
        player: player,
        playerTitle: $(".sd-player-title", player),
        playerClose: $(".sd-player-close", player),
        playerMenu: $(".sd-player-menu", player),
        art: $(".sd-player-art", player),
        artImg: $(".sd-player-art img", player),
        artEmpty: $(".sd-player-art-empty", player),
        track: $(".sd-player-track", player),
        artist: $(".sd-player-artist", player),
        like: $(".sd-like", player),
        seek: $(".sd-seek", player),
        seekRail: $(".sd-seek-rail", player),
        seekFill: $(".sd-seek-fill", player),
        seekThumb: $(".sd-seek-thumb", player),
        tCur: $(".sd-t-cur", player),
        tDur: $(".sd-t-dur", player),
        play: $(".sd-ctrl-play", player),
        next: $(".sd-ctrl-next", player),
        prev: $(".sd-ctrl-prev", player),
        shuffle: $(".sd-ctrl-shuffle", player),
        repeat: $(".sd-ctrl-repeat", player),
        device: $(".sd-ctrl-device", player),
        queue: $(".sd-ctrl-queue", player),
        lyrics: $(".sd-ctrl-lyrics", player),
        share: $(".sd-ctrl-share", player),
        empty: $(".sd-player-empty", player),
        right: $(".sd-player-right", player),
        scrim: scrim,
        grabber: grabber,
        loginCta: loginCta,
        offlineBar: offlineBar,
        welcome: welcome,
        welcomeCta: $(".sd-welcome-cta", welcome),
      };
      this.built = true;
      this.bind();
      this.paint(State, "build");
    },

    /* ---------------- painting ---------------- */
    paint: function (s, reason) {
      if (!this.built) return;
      var e = this.el;


      /* titles */
      if (e.miniTitle.textContent !== s.title) e.miniTitle.textContent = s.title || "";
      if (e.miniArtist.textContent !== s.artist) e.miniArtist.textContent = s.artist || "";
      if (e.track.textContent !== s.title) e.track.textContent = s.title || "";
      if (e.artist.textContent !== s.artist) e.artist.textContent = s.artist || "";
      var ctx = s.artist || Settings.labels.nowPlaying;
      if (e.playerTitle.textContent !== ctx) e.playerTitle.textContent = ctx;

      /* covers */
      if (s.cover && e.miniImg.getAttribute("src") !== s.cover) {
        setImage(e.miniImg, s.cover);
      }
      if (s.cover && e.artImg.getAttribute("src") !== s.cover) {
        setImage(e.artImg, s.cover);
        Accent.apply(s.cover, s.title);
      }
      e.artEmpty.style.display = s.cover ? "none" : "grid";
      e.empty.style.display = s.hasTrack ? "none" : "block";
      e.art.style.display = s.hasTrack ? "" : "none";

      /* play/pause */
      var playGlyph = svg(s.playing ? ICONS.pause : ICONS.play);
      e.play.innerHTML = playGlyph;
      e.miniPlay.innerHTML = playGlyph;
      e.play.setAttribute("aria-label", s.playing ? Settings.labels.pause : Settings.labels.play);
      e.miniPlay.setAttribute("aria-label", s.playing ? Settings.labels.pause : Settings.labels.play);

      /* like */
      toggle(e.like, "is-active", s.liked);
      toggle(e.miniLike, "is-active", s.liked);
      e.like.setAttribute("aria-label", s.liked ? Settings.labels.unlike : Settings.labels.like);

      /* shuffle / repeat (feuille du lecteur **et** mini-lecteur) */
      [e.shuffle, e.miniShuffle].forEach(function (btn) {
        if (!btn) return;
        toggle(btn, "is-active", !!s.shuffle);
        btn.setAttribute("aria-checked", s.shuffle ? "true" : "false");
      });
      [e.repeat, e.miniRepeat].forEach(function (btn) {
        if (!btn) return;
        toggle(btn, "is-active", s.repeat !== "off");
        toggle(btn, "is-one", s.repeat === "track");
        btn.setAttribute(
          "aria-checked",
          s.repeat === "off" ? "false" : s.repeat === "track" ? "mixed" : "true"
        );
      });

      /* disable what the web player cannot do here */
      e.lyrics.hidden = !Spotify.lyricsButton();
      e.device.hidden = !Spotify.devicesButton();
      e.queue.hidden = !Spotify.queueButton() && !$("#Desktop_PanelContainer_Id");

      /* duration (feuille du lecteur + mini-lecteur) */
      e.tDur.textContent = fmtTime(s.duration);
      if (e.miniDur) e.miniDur.textContent = fmtTime(s.duration);
      this.paintProgress();

      /* route chrome */
      this.paintChrome(s);
      pushToAndroid();
    },

    paintProgress: function () {
      if (!this.built) return;
      var s = State;
      var pos = livePosition();
      var ratio = s.duration > 0 ? clamp(pos / s.duration, 0, 1) : 0;
      this.el.miniProgress.style.width = (ratio * 100).toFixed(2) + "%";
      if (this.el.miniCur && !s.seeking) this.el.miniCur.textContent = fmtTime(pos);
      if (this.el.miniSeek) {
        var pct = String(Math.round(ratio * 100));
        if (this.el.miniSeek.getAttribute("aria-valuenow") !== pct) {
          this.el.miniSeek.setAttribute("aria-valuenow", pct);
        }
      }
      if (!s.seeking) {
        this.el.seekFill.style.width = (ratio * 100).toFixed(2) + "%";
        this.el.seekThumb.style.left = (ratio * 100).toFixed(2) + "%";
        this.el.tCur.textContent = fmtTime(pos);
        if (this.el.seek.getAttribute("aria-valuenow") !== String(Math.round(ratio * 100))) {
          this.el.seek.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
        }
      }
    },

    /** Header / tab-bar visibility for the current route + tab. */
    paintChrome: function (s) {
      var e = this.el;
      var html = document.documentElement;
      var isLibrary = s.tab === "library";
      var isSubPage = s.route === "page";

      html.classList.toggle("sd-subpage", isSubPage && !isLibrary);
      html.classList.toggle("sd-has-track", !!s.hasTrack);
      /* The stylesheet keys the whole layout off these three classes
         (`html.sd-tab-search` restyles the desktop top bar into a mobile
         search field, `html.sd-tab-library` turns the desktop sidebar into a
         full-screen page). Missing them was the reason the library/search
         pages kept their desktop chrome. */
      html.classList.toggle("sd-tab-home", s.tab === "home");
      html.classList.toggle("sd-tab-search", s.tab === "search");
      html.classList.toggle("sd-tab-library", s.tab === "library");

      e.tabs.forEach(function (t) {
        var name = t.getAttribute("data-tab");
        var active = name === s.tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });

      /* Barre de navigation supérieure : présente sur les trois vues
         (accueil, recherche, bibliothèque). Sur une sous-page — playlist,
         album, artiste —, c'est la barre de titre ci-dessous qui prend la
         main, avec son bouton retour. */
      var navOn = !isSubPage;
      html.classList.toggle("sd-nav-on", navOn);
      e.navItems.forEach(function (item) {
        var name = item.getAttribute("data-tab");
        var active = name === s.tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });

      var showTop = isLibrary || isSubPage;
      e.topbar.classList.toggle("is-visible", showTop);
      e.topbarBack.style.display = isSubPage ? "" : "none";
      e.topbarClose.style.display = isLibrary ? "" : "none";
      e.topbarTitle.classList.toggle("is-large", isLibrary);
      var label = isLibrary ? Settings.labels.library : Spotify.pageTitle() || "";
      if (e.topbarTitle.textContent !== label) e.topbarTitle.textContent = label;

      // Class-driven so the mini player docks correctly when the bar is off
      // (see `html.sd-no-tabbar` in the stylesheet).
      html.classList.toggle("sd-no-tabbar", !Settings.tabbar);
      document.body.classList.toggle("sd-player-open", Player.open);
      document.body.classList.toggle("sd-panel-open", Queue.open);
      html.classList.toggle("sd-queue-open", Queue.open);
    },

    /* ---------------- events ---------------- */
    bind: function () {
      var e = this.el;
      var self = this;

      /* tab bar (bas, désactivée par défaut) */
      e.tabbar.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".sd-tab");
        if (!btn) return;
        Router.tab(btn.getAttribute("data-tab"));
      });

      /* barre de navigation supérieure : mêmes trois vues, plus les écrans de
         Spotify (notifications, amis, profil) */
      e.nav.addEventListener("click", function (ev) {
        var item = ev.target.closest(".sd-nav-item");
        if (item) {
          Router.tab(item.getAttribute("data-tab"));
          return;
        }
        if (ev.target.closest(".sd-nav-bell")) Actions.spotifyButton("bell");
        else if (ev.target.closest(".sd-nav-friends")) Actions.spotifyButton("friends");
        else if (ev.target.closest(".sd-nav-profile")) Actions.spotifyButton("profile");
      });

      /* mini player: tap = open, controls stop propagation */
      e.mini.addEventListener("click", function (ev) {
        if (ev.target.closest(".sd-iconbtn")) return;
        Player.openSheet();
      });
      e.mini.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          Player.openSheet();
        }
      });
      e.miniPlay.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.playPause();
      });
      e.miniNext.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.next();
      });
      e.miniPrev.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.prev();
      });
      e.miniShuffle.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.shuffle();
      });
      e.miniRepeat.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.repeat();
      });
      e.miniLike.addEventListener("click", function (ev) {
        ev.stopPropagation();
        Actions.like();
      });

      /* player sheet */
      e.playerClose.addEventListener("click", function () {
        Player.closeSheet();
      });
      e.play.addEventListener("click", function () {
        Actions.playPause();
      });
      e.next.addEventListener("click", function () {
        Actions.next();
      });
      e.prev.addEventListener("click", function () {
        Actions.prev();
      });
      e.shuffle.addEventListener("click", function () {
        Actions.shuffle();
      });
      e.repeat.addEventListener("click", function () {
        Actions.repeat();
      });
      e.like.addEventListener("click", function () {
        Actions.like();
      });
      e.queue.addEventListener("click", function () {
        Queue.toggle();
      });
      /* "…" opens our options sheet (queue, lyrics, devices, links, share,
         settings) instead of jumping straight to the queue. */
      e.playerMenu.addEventListener("click", function () {
        Sheets.open("menu");
      });
      e.topbarGear.addEventListener("click", function () {
        Sheets.open("settings");
      });
      e.device.addEventListener("click", function () {
        var b = Spotify.devicesButton();
        if (b) b.click();
      });
      e.lyrics.addEventListener("click", function () {
        var b = Spotify.lyricsButton();
        if (b) b.click();
      });
      e.share.addEventListener("click", function () {
        Actions.share();
      });
      e.artist.addEventListener("click", function () {
        Actions.openArtist();
      });
      e.topbarBack.addEventListener("click", function () {
        Spotify.goBack();
      });
      e.topbarClose.addEventListener("click", function () {
        Router.tab("home");
      });
      e.scrim.addEventListener("click", function () {
        if (Sheets.active) Sheets.close();
        else Queue.close();
      });

      /* keyboard */
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          if (Sheets.active) Sheets.close();
          else if (Queue.open) Queue.close();
          else if (Player.open) Player.closeSheet();
          return;
        }
        if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
        if (ev.key === " " && Player.open) {
          ev.preventDefault();
          Actions.playPause();
        }
      });

      /* pointer gestures */
      Gestures.bind();
    },
  };

  /**
   * Élément de la barre de navigation **supérieure** : c'est la disposition de
   * l'application d'origine (maison · bibliothèque · recherche · logo ·
   * notifications · amis · profil), pas les onglets du bas.
   */
  function navItem(name, line, solid, label) {
    return (
      '<button class="sd-nav-item" type="button" role="tab" data-tab="' +
      name +
      '" aria-label="' +
      label +
      '" aria-selected="false">' +
      svg(line, "sd-icon-line") +
      svg(solid, "sd-icon-solid") +
      "</button>"
    );
  }

  function tab(name, line, solid, label) {
    return (
      '<button class="sd-tab" type="button" role="tab" data-tab="' +
      name +
      '" aria-label="' +
      label +
      '" aria-selected="false">' +
      svg(line, "sd-icon-line") +
      svg(solid, "sd-icon-solid") +
      '<span class="sd-tab-label">' +
      label +
      "</span></button>"
    );
  }
  function toggle(el, cls, on) {
    if (!el) return;
    el.classList.toggle(cls, !!on);
  }
  function setImage(img, url) {
    if (!img) return;
    img.classList.remove("is-loaded");
    var done = function () {
      img.classList.add("is-loaded");
    };
    img.onload = done;
    img.onerror = done; // a broken cover must not leave an empty grey square
    img.setAttribute("src", url);
    // Cached images sometimes resolve before the listener is attached.
    if (img.complete && img.naturalWidth > 0) done();
  }

  /* ------------------------------------------------------------------ *
   * 9. Accent colour (cover art → player gradient)
   *    Cross-origin covers can taint the canvas: every step is guarded and
   *    falls back to a deterministic hue derived from the track name, so the
   *    player never ends up with a flat black background.
   * ------------------------------------------------------------------ */
  var Accent = {
    cache: {},
    apply: function (url, seed) {
      var html = document.documentElement;
      if (!Settings.accentFromArt || !url) {
        html.style.removeProperty("--sd-player-bg");
        html.style.removeProperty("--sd-mini-bg");
        return;
      }
      if (this.cache[url]) {
        this.set(this.cache[url]);
        return;
      }
      var self = this;
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        var rgb = self.sample(img);
        if (!rgb) rgb = self.fallback(seed || url);
        self.cache[url] = rgb;
        self.set(rgb);
      };
      img.onerror = function () {
        var rgb = self.fallback(seed || url);
        self.cache[url] = rgb;
        self.set(rgb);
      };
      img.src = url;
    },
    /** Average the most saturated pixel cluster of a 24×24 thumbnail. */
    sample: function (img) {
      try {
        var c = document.createElement("canvas");
        c.width = c.height = 24;
        var ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        var data = ctx.getImageData(0, 0, 24, 24).data;
        var r = 0, g = 0, b = 0, n = 0, best = null, bestScore = -1;
        for (var i = 0; i < data.length; i += 4) {
          var R = data[i], G = data[i + 1], B = data[i + 2];
          var max = Math.max(R, G, B), min = Math.min(R, G, B);
          var sat = max === 0 ? 0 : (max - min) / max;
          var lum = (R * 0.299 + G * 0.587 + B * 0.114) / 255;
          var score = sat * (1 - Math.abs(lum - 0.45));
          if (score > bestScore) {
            bestScore = score;
            best = [R, G, B];
          }
          r += R; g += G; b += B; n++;
        }
        var avg = [r / n, g / n, b / n];
        var base = bestScore > 0.25 ? best : avg;
        return [Math.round(base[0]), Math.round(base[1]), Math.round(base[2])];
      } catch (e) {
        return null; // tainted canvas (no CORS header) → caller falls back
      }
    },
    fallback: function (seed) {
      var hue = hashHue(String(seed || "spotiduck"));
      var c = hslToRgb(hue, 0.45, 0.28);
      return c;
    },
    /** Darken/saturate for a real-looking Spotify gradient. */
    set: function (rgb) {
      var deep = mix(rgb, [0, 0, 0], 0.62);
      var html = document.documentElement;
      html.style.setProperty(
        "--sd-player-bg",
        "linear-gradient(to bottom, rgb(" + deep.join(",") + ") 0%, #121212 46%, #000 100%)"
      );
      html.style.setProperty("--sd-mini-bg", "rgb(" + mix(rgb, [0, 0, 0], 0.76).join(",") + ")");
      html.style.setProperty("--sd-accent", "rgb(" + rgb.join(",") + ")");
    },
  };

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(function (v) {
      return Math.round((v + m) * 255);
    });
  }

  /* ------------------------------------------------------------------ *
   * 10. Actions — optimistic UI + verification
   *     The old layer wrote `isfav = true` / `repmode = 'mixed'` in JS and
   *     *hoped* the web player agreed. Here every action updates the UI
   *     immediately, then re-reads the DOM shortly after so the two can
   *     never drift apart.
   * ------------------------------------------------------------------ */
  /**
   * Boutons de droite de la barre de navigation : ils ouvrent **les** écrans de
   * Spotify (notifications, activité des amis, menu du profil) en cliquant le
   * bouton correspondant du web player. Si Spotify ne propose pas ce bouton
   * (page de connexion, autre version), on le dit au lieu de laisser un bouton
   * qui ne fait rien.
   */
  var SPOTIFY_BUTTONS = {
    bell: [
      '[data-testid="notification-button"]',
      'button[aria-label*="otification"]',
      '[data-testid="whats-new-button"]',
      'button[aria-label*="ouveaut"]',
    ],
    friends: [
      '[data-testid="friends-button"]',
      'button[aria-label*="ctivit"]',
      'button[aria-label*="riends"]',
      'button[aria-label*="rofil d"]',
    ],
    profile: [
      '[data-testid="user-widget-link"]',
      'button[data-testid="user-widget-link"]',
      '[data-testid="user-widget-dropdown"]',
      'button[aria-label*="rofil"]',
      'button[aria-label*="count"]',
    ],
  };

  var Actions = {
    /* Play Protect interrompt parfois l'installation d'un APK signé hors du
       Play Store. L'application ne peut pas le désactiver (c'est un service
       Google, pas une permission Android) mais elle ouvre le réglage — sinon
       il faut le chercher dans le Play Store. */
    playprotect: function () {
      if (Bridge.call("openPlayProtect")) {
        Toast.show(Settings.labels.playProtectHint, 4200);
        return true;
      }
      Toast.show(Settings.labels.playProtectManual, 4200);
      return false;
    },
    settle: function (delay) {
      clearTimeout(Actions._t);
      Actions._t = setTimeout(function () {
        syncFromDom("settle");
      }, delay || 700);
    },
    playPause: function () {
      var want = !State.playing;
      Auto.wantPlay = want;
      Auto.selfPaused = !want;
      if (want) {
        Auto.stuckTries = 0;
        Auto.resumeCount = 0;
      }
      emit({ playing: want }, "optimistic");
      buzz(Settings.labels.buzzTap);
      if (!Spotify.playPause()) {
        emit({ playing: !want }, "rollback");
      } else if (want) {
        /* Starting playback may require the "Écouter sur cet appareil"
           hand-off first, and Spotify sometimes swallows the first request
           entirely — both cases are handled by the Auto module. */
        setTimeout(function () {
          Auto.maybeTakeover();
        }, 400);
        Auto.armStuck();
      }
      Bridge.mediaStatus(State);
      Bridge.mediaPosition(livePosition());
      this.syncLocks();
      this.settle();
    },
    /**
     * Mirrors the old `manageAll(playing)` behaviour on the Android side:
     * keep the CPU awake + arm the sleep timer while playing, and the
     * inverse (shutdown on pause) when stopped. Same two bridge calls the
     * native code already implements.
     */
    syncLocks: function () {
      if (State.playing) {
        Bridge.sleepLock(true);
        Bridge.shutdownLock(false);
      } else {
        Bridge.sleepLock(false);
        Bridge.shutdownLock(true);
      }
    },
    next: function () {
      buzzer();
      Auto.wantPlay = true;
      Auto.selfPaused = false;
      if (!Spotify.next()) return;
      setTimeout(function () {
        Auto.maybeTakeover();
      }, 400);
      emit({ anchorPos: 0, position: 0, anchorAt: performance.now() }, "optimistic");
      Actions.settle(900);
    },
    prev: function () {
      buzzer();
      // Native behaviour: restart the track first if we're past 3 seconds.
      if (livePosition() > 3000) Spotify.seek(0);
      else if (!Spotify.prev()) return;
      emit({ anchorPos: 0, position: 0, anchorAt: performance.now() }, "optimistic");
      Actions.settle(900);
    },
    shuffle: function () {
      buzzer();
      var want = !State.shuffle;
      emit({ shuffle: want }, "optimistic");
      if (!Spotify.toggleShuffle()) emit({ shuffle: !want }, "rollback");
      this.settle(500);
    },
    repeat: function () {
      buzzer();
      var order = { off: "context", context: "track", track: "off" };
      var want = order[State.repeat] || "context";
      emit({ repeat: want }, "optimistic");
      if (!Spotify.cycleRepeat()) emit({ repeat: State.repeat }, "rollback");
      this.settle(500);
    },
    /** Ouvre un écran de Spotify depuis la barre de navigation supérieure. */
    spotifyButton: function (which) {
      var list = SPOTIFY_BUTTONS[which] || [];
      for (var i = 0; i < list.length; i++) {
        var el = $(list[i]);
        if (el && el.getClientRects().length) {
          try {
            el.click();
            return true;
          } catch (e) {
            /* on essaie le suivant */
          }
        }
      }
      Toast.show(Settings.labels.notAvailable, 2200);
      return false;
    },

    like: function () {
      buzzer();
      var want = !State.liked;
      emit({ liked: want }, "optimistic");
      if (!Spotify.toggleLike()) emit({ liked: !want }, "rollback");
      Bridge.mediaStatus(State);
      this.settle(1200);
    },
    seek: function (ms) {
      emit({ anchorPos: ms, position: ms, anchorAt: performance.now(), seeking: false }, "seek");
      // Spotify needs a moment to confirm; re-anchor from the DOM after that.
      if (!Spotify.seek(ms)) return;
      setTimeout(function () {
        var input = Spotify.progressInput();
        if (input) {
          var p = (parseFloat(input.value) || 0) * 1000;
          emit({ anchorPos: p, anchorAt: performance.now() }, "seek-confirm");
          Bridge.mediaPosition(p);
        }
      }, 400);
    },
    share: function () {
      /* Share the *real* track URL (the old layer shared the open.spotify.com
         home page, which made the feature useless). */
      var url = Spotify.trackHref();
      var copy = function () {
        try {
          navigator.clipboard.writeText(url);
          Toast.show(Settings.labels.copied);
        } catch (e) {
          Toast.show(url, 2600);
        }
      };
      if (navigator.share) {
        var p = null;
        try {
          p = navigator.share({ title: State.title, text: State.artist, url: url });
        } catch (e) {
          p = null; // not allowed (not a user gesture) → clipboard
        }
        if (p && typeof p.then === "function") {
          p.then(null, function () {
            /* cancelled — no need to shout about it */
          });
          return;
        }
        if (p) return;
      }
      copy();
    },
    openArtist: function () {
      var a = pick(SEL.artist);
      if (a && a.tagName === "A" && a.getAttribute("href")) location.assign(a.getAttribute("href"));
    },
    openAlbum: function () {
      var a = Spotify.albumLink();
      if (a && a.getAttribute("href")) location.assign(a.getAttribute("href"));
    },
  };
  function buzzer() {
    buzz(10);
  }

  /* ------------------------------------------------------------------ *
   * 11. Toast (tiny, replaces nothing but keeps feedback possible)
   * ------------------------------------------------------------------ */
  var Toast = {
    el: null,
    timer: 0,
    show: function (text, ms) {
      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "sd-toast";
        this.el.setAttribute("role", "status");
        UI.layer.appendChild(this.el);
      }
      this.el.textContent = text;
      this.el.classList.add("is-visible");
      clearTimeout(this.timer);
      var self = this;
      this.timer = setTimeout(function () {
        self.el.classList.remove("is-visible");
      }, ms || 1800);
    },
  };

  /* ------------------------------------------------------------------ *
   * 11b. Bottom sheets — the player's "…" menu and the settings screen
   *      Both are ours (the queue reuses Spotify's own panel), so they share
   *      one animation, one drag-to-dismiss and one back-button contract with
   *      the full player sheet.
   * ------------------------------------------------------------------ */
  var MENU = {
    queue: { icon: ICONS.queueLine, label: Settings.labels.queue, run: function () { Queue.openSheet(); } },
    lyrics: {
      icon: ICONS.lyricsLine,
      label: Settings.labels.lyrics,
      need: function () {
        return !!Spotify.lyricsButton();
      },
      run: function () {
        var b = Spotify.lyricsButton();
        if (b) b.click();
        else Toast.show(Settings.labels.lyricsUnavailable || Settings.labels.lyrics);
      },
    },
    devices: {
      icon: ICONS.deviceLine,
      label: Settings.labels.devices,
      need: function () {
        return !!Spotify.devicesButton();
      },
      run: function () {
        var b = Spotify.devicesButton();
        if (b) b.click();
      },
    },
    artist: {
      icon: ICONS.personLine,
      label: Settings.labels.viewArtist,
      need: function () {
        return !!pick(SEL.artist);
      },
      run: function () {
        Actions.openArtist();
      },
    },
    album: {
      icon: ICONS.discLine,
      label: Settings.labels.viewAlbum,
      need: function () {
        return !!Spotify.albumLink();
      },
      run: function () {
        Actions.openAlbum();
      },
    },
    share: { icon: ICONS.shareLine, label: Settings.labels.share, run: function () { Actions.share(); } },
    settings: { icon: ICONS.gearLine, label: Settings.labels.settings, run: function () { Sheets.open("settings"); } },
  };

  /* Factory defaults, used by the "reset" row. */
  var DEFAULTS = {
    theme: "auto",
    accentFromArt: true,
    reduceMotion: false,
    takeControl: true,
    resume: false,
    tabbar: true,
    haptics: true,
    /* Densité d'affichage : les télémétries Android et la WebView ne rendent
       pas la même chose sur tous les appareils — c'est le seul réglage qui
       touche à la taille de toute l'interface. */
    density: "normal",
  };

  /* ------------------------------------------------------------------ *
   * 10-bis. Viewport
   *
   * Le web player est un site « bureau » : il ne déclare aucun
   * `<meta name="viewport">`. Une WebView qui n'en trouve pas se donne une
   * largeur de mise en page de **980 px** — les media queries, les unités `vw`
   * et toutes les tailles de police de la couche visent alors un écran deux à
   * trois fois plus large que le téléphone : l'interface paraît énorme, coupée
   * sur la droite, et il faut la faire glisser pour atteindre les boutons.
   *
   * `document.documentElement.clientWidth` *est* cette largeur de mise en page
   * (pas `window.innerWidth`, que le mode bêta redéfinit). On pose donc le meta
   * nous-mêmes, et on le signale dans le diagnostic « Affichage » : si la
   * largeur de mise en page ne correspond pas à celle de l'écran, la ligne
   * l'écrit noir sur blanc.
   * ------------------------------------------------------------------ */
  var VIEWPORT_CONTENT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

  var Viewport = {
    /** Pose (ou corrige) le meta viewport. Idempotent, appelable à tout moment. */
    ensure: function () {
      var head = document.head || document.documentElement;
      if (!head) return false;
      var metas = $$('meta[name="viewport"]');
      var meta = metas[0];
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "viewport");
        head.appendChild(meta);
      }
      for (var i = 1; i < metas.length; i++) {
        if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
      }
      if (meta.getAttribute("content") !== VIEWPORT_CONTENT) {
        meta.setAttribute("content", VIEWPORT_CONTENT);
      }
      return true;
    },

    /** Largeur de mise en page réelle, et largeur de l'écran en pixels CSS. */
    measure: function () {
      var layout = document.documentElement.clientWidth || 0;
      var screenW = Math.round((window.screen && window.screen.width) || 0);
      var dpr = window.devicePixelRatio || 1;
      var device = screenW ? Math.round(screenW / dpr) : 0;
      return {
        layout: layout,
        screen: screenW,
        device: device, // pixels CSS : c'est ce que devrait valoir `layout`
        ok: !device || layout <= device * 1.25,
      };
    },
  };

  /**
   * Ce que la WebView voit réellement : c'est la seule façon de savoir
   * pourquoi un rendu diffère d'un appareil à l'autre (le réglage de taille
   * du système Android n'est pas transmis au CSS, donc on mesure).
   */
  function describeDisplay(withUA) {
    var d = document.documentElement;
    var cs = window.getComputedStyle(d);
    var u = parseFloat(cs.getPropertyValue("--sd-u")) || 1;
    var vp = Viewport.measure();
    var txt =
      d.clientWidth +
      "×" +
      d.clientHeight +
      " · " +
      (window.devicePixelRatio || 1).toFixed(2) +
      "× · " +
      Math.round(u * 100) +
      " %";
    if (!vp.ok) {
      txt += " · ⚠ mise en page " + vp.layout + "px pour un écran de " + vp.device + "px";
    }
    if (withUA) {
      txt +=
        " · innerWidth " +
        window.innerWidth +
        " · " +
        (navigator.userAgent || "").replace(/^Mozilla\/5\.0 /, "");
    }
    return txt;
  }

  /** Applique la densité choisie (classe sur <html>, tout le reste est en CSS). */
  function applyDensity(value) {
    var html = document.documentElement;
    html.classList.remove("sd-density-compact", "sd-density-normal", "sd-density-large");
    html.classList.add("sd-density-" + (value === "compact" || value === "large" ? value : "normal"));
  }

  /** Single entry point for every setting change (UI + public API). */
  function applySetting(key, value) {
    if (!(key in Settings) || typeof Settings[key] === "function") return false;
    Settings[key] = value;
    saveSettings();
    if (key === "theme") Theme.apply();
    if (key === "density") applyDensity(value);
    if (key === "reduceMotion") document.documentElement.classList.toggle("sd-reduce-motion", !!value);
    if (key === "tabbar") UI.paintChrome(State);
    UI.paint(State, "settings");
    Sheets.paint();
    return true;
  }

  var Sheets = {
    active: null, // "menu" | "settings"
    el: {},
    built: false,

    build: function () {
      if (this.built) return;
      var self = this;
      var frag = document.createDocumentFragment();

      ["menu", "settings"].forEach(function (name) {
        var s = self.mk("section", "sd-sheet sd-sheet-" + name);
        s.setAttribute("role", "dialog");
        s.setAttribute("aria-modal", "true");
        s.setAttribute("aria-hidden", "true");
        s.appendChild(
          self.mk(
            "div",
            "sd-sheet-head",
            '<span class="sd-sheet-title"></span>' +
              '<button class="sd-iconbtn sd-sheet-close" type="button" aria-label="' +
              Settings.labels.close +
              '">' +
              svg(ICONS.chevronDown) +
              "</button>"
          )
        );
        s.appendChild(self.mk("div", "sd-sheet-body"));
        $(".sd-sheet-title", s).textContent = name === "menu" ? Settings.labels.options : Settings.labels.settings;
        $(".sd-sheet-close", s).addEventListener("click", function () {
          self.close();
        });
        s.addEventListener("click", function (ev) {
          var sw = ev.target.closest("[data-switch]");
          if (sw) {
            var k = sw.getAttribute("data-switch");
            applySetting(k, !Settings[k]);
            buzz(8);
            return;
          }
          var segBtn = ev.target.closest(".sd-seg button");
          if (segBtn) {
            var seg = ev.target.closest("[data-seg]");
            applySetting(seg.getAttribute("data-seg"), segBtn.getAttribute("data-value"));
            buzz(8);
            return;
          }
          var row = ev.target.closest("[data-row]");
          if (!row || row.hasAttribute("disabled") || row.hidden) return;
          self.activate(row.getAttribute("data-row"));
        });
        self.drag(s);
        frag.appendChild(s);
        self.el[name] = s;
        self.el[name + "Body"] = $(".sd-sheet-body", s);
      });

      /* --- player "…" menu --- */
      Object.keys(MENU).forEach(function (id) {
        self.el.menuBody.appendChild(self.row(id, MENU[id].icon, MENU[id].label));
      });

      /* --- settings --- */
      self.el.settingsBody.appendChild(
        self.group(Settings.labels.groupLook, [
          self.segRow("theme", Settings.labels.theme, [
            ["auto", Settings.labels.themeAuto],
            ["dark", Settings.labels.themeDark],
            ["light", Settings.labels.themeLight],
          ]),
          self.switchRow("accentFromArt", Settings.labels.accent),
          self.segRow("density", Settings.labels.density, [
            ["compact", Settings.labels.densityCompact],
            ["normal", Settings.labels.densityNormal],
            ["large", Settings.labels.densityLarge],
          ]),
          self.switchRow("reduceMotion", Settings.labels.reduceMotion),
        ])
      );
      self.el.settingsBody.appendChild(
        self.group(Settings.labels.groupPlay, [
          self.switchRow("takeControl", Settings.labels.takeControl),
          self.switchRow("resume", Settings.labels.resume),
        ])
      );
      /* Bascule vers l'interface mobile de Spotify : le choix est natif (le
         user-agent change et la page se recharge), donc on délègue au pont
         Android au lieu d'essayer de le faire ici. */
      var nativeRow = self.actionRow("uimode", Settings.labels.nativeUi, ICONS.deviceLine);
      nativeRow.removeAttribute("data-row");
      nativeRow.setAttribute("title", Settings.labels.nativeUiHint);
      nativeRow.addEventListener("click", function () {
        if (!Bridge.call("showUiChooser")) {
          Toast.show(Settings.labels.nativeUiHint, 3200);
        }
      });
      self.el.settingsBody.appendChild(
        self.group(Settings.labels.groupUi, [
          nativeRow,
          self.switchRow("tabbar", Settings.labels.showTabbar),
          self.switchRow("haptics", Settings.labels.haptics),
        ])
      );
      self.el.settingsBody.appendChild(
        self.group(Settings.labels.groupAbout, [
          (self.el.diagRow = self.infoRow(Settings.labels.display, "")),
          self.infoRow(Settings.labels.version, VERSION),
          /* Play Protect refuse parfois l'installation d'un APK signé hors du
             Play Store, et le réglage qui le désactive est enterré dans le Play
             Store : cette ligne y mène directement. */
          self.actionRow("playprotect", Settings.labels.playProtect, ICONS.shieldLine),
          self.actionRow("reload", Settings.labels.reload, ICONS.refreshLine),
          self.actionRow("reset", Settings.labels.reset, ICONS.arrowUndo),
        ])
      );

      /* La ligne « Affichage » sert au diagnostic à distance : taille réellement
         vue par la WebView, densité de pixels et facteur appliqué. Un appui la
         copie — c'est ce que l'on demande quand un rendu diffère d'un appareil
         à l'autre. */
      this.el.diagValue = $(".sd-row-value", this.el.diagRow);
      this.el.diagRow.setAttribute("title", Settings.labels.displayHint);
      this.el.diagRow.addEventListener("click", function () {
        var txt = describeDisplay(true);
        try {
          navigator.clipboard.writeText(txt);
          Toast.show(Settings.labels.copied);
        } catch (e) {
          Toast.show(txt, 4000);
        }
      });

      UI.layer.appendChild(frag);
      this.built = true;
      Back.sync();
    },

    /* ---------------- tiny DOM builders ---------------- */
    mk: function (tag, cls, html) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (html != null) n.innerHTML = html;
      return n;
    },
    row: function (id, icon, label) {
      var b = this.mk(
        "button",
        "sd-row",
        '<span class="sd-row-icon">' +
          svg(icon || ICONS.chevronDown) +
          '</span><span class="sd-row-label">' +
          label +
          "</span>"
      );
      b.type = "button";
      b.setAttribute("data-row", id);
      return b;
    },
    actionRow: function (id, label, icon) {
      var b = this.row(id, icon, label);
      b.classList.add("sd-row-lead");
      return b;
    },
    infoRow: function (label, value) {
      var d = this.mk(
        "div",
        "sd-row sd-row-info",
        '<span class="sd-row-label">' + label + '</span><span class="sd-row-value">' + value + "</span>"
      );
      return d;
    },
    switchRow: function (key, label) {
      var b = this.mk(
        "button",
        "sd-row sd-row-switch",
        '<span class="sd-row-label">' +
          label +
          '</span><span class="sd-switch" aria-hidden="true"><i></i></span>'
      );
      b.type = "button";
      b.setAttribute("data-switch", key);
      b.setAttribute("role", "switch");
      b.setAttribute("aria-checked", "false");
      return b;
    },
    segRow: function (key, label, options) {
      var w = this.mk("div", "sd-row sd-row-seg", '<span class="sd-row-label">' + label + "</span>");
      w.setAttribute("data-seg", key);
      var seg = this.mk("div", "sd-seg");
      seg.setAttribute("role", "radiogroup");
      seg.setAttribute("aria-label", label);
      options.forEach(function (o) {
        var b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("data-value", o[0]);
        b.textContent = o[1];
        seg.appendChild(b);
      });
      w.appendChild(seg);
      return w;
    },
    group: function (title, rows) {
      var s = this.mk("section", "sd-group");
      var h = document.createElement("h2");
      h.textContent = title;
      s.appendChild(h);
      rows.forEach(function (r) {
        s.appendChild(r);
      });
      return s;
    },

    /* ---------------- behaviour ---------------- */
    open: function (name) {
      if (!this.built) return;
      if (this.active === name) {
        this.close();
        return;
      }
      this.close(false);
      this.active = name;
      var s = this.el[name];
      s.classList.add("is-open");
      s.setAttribute("aria-hidden", "false");
      document.documentElement.classList.add("sd-sheet-open");
      document.body.classList.add("sd-sheet-open");
      this.paint();
      Back.sync();
      buzz(8);
    },
    close: function (silent) {
      var name = this.active;
      if (name) {
        var s = this.el[name];
        s.classList.remove("is-open", "is-dragging");
        s.setAttribute("aria-hidden", "true");
        s.style.removeProperty("--sd-sheet-drag");
      }
      this.active = null;
      document.documentElement.classList.remove("sd-sheet-open");
      document.body.classList.remove("sd-sheet-open");
      if (name && silent !== false) Back.release();
    },
    activate: function (id) {
      if (id === "reload") {
        Toast.show(Settings.labels.reloadPlayer);
        Api.repair(true);
        return;
      }
      if (id === "reset") {
        Object.keys(DEFAULTS).forEach(function (k) {
          applySetting(k, DEFAULTS[k]);
        });
        Toast.show(Settings.labels.resetDone);
        return;
      }
      if (id === "playprotect") {
        Actions.playprotect();
        return;
      }
      var row = MENU[id];
      if (!row) return;
      /* Close first so the menu never sits on top of what it opened. */
      this.close();
      buzz(10);
      setTimeout(row.run, 180);
    },
    /** Re-evaluate row availability + control states. */
    paint: function () {
      if (!this.built) return;

      /* Diagnostic d'affichage : mesuré à chaque ouverture de la feuille. */
      if (this.el.diagValue) {
        var d = describeDisplay(false);
        if (this.el.diagValue.textContent !== d) this.el.diagValue.textContent = d;
      }

      var menu = this.el.menuBody;
      $$("[data-row]", menu).forEach(function (row) {
        var def = MENU[row.getAttribute("data-row")];
        row.hidden = !!(def && def.need && !def.need());
      });
      $$("[data-switch]", this.el.settingsBody).forEach(function (sw) {
        var on = !!Settings[sw.getAttribute("data-switch")];
        sw.setAttribute("aria-checked", on ? "true" : "false");
        sw.classList.toggle("is-on", on);
      });
      $$("[data-seg]", this.el.settingsBody).forEach(function (w) {
        var value = Settings[w.getAttribute("data-seg")];
        $$("button", w).forEach(function (b) {
          var on = b.getAttribute("data-value") === value;
          b.setAttribute("aria-checked", on ? "true" : "false");
          b.classList.toggle("is-on", on);
        });
      });
    },
    /** Swipe the header down to dismiss (same thresholds as the player). */
    drag: function (s) {
      var head = $(".sd-sheet-head", s);
      if (!head || !window.PointerEvent) return;
      var start = null;
      head.addEventListener("pointerdown", function (ev) {
        start = { y: ev.clientY, t: Date.now() };
        s.classList.add("is-dragging");
        try {
          head.setPointerCapture(ev.pointerId);
        } catch (e) {}
      });
      head.addEventListener("pointermove", function (ev) {
        if (!start) return;
        s.style.setProperty("--sd-sheet-drag", Math.max(0, ev.clientY - start.y) + "px");
      });
      var end = function (ev) {
        if (!start) return;
        var dy = Math.max(0, (ev.clientY || 0) - start.y);
        var speed = dy / Math.max(1, Date.now() - start.t);
        var h = s.getBoundingClientRect().height || 1;
        start = null;
        s.classList.remove("is-dragging");
        if (dy > h * 0.22 || speed > 0.8) {
          s.style.setProperty("--sd-sheet-drag", "100%");
          setTimeout(function () {
            s.style.removeProperty("--sd-sheet-drag");
          }, 300);
          Sheets.close();
        } else {
          s.style.removeProperty("--sd-sheet-drag");
        }
      };
      head.addEventListener("pointerup", end);
      head.addEventListener("pointercancel", end);
    },
  };

  /* ------------------------------------------------------------------ *
   * 11c. Back — the Android back button closes our panels first.
   *      Opening a panel pushes ONE history entry, so the WebView never
   *      leaves the app by accident (the old layer had no handling at all).
   * ------------------------------------------------------------------ */
  var Back = {
    pushed: false,
    top: function () {
      if (Sheets.active) return "sheet";
      if (Queue.open) return "queue";
      if (Player.open) return "player";
      return null;
    },
    sync: function () {
      if (this.top() && !this.pushed) {
        this.pushed = true;
        try {
          history.pushState({ sd: "panel" }, "");
        } catch (e) {}
      }
    },
    release: function () {
      if (!this.pushed) return;
      this.pushed = false;
      try {
        history.back();
      } catch (e) {}
    },
    /** Returns true when the press was consumed by us. */
    handle: function () {
      var t = this.top();
      if (!t) return false;
      this.pushed = false; // set first: close() must not pop twice
      if (t === "sheet") Sheets.close(false);
      else if (t === "queue") Queue.close();
      else Player.closeSheet();
      if (this.top()) this.sync(); // a sheet closed over the player → one more
      return true;
    },
  };
  window.addEventListener("popstate", function () {
    if (Back.pushed) Back.handle();
  });

  /* ------------------------------------------------------------------ *
   * 11d. Auto — playback hand-off, stuck-player recovery, screen wake
   *      (everything the native app did from a 5 s interval, event driven)
   * ------------------------------------------------------------------ */
  var Auto = {
    /* The user asked for playback through our UI (play/pause, next, a library
       tap…). Everything that "pushes" Spotify around is gated on this. */
    wantPlay: false,
    takeoverBusy: false,
    stuckTries: 0,
    selfPaused: false,
    resumeCount: 0,
    TAKEOVER_RE: /(couter sur cet appareil|listen on this device|prendre le contr|take control|transf[ée]rer|continuer la lecture)/i,

    start: function () {
      this.watch();
      this.wake();
      document.addEventListener("visibilitychange", function () {
        Auto.wake();
        if (document.visibilityState === "visible") {
          syncFromDom("visible");
          Login.apply();
        }
      });
      window.addEventListener("online", Offline.check);
      window.addEventListener("offline", Offline.check);
    },

    /* ---- "Écouter sur cet appareil" ---------------------------------- */
    /** Spotify only offers the transfer button when another device is
     *  playing; we watch the bar instead of polling it every 5 seconds. */
    watch: function () {
      if (!window.MutationObserver) return;
      var bar = pick(SEL.npBar);
      if (!bar) return;
      /* NB: never pass a method straight to `debounce` — it calls back with a
         null `this`, which is exactly how a bound-less module method breaks. */
      var obs = new MutationObserver(
        debounce(function () {
          Auto.maybeTakeover();
        }, 300)
      );
      obs.observe(bar, { childList: true, subtree: true });
      var panel = pick(SEL.panel);
      if (panel) obs.observe(panel, { childList: true, subtree: true });
    },
    takeoverButton: function () {
      for (var i = 0; i < SEL.takeover.length; i++) {
        var nodes = $$(SEL.takeover[i]);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (el.closest && el.closest(".sd-layer")) continue; // never ours
          var label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          if (this.TAKEOVER_RE.test(label)) return el;
        }
      }
      /* Last resort: when the bar has no track loaded at all, the only bright
         accent button of the bar is the transfer call-to-action. */
      if (!State.hasTrack) {
        var green = pick(['aside[data-testid="now-playing-bar"] div.encore-bright-accent-set button']);
        if (green) return green;
      }
      return null;
    },
    maybeTakeover: function () {
      if (!Settings.takeControl || this.takeoverBusy) return;
      /* Only ever take playback over when the user *asked* for playback from
         this UI (or enabled the auto-resume option). Clicking the prompt just
         because it appeared would steal playback from a speaker that is
         happily playing — the old layer's behaviour bug in reverse. */
      if (!this.wantPlay) return;
      var btn = this.takeoverButton();
      if (!btn) return;
      this.takeoverBusy = true;
      var self = this;
      try {
        btn.click();
      } catch (e) {
        /* the button may vanish between the observer callback and the click */
      }
      Toast.show(Settings.labels.takeover);
      buzz(12);
      /* Spotify then asks *which* device to hand playback to: click the first
         row of that list, exactly like the native app does. */
      setTimeout(function () {
        var row = pick(SEL.takeoverRows);
        if (row) {
          try {
            row.click();
          } catch (e) {}
        }
        self.takeoverBusy = false;
      }, 600);
      if (this.wantPlay) this.armStuck();
    },

    /* ---- stuck-player recovery --------------------------------------- */
    /** Spotify occasionally swallows the first play request. The old layer
     *  waited 10 s, told Android (`deferMessage('unlock')`) and skipped to the
     *  next track — same recovery, but never more than twice per request. */
    armStuck: function () {
      clearTimeout(this._stuck);
      this._stuck = setTimeout(function () {
        if (State.playing || !Auto.wantPlay || Auto.stuckTries >= 2) return;
        Auto.stuckTries++;
        Bridge.defer("unlock");
        Toast.show(Settings.labels.unlock);
        if (!Spotify.next()) Spotify.playPause();
      }, 10000);
    },

    /* ---- optional auto-resume ---------------------------------------- */
    maybeResume: function () {
      if (!Settings.resume || this.selfPaused || !State.hasTrack) return;
      if (document.visibilityState === "hidden" || this.resumeCount >= 3) return;
      this.resumeCount++;
      setTimeout(function () {
        if (!State.playing && Settings.resume && !Auto.selfPaused) Spotify.playPause();
      }, 600);
    },

    /* ---- screen wake lock for video/canvas playback ------------------ */
    wake: function () {
      if (!Bridge.has("wakeUp")) return;
      var video = $(".VideoPlayer__container video");
      try {
        if (State.playing && video && document.visibilityState === "hidden") Bridge.wakeUp();
        else if (document.visibilityState === "visible" && !video && Bridge.isWoke()) Bridge.wakeOff();
      } catch (e) {
        /* bridge hiccup — never break the UI over it */
      }
    },
  };

  /* ------------------------------------------------------------------ *
   * 11e. Login — mobile login page + "logged in" hand-off to Android
   * ------------------------------------------------------------------ */
  var Login = {
    done: false,
    apply: function () {
      var html = document.documentElement;
      var onLogin = !!pick(SEL.loginPage) || /\/login/.test(location.pathname);
      html.classList.toggle("sd-login", onLogin);
      /* Écran d'accueil : décidé à chaque passage, y compris quand on n'est
         ni sur la page de connexion ni dans l'application (page marketing). */
      Welcome.apply();
      if (!onLogin) {
        html.classList.remove("sd-login-classic", "sd-need-password");
        return;
      }
      /* The WebView's OAuth pop-ups are unreliable; offer the classic form
         (`?allow_password=1`) the way the native app does — but as a button
         inside OUR layer, never as a node inside Spotify's React tree. */
      var classic = !!$('form[data-testid="login-form"], #login-username');
      html.classList.toggle("sd-login-classic", classic);
      html.classList.toggle("sd-need-password", !classic && !/allow_password=1/.test(location.search));
      var wpl = pick(SEL.webPlayerLink);
      if (wpl && !this.done) {
        this.done = true;
        Bridge.call("loginDetected");
        html.classList.add("sd-login-done");
        try {
          wpl.click();
        } catch (e) {}
      }
    },
  };

  /* ------------------------------------------------------------------ *
   * 11e-bis. Welcome — écran d'accueil maison.
   *
   * Quand la session est déconnectée, open.spotify.com sert sa page
   * marketing desktop : sur un téléphone c'est illisible et ça ne ressemble
   * pas à une application. On affiche à la place un écran SpotiDuck sobre
   * (logo, texte, bouton) par-dessus, avec l'accès à la connexion classique
   * par e-mail/mot de passe.
   * ------------------------------------------------------------------ */
  var Welcome = {
    apply: function () {
      var html = document.documentElement;
      var login = html.classList.contains("sd-login");
      var app = !!(pick(SEL.mainView) || pick(SEL.npBar));
      var marketing = !!$('a[href^="/login"], a[href*="/login"]');
      var show = !app && (login || marketing);
      html.classList.toggle("sd-welcome-on", show);
      if (UI.el.welcome) UI.el.welcome.setAttribute("aria-hidden", show ? "false" : "true");
      return show;
    },
  };

  /* ------------------------------------------------------------------ *
   * 11f. Offline — banner + toast so silence never looks like a bug
   * ------------------------------------------------------------------ */
  var Offline = {
    check: function () {
      var off = navigator.onLine === false;
      document.documentElement.classList.toggle("sd-offline", off);
      if (off) Toast.show(Settings.labels.offline, 2600);
    },
  };

  /* ------------------------------------------------------------------ *
   * 11g. Api — observe (never rewrite) Spotify's own traffic.
   *      Gives us this device's id + tokens for the transfer hand-off, and
   *      turns a dead connect session into ONE reload instead of the loop
   *      the old layer created by reloading on every 404.
   * ------------------------------------------------------------------ */
  var Api = {
    devId: "",
    uri: "",
    clientToken: "",
    authToken: "",
    reloads: 0,
    lastReload: 0,
    patched: false,
    RE_DEVICES: /\/track-playback\/v1\/devices/,
    RE_CONNECT: /\/connect-state\/v1\/player\/(?:command|transfer)\/from\/([^/]+)\/to\/([^/?]+)/,

    watch: function () {
      if (this.patched || !window.fetch) return;
      this.patched = true;
      var orig = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        try {
          Api.capture(url, init);
        } catch (e) {}
        var p = orig.apply(this, arguments);
        try {
          if (Api.RE_DEVICES.test(url) || Api.RE_CONNECT.test(url)) {
            p.then(
              function (res) {
                if (res && res.status === 404) Api.onGone();
                if (!res || !res.clone) return;
                res.clone().json().then(
                  function (data) {
                    Api.consume(url, data);
                  },
                  function () {}
                );
              },
              function () {}
            );
          }
        } catch (e) {}
        return p;
      };
    },
    header: function (h, name) {
      if (!h) return "";
      try {
        if (typeof h.get === "function") return h.get(name) || "";
        if (Object.prototype.toString.call(h) === "[object Array]") {
          for (var i = 0; i < h.length; i++) {
            if (String(h[i][0]).toLowerCase() === name.toLowerCase()) return h[i][1] || "";
          }
          return "";
        }
        for (var k in h) {
          if (k.toLowerCase() === name.toLowerCase()) return h[k] || "";
        }
      } catch (e) {}
      return "";
    },
    capture: function (url, init) {
      var h = init && init.headers;
      var ct = this.header(h, "Client-Token");
      if (ct && ct !== this.clientToken) this.clientToken = ct;
      var at = this.header(h, "Authorization");
      if (at && at !== this.authToken) this.authToken = at;
      var m = this.RE_CONNECT.exec(url);
      if (m && m[2]) {
        this.devId = m[2];
        this.uri = m[1];
      }
    },
    consume: function (url, data) {
      if (!data || typeof data !== "object") return;
      if (this.RE_DEVICES.test(url)) {
        var id = data.device_id || data.deviceId || "";
        if (id) this.devId = id;
      }
      if (data.player_state && data.player_state.device && data.player_state.device.id) {
        this.devId = data.player_state.device.id;
      }
    },
    onGone: function () {
      if (!Auto.wantPlay) return;
      var now = Date.now();
      if (this.reloads >= 3 || now - this.lastReload < 300000) {
        Toast.show(Settings.labels.sessionLost, 3000);
        return;
      }
      this.reloads++;
      this.lastReload = now;
      Toast.show(Settings.labels.reloadPlayer);
      setTimeout(function () {
        Api.repair(false);
      }, 1400);
    },
    repair: function (manual) {
      var now = Date.now();
      if (manual && now - this.lastReload < 60000) return;
      this.lastReload = now;
      this.reloads++;
      try {
        location.reload();
      } catch (e) {}
    },
  };

  /* ------------------------------------------------------------------ *
   * 12. Player sheet
   * ------------------------------------------------------------------ */
  var Player = {
    open: false,
    openSheet: function () {
      if (this.open) return;
      this.open = true;
      document.documentElement.classList.add("sd-player-open");
      UI.el.player.setAttribute("aria-hidden", "false");
      UI.paintChrome(State);
      Back.sync();
      buzz(8);
      var img = UI.el.artImg;
      if (img) {
        img.style.transition = "none";
        img.style.transform = "scale(0.92)";
        requestAnimationFrame(function () {
          img.style.transition = "transform 320ms cubic-bezier(.32,.72,0,1)";
          img.style.transform = "";
        });
      }
    },
    closeSheet: function () {
      if (!this.open) return;
      this.open = false;
      document.documentElement.classList.remove("sd-player-open");
      UI.el.player.setAttribute("aria-hidden", "true");
      UI.el.player.style.removeProperty("--sd-drag");
      UI.el.player.classList.remove("is-settling");
      Sheets.close(false); // the options sheet never outlives the player
      UI.paintChrome(State);
      Back.release();
      buzz(4);
    },
  };

  /* ------------------------------------------------------------------ *
   * 13. Queue sheet (Spotify's own "file d'attente" panel, shown on top of
   *     the mini player — no re-implementation, so it can never desync)
   * ------------------------------------------------------------------ */
  var Queue = {
    open: false,
    toggle: function () {
      this.open ? this.close() : this.openSheet();
    },
    openSheet: function () {
      var panel = pick(SEL.panel);
      if (!panel) {
        var q = Spotify.queueButton();
        if (q) q.click();
        return;
      }
      this.open = true;
      UI.paintChrome(State);
      Back.sync();
      buzz(6);
    },
    close: function () {
      if (!this.open) return;
      this.open = false;
      UI.paintChrome(State);
      Back.release();
    },
  };

  /* ------------------------------------------------------------------ *
   * 14. Router — tab bar ↔ web player pages
   * ------------------------------------------------------------------ */
  var Router = {
    tab: function (name) {
      if (name === State.tab && name !== "library") {
        if (name === "search") Spotify.focusSearch();
        return;
      }
      emit({ tab: name }, "route");
      if (name === "home") {
        Spotify.goHome();
        UI.el.tabbar.classList.remove("is-library");
      } else if (name === "search") {
        Spotify.goSearch();
        setTimeout(function () {
          Spotify.focusSearch();
        }, 350);
      }
      // 'library' needs no navigation: it is Spotify's own sidebar, shown
      // full-screen by CSS (§3 of the stylesheet).
      Queue.close();
      buzz(8);
    },
    /** Called when the web player navigates on its own (link taps…). */
    sync: function () {
      var route = Spotify.route();
      var patch = { route: route };
      if (route === "home" && State.tab !== "library" && State.tab !== "search") patch.tab = "home";
      if (route === "search") patch.tab = "search";
      emit(patch, "route-sync");
    },
  };

  /** Count internal navigations so `goBack()` never leaves the app. */
  var History = {
    depth: 0,
    install: function () {
      if (this.installed) return;
      this.installed = true;
      ["pushState", "replaceState"].forEach(function (m) {
        var orig = history[m];
        history[m] = function (state) {
          /* Our own panel entries (`{sd:'panel'}`, pushed by Back) must not
             count as internal navigation, or `goBack()` would just re-open
             the sheet it is supposed to close. */
          if (m === "pushState" && !(state && state.sd)) History.depth++;
          return orig.apply(this, arguments);
        };
      });
      window.addEventListener("popstate", function () {
        if (History.depth > 0) History.depth--;
      });
    },
  };

  /* ------------------------------------------------------------------ *
   * 15. Gestures — swipe on the mini player, drag the sheet, scrub
   * ------------------------------------------------------------------ */
  var Gestures = {
    bind: function () {
      this.miniSwipe();
      this.sheetDrag();
      this.seekDrag();
      this.miniSeekDrag();
    },
    /* Barre de progression du mini-lecteur : on peut y poser le doigt pour se
       déplacer dans le morceau sans ouvrir le lecteur plein écran. */
    miniSeekDrag: function () {
      var rail = UI.el.miniSeek;
      var fill = UI.el.miniProgress;
      var cur = UI.el.miniCur;
      if (!rail) return;
      var dragging = false;
      function ratioFrom(ev) {
        var r = rail.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
      }
      function preview(ratio) {
        var ms = ratio * (State.duration || 0);
        State.seekPreview = ms;
        fill.style.width = (ratio * 100).toFixed(2) + "%";
        if (cur) cur.textContent = fmtTime(ms);
      }
      rail.addEventListener("pointerdown", function (ev) {
        if (!State.duration) return;
        ev.stopPropagation(); // ne pas ouvrir le lecteur plein écran
        dragging = true;
        emit({ seeking: true }, "mini-seek-start");
        rail.classList.add("is-dragging");
        try {
          rail.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* WebViews plus anciennes */
        }
        preview(ratioFrom(ev));
      });
      rail.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        ev.stopPropagation();
        preview(ratioFrom(ev));
      });
      var end = function (ev) {
        if (!dragging) return;
        dragging = false;
        rail.classList.remove("is-dragging");
        Actions.seek(ratioFrom(ev) * (State.duration || 0));
        buzz(8);
      };
      rail.addEventListener("pointerup", end);
      rail.addEventListener("pointercancel", end);
      /* Un simple appui sur la barre ne doit pas ouvrir la feuille. */
      ["click", "pointerdown", "pointerup"].forEach(function (type) {
        rail.addEventListener(type, function (ev) {
          ev.stopPropagation();
        });
      });
    },

    /* mini player: tap → open, swipe ← → next, swipe → → previous, swipe ↑ → open */
    miniSwipe: function () {
      var el = UI.el.mini;
      var start = null;
      el.addEventListener(
        "pointerdown",
        function (ev) {
          if (ev.target.closest(".sd-iconbtn")) return;
          start = { x: ev.clientX, y: ev.clientY, t: Date.now() };
          el.classList.add("is-dragging");
        },
        { passive: true }
      );
      el.addEventListener(
        "pointermove",
        function (ev) {
          if (!start) return;
          var dx = ev.clientX - start.x;
          var dy = ev.clientY - start.y;
          if (dy < -8 && Math.abs(dy) > Math.abs(dx)) {
            el.style.transform = "translate3d(0," + Math.max(dy, -40) + "px,0)";
          } else if (Math.abs(dx) > 8) {
            el.style.transform = "translate3d(" + clamp(dx, -60, 60) + "px,0,0)";
          }
        },
        { passive: true }
      );
      var finish = function (ev) {
        if (!start) return;
        var dx = ev.clientX - start.x;
        var dy = ev.clientY - start.y;
        var dt = Date.now() - start.t;
        start = null;
        el.classList.remove("is-dragging");
        el.style.transform = "";
        var min = Math.max(48, viewW() * 0.18);
        if (dy < -32 && Math.abs(dy) > Math.abs(dx)) {
          Player.openSheet();
        } else if (dx < -min && dt < 600) {
          Actions.next();
        } else if (dx > min && dt < 600) {
          Actions.prev();
        }
        // a plain tap is handled by the click listener
      };
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);
    },
    /* full player: drag the header/artwork down to dismiss */
    sheetDrag: function () {
      var sheet = UI.el.player;
      var zones = [UI.el.player.firstChild, UI.el.art];
      var start = null;
      var self = this;
      zones.forEach(function (zone) {
        if (!zone) return;
        zone.addEventListener(
          "pointerdown",
          function (ev) {
            if (ev.target.closest("button")) return;
            start = { y: ev.clientY, t: Date.now() };
            sheet.style.transition = "none";
            sheet.classList.add("is-dragging");
          },
          { passive: true }
        );
        zone.addEventListener(
          "pointermove",
          function (ev) {
            if (!start) return;
            var dy = Math.max(0, ev.clientY - start.y);
            sheet.style.setProperty("--sd-drag", dy + "px");
          },
          { passive: true }
        );
        var end = function (ev) {
          if (!start) return;
          var dy = Math.max(0, ev.clientY - start.y);
          var dt = Date.now() - start.t;
          var velocity = dy / Math.max(1, dt);
          start = null;
          sheet.classList.remove("is-dragging");
          var shouldClose = dy > viewH() * 0.22 || velocity > 0.8;
          // The inline `transition: none` set on pointerdown must be cleared in
          // BOTH branches, otherwise the snap-back is an instant jump.
          sheet.style.transition = "";
          sheet.style.removeProperty("--sd-drag");
          if (shouldClose) {
            Player.closeSheet();
          } else {
            sheet.classList.add("is-settling");
            setTimeout(function () {
              sheet.classList.remove("is-settling");
            }, 340);
          }
        };
        zone.addEventListener("pointerup", end);
        zone.addEventListener("pointercancel", end);
      });
    },
    /* seek bar: real touch scrubbing (the old layer had none — it only sent
       a synthetic `change` on the desktop <input type=range> from Android) */
    seekDrag: function () {
      var rail = UI.el.seekRail;
      var seek = UI.el.seek;
      var dragging = false;
      function ratioFrom(ev) {
        var r = rail.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
      }
      function preview(ratio) {
        var ms = ratio * (State.duration || 0);
        State.seekPreview = ms;
        UI.el.seekFill.style.width = (ratio * 100).toFixed(2) + "%";
        UI.el.seekThumb.style.left = (ratio * 100).toFixed(2) + "%";
        UI.el.tCur.textContent = fmtTime(ms);
      }
      rail.addEventListener("pointerdown", function (ev) {
        if (!State.duration) return;
        dragging = true;
        emit({ seeking: true }, "seek-start");
        seek.classList.add("is-dragging");
        try {
          rail.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* older WebViews */
        }
        preview(ratioFrom(ev));
      });
      rail.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        preview(ratioFrom(ev));
      });
      var end = function (ev) {
        if (!dragging) return;
        dragging = false;
        seek.classList.remove("is-dragging");
        var ratio = ratioFrom(ev);
        Actions.seek(ratio * (State.duration || 0));
        buzz(8);
      };
      rail.addEventListener("pointerup", end);
      rail.addEventListener("pointercancel", end);
      /* keyboard support (the layer is also usable with a remote/TV remote) */
      seek.addEventListener("keydown", function (ev) {
        var step = ev.shiftKey ? 30000 : 5000;
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          Actions.seek(livePosition() + step);
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          Actions.seek(Math.max(0, livePosition() - step));
        }
      });
    },
  };

  /* ------------------------------------------------------------------ *
   * 15b. Interface hardening (every rule of src/inject/40-audit.css needs
   *      one of these three states/classes to be meaningful).
   * ------------------------------------------------------------------ */
  var Polish = {
    started: false,
    overlayOpen: false,

    /** Native overlays our chrome has to step back for. */
    OVERLAYS: [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[data-testid="modal"]',
      '[data-testid="modal-container"]',
      '[data-testid="context-menu"]',
      "#context-menu",
    ],

    start: function () {
      if (this.started) return;
      this.started = true;
      this.watchOverlays();
      this.watchKeyboard();
      this.purgePopups();
      this.labelPass();
      /* The SPA swaps whole views: re-scan once the dust settles. */
      onState(
        debounce(function () {
          Polish.purgePopups();
          Polish.labelPass();
        }, 500)
      );
    },

    /**
     * Bannières de consentement (OneTrust, ce que Spotify utilise sur le web) :
     * elles s'affichent par-dessus notre mini-player et posent
     * `overflow:hidden` sur `<body>`, ce qui bloque le défilement de la page
     * tant qu'on n'a pas cliqué « Accepter ». Et comme le web player est en
     * mode « bureau », la bannière est énorme. On la retire du DOM plutôt que
     * de cliquer à la place de l'utilisateur.
     */
    PURGE: [
      "#onetrust-consent-sdk",
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      "[id^=\"onetrust\"]",
      "[class*=\"onetrust\"]",
      ".optanon-alert-box-wrapper",
      '[data-testid="cookie-banner"]',
      '[data-testid="consent-banner"]',
    ],

    purgePopups: function () {
      var removed = 0;
      for (var i = 0; i < this.PURGE.length; i++) {
        var nodes = document.querySelectorAll(this.PURGE[i]);
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.parentNode) {
            node.parentNode.removeChild(node);
            removed++;
          }
        }
      }
      /* Un vrai dialogue est *visible* : ne pas toucher au verrou de défilement.
         (`querySelector` seul tombait sur les dialogues présents dans le DOM
         mais fermés, et le verrou restait alors en place.) */
      var dialogs = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
      for (var k = 0; k < dialogs.length; k++) {
        if (dialogs[k].getClientRects && dialogs[k].getClientRects().length) return removed;
      }
      var body = document.body;
      if (body && body.style && body.style.overflow === "hidden") body.style.overflow = "";
      var html = document.documentElement;
      if (html && html.style && html.style.overflow === "hidden") html.style.overflow = "";
      return removed;
    },

    /** 1) Native dialog/menu open → `html.sd-native-modal` (our bars fade and
     *  stop taking taps so nothing hides behind the mini player). */
    watchOverlays: function () {
      var self = this;
      if (!window.MutationObserver || !document.body) return;
      var check = debounce(function () {
        self.purgePopups();
        self.syncOverlay();
      }, 120);
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
      ["pointerup", "keyup"].forEach(function (ev) {
        document.addEventListener(ev, check, { passive: true });
      });
    },

    syncOverlay: function () {
      var open = false;
      for (var i = 0; i < this.OVERLAYS.length && !open; i++) {
        var found = document.querySelectorAll(this.OVERLAYS[i]);
        for (var j = 0; j < found.length; j++) {
          /* Our own player and sheets are dialogs too — never treat them as a
             native overlay, or the shell would hide itself on open. */
          if (found[j].closest(".sd-layer")) continue;
          open = true;
          break;
        }
      }
      if (open === this.overlayOpen) return;
      this.overlayOpen = open;
      document.documentElement.classList.toggle("sd-native-modal", open);
    },

    /** 2) Software keyboard → `html.sd-keyboard` hides the tab bar + mini so
     *  the search field and its results stay reachable. Deliberately based on
     *  `clientHeight`: the Android wrapper may fake `window.innerHeight`. */
    watchKeyboard: function () {
      var vv = window.visualViewport;
      /* Ce qui faisait « disparaître les boutons du bas de temps en temps » :
         la classe `sd-keyboard` se posait dès que la zone visible rétrécissait
         de plus de 120 px, sans vérifier qu'un clavier était ouvert. Or un
         redimensionnement, une rotation, l'apparition de la barre de
         navigation système ou le passage d'un onglet à l'autre peuvent faire
         exactement ça — la barre d'onglets et le mini-lecteur s'effaçaient
         alors que rien ne gênait. On ne masque donc plus que si un champ de
         saisie est réellement focalisé. */
      var typing = function () {
        var el = document.activeElement;
        if (!el) return false;
        var tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
      };
      var apply = function () {
        var gap = vv ? (document.documentElement.clientHeight || 0) - vv.height : 0;
        document.documentElement.classList.toggle("sd-keyboard", typing() && gap > 120);
      };
      if (vv) {
        vv.addEventListener("resize", apply);
        vv.addEventListener("scroll", apply);
      }
      /* Le clavier suit le focus : c'est le signal le plus fiable, et il
         fonctionne même sans `visualViewport`. */
      document.addEventListener("focusin", apply, true);
      document.addEventListener(
        "focusout",
        function () {
          setTimeout(apply, 120);
        },
        true
      );
      window.addEventListener("orientationchange", apply);
      window.addEventListener("resize", apply);
      apply();
    },

    /** 3) Name + size pass over Spotify's own controls: icon buttons get a
     *  `title` tooltip when they only have an `aria-label`, and any control
     *  smaller than a fingertip is flagged `data-sd-hit` for the CSS to grow.
     *  Read-mostly, capped, and skipped inside our own layer. */
    labelPass: function () {
      var nodes;
      try {
        nodes = document.querySelectorAll('button, [role="button"]');
      } catch (e) {
        return;
      }
      var budget = 300;
      for (var i = 0; i < nodes.length && budget > 0; i++, budget--) {
        var el = nodes[i];
        if (el.closest && el.closest(".sd-layer")) continue;
        var label = el.getAttribute("aria-label");
        if (label && !el.hasAttribute("title")) el.setAttribute("title", label);
        if (el.hasAttribute("data-sd-hit")) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40)) {
          el.setAttribute("data-sd-hit", "1");
        }
      }
    },
  };

  /* ------------------------------------------------------------------ *
   * 16. Theme detection (follow Spotify's own palette)
   * ------------------------------------------------------------------ */
  var Theme = {
    apply: function () {
      var light = false;
      if (Settings.theme === "light") light = true;
      else if (Settings.theme === "auto") {
        light = !!(
          document.querySelector(".encore-light-theme") ||
          (getComputedStyle(document.body).backgroundColor || "").match(/rgba?\(2[0-9]{2}/)
        );
      }
      document.documentElement.classList.toggle("sd-theme-light", light);
    },
  };

  /* ------------------------------------------------------------------ *
   * 17. Boot
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = typeof SD_CSS_SOURCES !== "undefined" ? SD_CSS_SOURCES : "";
    if (!css) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function markBody() {
    var html = document.documentElement;
    html.classList.add(BODY_CLASS);
    html.classList.add("sd-tab-home");
    html.classList.toggle("sd-reduce-motion", !!Settings.reduceMotion);
    /* `sd-root` marks Spotify's own markup (everything in <body> that is not
       our layer): the hardening stylesheet scopes its native-DOM rules on it,
       so they can never leak into the injected UI. */
    document.body.classList.add("sd-root");
    Theme.apply();
  }

  var bootTries = 0;
  function boot() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    /* Le meta viewport AVANT les styles et la coque : toutes les tailles de la
       feuille sont calculées à partir de la largeur de mise en page. */
    Viewport.ensure();
    injectStyles();
    markBody();

    /* La coque d'abord, toujours : barre d'onglets, mini-lecteur, feuilles,
       écran d'accueil. C'est ce qui fait qu'un premier lancement ressemble à
       une application Android et non à la page web desktop de Spotify — la
       version précédente attendait le lecteur pour construire quoi que ce
       soit, donc l'écran de connexion restait une page web. */
    startShell();

    if (Spotify.ready()) {
      startPlayer();
      return;
    }
    // Le web player démarre encore (splash, connexion…). On réessaie avec un
    // délai progressif, plafonné, au lieu d'une boucle toutes les 500 ms.
    if (bootTries++ < 60) {
      setTimeout(boot, Math.min(1500, 250 + bootTries * 150));
    }
  }

  /* Coque : tout ce qui ne dépend pas de la lecture. */
  var shellReady = false;
  function startShell() {
    if (shellReady) return;
    shellReady = true;

    UI.build();
    History.install();
    Api.watch();
    Polish.start();
    Login.apply();
    Offline.check();
    Sheets.paint();
    Router.sync();
    UI.paintChrome(State);

    /* Spotify is a single-page app: watch the main view for page changes and
       re-sync the route + chrome. One observer, no polling. */
    var main = pick(SEL.mainView);
    if (main && window.MutationObserver) {
      var pageObs = new MutationObserver(debounce(function () {
        Router.sync();
        syncFromDom("page");
        UI.paintChrome(State);
        Login.apply(); // the login page is rendered by the same container
      }, 250));
      pageObs.observe(main, { childList: true, subtree: false });
    }

    /* L'écran marketing / la page de connexion n'ont pas de #main-view : on
       surveille le body pour l'écran d'accueil maison. */
    if (window.MutationObserver) {
      var welcomeObs = new MutationObserver(
        debounce(function () {
          Welcome.apply();
        }, 300)
      );
      welcomeObs.observe(document.body, { childList: true, subtree: false });
    }

    /* Re-apply the theme + repaint after a rotation or a keyboard resize.
       (Everything else adapts through CSS: the shell is sized in `vh`/`%` so
       no JS measurement is needed.) */
    window.addEventListener(
      "resize",
      debounce(function () {
        Theme.apply();
        UI.paintProgress();
        Welcome.apply();
      }, 200)
    );

    Bridge.uiReady();
    Actions.syncLocks();
  }

  /* Lecteur : ce qui n'a de sens qu'une fois la barre de lecture présente. */
  var playerReady = false;
  function startPlayer() {
    if (playerReady) return;
    playerReady = true;

    Mirror.start();
    Ticker.start();
    Auto.start();
    syncFromDom("boot");
    UI.paintChrome(State);

    Bridge.playLoaded();
    Bridge.mediaStatus(State);
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

  /* ------------------------------------------------------------------ *
   * 18. Public API (namespace handle the app / debug console can use)
   * ------------------------------------------------------------------ */
  var lastPlaying = null;
  onState(function (s, reason) {
    /* Playback can also change from outside the UI (notification, widget,
     * Android Auto): keep the native wake/sleep state in sync with it. */
    if (s.playing !== lastPlaying) {
      var wasPlaying = lastPlaying;
      lastPlaying = s.playing;
      Actions.syncLocks();
      /* Optional (settings → "Relancer la lecture automatiquement"): the old
         layer's "permanent autoplay". Only for pauses we did not ask for. */
      if (!s.playing && wasPlaying && reason !== "optimistic") Auto.maybeResume();
    }
    UI.paint(s, reason);
    if (reason === "route" || reason === "route-sync") Login.apply();
  });

  window.SpotiDuckUI = {
    version: VERSION,
    state: State,
    settings: Settings,
    /** Change one setting (`theme`, `haptics`, `accentFromArt`, `tabbar`,
     *  `takeControl`, `resume`, `reduceMotion`) and persist it. */
    set: function (key, value) {
      return applySetting(key, value);
    },
    openPlayer: function () {
      Player.openSheet();
    },
    /* ---- playback API for the native side (notification, widget, Android
       Auto, assistant). All of them are idempotent: calling `play()` while
       already playing does nothing instead of toggling (a toggle racing with
       the notification is how you get "the pause button plays music"). */
    play: function () {
      if (!State.playing) Actions.playPause();
    },
    pause: function () {
      if (State.playing) Actions.playPause();
    },
    playPause: function () {
      Actions.playPause();
    },
    next: function () {
      Actions.next();
    },
    previous: function () {
      Actions.prev();
    },
    like: function () {
      Actions.like();
    },
    seek: function (ms) {
      Actions.seek(Math.max(0, Number(ms) || 0));
    },
    closePlayer: function () {
      Player.closeSheet();
    },
    openQueue: function () {
      Queue.openSheet();
    },
    openMenu: function () {
      Sheets.open("menu");
    },
    /** Barre de navigation supérieure : notifications, amis, profil. */
    spotifyButton: function (which) {
      return Actions.spotifyButton(which);
    },
    openSettings: function () {
      Sheets.open("settings");
    },
    close: function () {
      Sheets.close();
    },
    /**
     * Hardware back button. Call this from `onBackPressed` (via
     * `evaluateJavascript`) — returns `true` when the UI consumed the press
     * (a panel was closed), `false` when the app should handle it itself.
     */
    back: function () {
      if (Back.top()) {
        Back.handle();
        return true;
      }
      if (State.route === "page") {
        Spotify.goBack();
        return true;
      }
      if (State.tab !== "home") {
        Router.tab("home");
        return true;
      }
      return false;
    },
    /** "Impossible de lancer la lecture ?" escape hatch (settings → reload). */
    reload: function () {
      Api.repair(true);
    },
    sync: function () {
      syncFromDom("manual");
    },
    /* exposed for tests / the demo harness */
    _internals: {
      Spotify: Spotify,
      Bridge: Bridge,
      Actions: Actions,
      UI: UI,
      Router: Router,
      Sheets: Sheets,
      Player: Player,
      Queue: Queue,
      Auto: Auto,
      Api: Api,
      Login: Login,
      Offline: Offline,
      Polish: Polish,
      Back: Back,
      Viewport: Viewport,
      Icons: ICONS,
    },
  };

  loadSettings();
  applyDensity(Settings.density);
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
