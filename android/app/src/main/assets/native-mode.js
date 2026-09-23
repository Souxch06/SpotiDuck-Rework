/*
 * SpotiDuck — mode « interface Spotify ».
 *
 * Chargé à la place de la couche injectée quand l'utilisateur choisit
 * l'interface native : le user-agent est celui de Chrome Android, donc
 * open.spotify.com sert sa **propre interface mobile** (barre de navigation
 * basse, listes compactes, lecteur plein écran) — rien n'est redessiné ici.
 *
 * Ce script ne fait que trois choses, et rien d'autre :
 *
 *   1. masquer les bandeaux « Ouvrir dans l'application » / « Télécharger »
 *      que Spotify affiche aux navigateurs mobiles ;
 *   2. exposer un `window.SpotiDuckUI` minimal (lecture, pause, suivant,
 *      précédent, j'aime, avance) pour que les boutons de la notification
 *      Android et de l'écran de verrouillage fonctionnent : ils cliquent les
 *      vrais boutons de Spotify au lieu de piloter notre propre lecture ;
 *   3. alimenter la notification (titre, artiste, pochette, position) par le
 *      pont `AndBridge` — sinon l'écran de verrouillage reste vide ;
 *   4. installer un appui long de 3 secondes, invisible, qui rouvre le choix
 *      de l'interface (c'est le seul moyen de revenir en arrière puisque notre
 *      couche n'est plus là où sont ses paramètres).
 */
(function () {
  if (window.__sdNative) return;
  window.__sdNative = true;

  var NATIVE = "native";

  /* ------------------------------------------------------------------ *
   * 1. Bandeaux navigateur mobile
   * ------------------------------------------------------------------ */
  var css = document.createElement("style");
  css.setAttribute("data-sd", "native-mode");
  css.textContent = [
    "div[data-testid='banner']",
    "a[href^='/download']",
    "a[href*='play.google.com']",
    "a[href*='apps.apple.com']",
    "button[data-testid='web-player-link']",
    "[data-testid='open-in-app-button']",
    "[data-testid='install-app-banner']",
    ".encore-internal-announcements",
    "[data-testid='hover-or-focus-tooltip']",
    "[data-tippy-root]",
  ].join(",") + "{display:none !important}";
  (document.head || document.documentElement).appendChild(css);

  /* ------------------------------------------------------------------ *
   * 2. Pont minimal pour la notification Android
   * ------------------------------------------------------------------ */
  function bridge(name, arg) {
    try {
      var b = window.AndBridge;
      if (b && typeof b[name] === "function") {
        if (arg === undefined) b[name]();
        else b[name](arg);
      }
    } catch (e) {}
  }

  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function byLabel(res, root) {
    var nodes = (root || document).querySelectorAll("button,[role='button']");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var s = [n.getAttribute("aria-label"), n.getAttribute("title"), n.textContent]
        .filter(Boolean)
        .join(" ");
      if (res.test(s)) return n;
    }
    return null;
  }

  function playPauseBtn() {
    return (
      q("button[data-testid='control-button-playpause']") ||
      q("[data-testid='now-playing-widget'] ~ * button[aria-label*='ause']") ||
      byLabel(/(pause|play|lecture|reprendre)/i)
    );
  }

  function clickBtn(btn) {
    if (!btn) return false;
    try {
      btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function setNativeInput(input, value) {
    if (!input) return false;
    try {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Le shim : mêmes noms de méthodes que la couche injectée, pour que
     `PlaybackService` n'ait rien à savoir du mode choisi. */
  window.SpotiDuckUI = {
    version: "native",
    mode: NATIVE,
    play: function () {
      var b = playPauseBtn();
      if (b && /pause|lecture/i.test(b.getAttribute("aria-label") || "")) return true; // déjà en lecture
      return clickBtn(b);
    },
    pause: function () {
      var b = playPauseBtn();
      if (b && /play|lecture/i.test(b.getAttribute("aria-label") || "")) return true; // déjà en pause
      return clickBtn(b);
    },
    playPause: function () {
      return clickBtn(playPauseBtn());
    },
    next: function () {
      return clickBtn(
        q("button[data-testid='control-button-skip-forward']") ||
          byLabel(/(next|suivant|suivante)/i)
      );
    },
    previous: function () {
      return clickBtn(
        q("button[data-testid='control-button-skip-back']") ||
          byLabel(/(previous|pr[ée]c[ée]dent)/i)
      );
    },
    like: function () {
      var b =
        q("[data-testid='now-playing-widget'] button[aria-checked]") ||
        byLabel(/^(j'aime|like|aimer|retirer)/i);
      return clickBtn(b);
    },
    seek: function (ms) {
      var input = q("[data-testid='playback-progressbar'] input[type='range']") || q("input[type='range']");
      if (!input) return false;
      var max = parseFloat(input.max || input.getAttribute("max") || "0");
      var value = /^\s*\d{4,}$/.test(String(max)) ? ms / 1000 : ms / 1000; // spotify parle en secondes
      return setNativeInput(input, Math.max(0, Math.min(max, value)));
    },
    sync: function () {
      publish(true);
    },
    back: function () {
      if (window.history.length > 1) {
        window.history.back();
        return true;
      }
      return false;
    },
    /* Rien à piloter : l'interface est celle de Spotify. */
    openPlayer: function () {},
    closePlayer: function () {},
    openSettings: function () {},
    close: function () {},
    set: function () {
      return false;
    },
  };

  /* ------------------------------------------------------------------ *
   * 3. Métadonnées → notification + état de veille
   * ------------------------------------------------------------------ */
  var last = "";
  var lastPos = 0;
  var lastPlaying = false;

  function readPlaying() {
    var b = playPauseBtn();
    var label = (b && (b.getAttribute("aria-label") || "")) || "";
    if (/pause/i.test(label)) return true;
    if (/play|lecture|reprendre/i.test(label)) return false;
    return lastPlaying;
  }

  function publish(force) {
    var titleEl =
      q("[data-testid='context-item-link']") ||
      q("[data-testid='now-playing-widget'] a[href*='/track/']") ||
      q("[data-testid='nowplaying-track-link']");
    var artistEl =
      q("[data-testid='context-item-info-artist']") ||
      q("[data-testid='nowplaying-artist']") ||
      q("[data-testid='context-item-info-show']");
    var img = q("[data-testid='cover-art-image']") || q("img[data-testid='cover-art-image']");
    var range = q("[data-testid='playback-progressbar'] input[type='range']") || q("input[type='range']");

    var title = titleEl ? (titleEl.textContent || "").trim() : "";
    var artist = artistEl ? (artistEl.textContent || "").trim() : "";
    var cover = img ? img.getAttribute("src") || "" : "";
    var max = range ? parseFloat(range.max || "0") : 0;
    var val = range ? parseFloat(range.value || "0") : 0;
    var duration = /^\s*\d{4,}$/.test(String(range && range.max)) ? max : max * 1000;
    var position = /^\s*\d{4,}$/.test(String(range && range.max)) ? val : val * 1000;
    var playing = readPlaying();
    if (!title) return;

    var key = [title, artist, playing].join("|");
    if (!force && key === last) {
      if (Math.abs(position - lastPos) > 4000) {
        lastPos = position;
        bridge("recMediaPosition", Math.round(position));
      }
      return;
    }
    last = key;
    lastPos = position;
    lastPlaying = playing;
    bridge(
      "recMediaStatus",
      JSON.stringify({
        track: title,
        artist: artist,
        cover: cover,
        duration: Math.round(duration || 0),
        position: Math.round(position || 0),
        playing: playing,
        repeat: "false",
        fav: false,
      })
    );
  }

  publish(true);
  window.setInterval(publish, 1000);

  /* ------------------------------------------------------------------ *
   * 4. Appui long (3 s, n'importe où) → choix de l'interface
   * ------------------------------------------------------------------ */
  var hold = 0;
  function startHold() {
    window.clearTimeout(hold);
    hold = window.setTimeout(function () {
      hold = 0;
      try {
        if (navigator.vibrate) navigator.vibrate(20);
      } catch (e) {}
      bridge("showUiChooser");
    }, 3000);
  }
  function cancelHold() {
    window.clearTimeout(hold);
    hold = 0;
  }
  ["touchstart", "mousedown"].forEach(function (ev) {
    document.addEventListener(ev, startHold, { passive: true, capture: true });
  });
  ["touchend", "touchcancel", "touchmove", "mouseup", "scroll"].forEach(function (ev) {
    document.addEventListener(ev, cancelHold, { passive: true, capture: true });
  });
})();
