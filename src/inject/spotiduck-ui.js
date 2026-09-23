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

  var VERSION = "2.0.0";
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
    theme: "auto", // auto | dark | light
    haptics: true,
    accentFromArt: true, // colour the player with the cover art
    tabbar: true, // can be turned off if the ROM draws its own bar
    labels: {
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
      shuffle: "Lecture aléatoire",
      repeat: "Répéter",
      nowPlaying: "Lecture en cours",
      noTrack: "Aucun titre en lecture",
      volume: "Volume",
      close: "Fermer",
      queueEmpty: "La file d'attente est vide",
    },
  };

  function loadSettings() {
    try {
      var raw = localStorage.getItem("sd.ui.settings");
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === "object") {
        if (o.theme) Settings.theme = o.theme;
        if (typeof o.haptics === "boolean") Settings.haptics = o.haptics;
        if (typeof o.accentFromArt === "boolean") Settings.accentFromArt = o.accentFromArt;
        if (typeof o.tabbar === "boolean") Settings.tabbar = o.tabbar;
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
    start: function () {
      var bar = pick(SEL.npBar);
      if (!bar) return false;
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
        '<button class="sd-iconbtn sd-topbar-close" type="button" aria-label="' +
        Settings.labels.close +
        '">' +
        svg(ICONS.chevronDown) +
        "</button>";

      /* ---- mini player ---- */
      var mini = document.createElement("div");
      mini.className = "sd-mini";
      mini.setAttribute("role", "button");
      mini.setAttribute("tabindex", "0");
      mini.setAttribute("aria-label", Settings.labels.nowPlaying);
      mini.innerHTML =
        '<div class="sd-mini-art"><img alt="" decoding="async"></div>' +
        '<div class="sd-mini-meta">' +
        '<span class="sd-mini-title"></span>' +
        '<span class="sd-mini-artist"></span>' +
        "</div>" +
        '<div class="sd-mini-controls">' +
        '<button class="sd-iconbtn sd-mini-like" type="button">' +
        svg(ICONS.heartLine, "sd-icon-line") +
        svg(ICONS.heartSolid, "sd-icon-solid") +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-play" type="button"></button>' +
        '<button class="sd-iconbtn sd-mini-next" type="button" aria-label="' +
        Settings.labels.next +
        '">' +
        svg(ICONS.next) +
        "</button>" +
        "</div>" +
        '<div class="sd-mini-progress"><i></i></div>';

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

      /* ---- queue sheet scrim + grabber ---- */
      var scrim = document.createElement("div");
      scrim.className = "sd-scrim";
      var grabber = document.createElement("div");
      grabber.className = "sd-sheet-grabber";

      L.appendChild(topbar);
      L.appendChild(mini);
      L.appendChild(tabbar);
      L.appendChild(scrim);
      L.appendChild(grabber);
      L.appendChild(player);
      document.body.appendChild(L);

      this.layer = L;
      this.el = {
        topbar: topbar,
        topbarBack: $(".sd-back", topbar),
        topbarTitle: $(".sd-topbar-title", topbar),
        topbarClose: $(".sd-topbar-close", topbar),
        mini: mini,
        miniImg: $(".sd-mini-art img", mini),
        miniTitle: $(".sd-mini-title", mini),
        miniArtist: $(".sd-mini-artist", mini),
        miniLike: $(".sd-mini-like", mini),
        miniPlay: $(".sd-mini-play", mini),
        miniNext: $(".sd-mini-next", mini),
        miniProgress: $(".sd-mini-progress > i", mini),
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

      /* shuffle / repeat */
      toggle(e.shuffle, "is-active", !!s.shuffle);
      e.shuffle.setAttribute("aria-checked", s.shuffle ? "true" : "false");
      toggle(e.repeat, "is-active", s.repeat !== "off");
      toggle(e.repeat, "is-one", s.repeat === "track");
      e.repeat.setAttribute("aria-checked", s.repeat === "off" ? "false" : s.repeat === "track" ? "mixed" : "true");

      /* disable what the web player cannot do here */
      e.lyrics.hidden = !Spotify.lyricsButton();
      e.device.hidden = !Spotify.devicesButton();
      e.queue.hidden = !Spotify.queueButton() && !$("#Desktop_PanelContainer_Id");

      /* duration */
      e.tDur.textContent = fmtTime(s.duration);
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

      /* tab bar */
      e.tabbar.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".sd-tab");
        if (!btn) return;
        Router.tab(btn.getAttribute("data-tab"));
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
      e.playerMenu.addEventListener("click", function () {
        Queue.toggle();
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
        Queue.close();
      });

      /* keyboard */
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          if (Queue.open) Queue.close();
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
  var Actions = {
    settle: function (delay) {
      clearTimeout(Actions._t);
      Actions._t = setTimeout(function () {
        syncFromDom("settle");
      }, delay || 700);
    },
    playPause: function () {
      var want = !State.playing;
      emit({ playing: want }, "optimistic");
      buzz(8);
      if (!Spotify.playPause()) emit({ playing: !want }, "rollback");
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
      if (!Spotify.next()) return;
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
      var url = "https://open.spotify.com/";
      if (navigator.share) {
        try {
          navigator.share({ title: State.title, text: State.artist, url: url });
          return;
        } catch (e) {
          /* user cancelled / not allowed */
        }
      }
      try {
        navigator.clipboard.writeText(url);
        Toast.show("Lien copié");
      } catch (e) {
        /* clipboard unavailable */
      }
    },
    openArtist: function () {
      var a = pick(SEL.artist);
      if (a && a.tagName === "A" && a.href) location.assign(a.getAttribute("href"));
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
      UI.paintChrome(State);
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
    },
    close: function () {
      if (!this.open) return;
      this.open = false;
      UI.paintChrome(State);
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
      ["pushState", "replaceState"].forEach(function (m) {
        var orig = history[m];
        history[m] = function () {
          if (m === "pushState") History.depth++;
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
    Theme.apply();
  }

  var bootTries = 0;
  function boot() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    injectStyles();
    markBody();

    if (!Spotify.ready()) {
      // The web player is still booting (login screen, splash…). Retry with
      // an exponential-ish backoff, capped, instead of a hot 500 ms loop.
      if (bootTries++ < 40) {
        setTimeout(boot, Math.min(1500, 250 + bootTries * 150));
      }
      return;
    }
    start();
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;

    UI.build();
    Mirror.start();
    Ticker.start();
    Router.sync();
    syncFromDom("boot");

    /* Spotify is a single-page app: watch the main view for page changes and
       re-sync the route + chrome. One observer, no polling. */
    var main = pick(SEL.mainView);
    if (main && window.MutationObserver) {
      var pageObs = new MutationObserver(debounce(function () {
        Router.sync();
        syncFromDom("page");
        UI.paintChrome(State);
      }, 250));
      pageObs.observe(main, { childList: true, subtree: false });
    }

    /* Re-apply the theme + repaint after a rotation or a keyboard resize.
       (Everything else adapts through CSS: the shell is sized in `vh`/`%` so
       no JS measurement is needed — remember `window.innerWidth` is faked by
       the wrapper, see the header comment.) */
    window.addEventListener(
      "resize",
      debounce(function () {
        Theme.apply();
        UI.paintProgress();
      }, 200)
    );

    Bridge.playLoaded();
    Bridge.uiReady();
    Bridge.mediaStatus(State);
    Actions.syncLocks();
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
      lastPlaying = s.playing;
      Actions.syncLocks();
    }
    UI.paint(s, reason);
  });

  window.SpotiDuckUI = {
    version: VERSION,
    state: State,
    settings: Settings,
    set: function (key, value) {
      if (!(key in Settings)) return;
      Settings[key] = value;
      saveSettings();
      if (key === "theme") Theme.apply();
      UI.paint(State, "settings");
    },
    openPlayer: function () {
      Player.openSheet();
    },
    closePlayer: function () {
      Player.closeSheet();
    },
    openQueue: function () {
      Queue.openSheet();
    },
    sync: function () {
      syncFromDom("manual");
    },
    /* exposed for tests / the demo harness */
    _internals: { Spotify: Spotify, Bridge: Bridge, Actions: Actions, UI: UI, Router: Router },
  };

  loadSettings();
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
