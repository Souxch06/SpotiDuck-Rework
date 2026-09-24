/*
 * SpotiDuck — mode « interface Spotify ».
 *
 * Chargé à la place de la couche injectée quand l'utilisateur choisit
 * l'interface native : le user-agent est celui de Chrome Android, donc
 * open.spotify.com sert sa **propre interface mobile** (barre de navigation
 * basse, listes compactes, lecteur plein écran) — rien n'est redessiné ici.
 *
 * Ce script ne fait que quatre choses, et rien d'autre :
 *
 *   1. supprimer les pop-ups que Spotify réserve aux navigateurs mobiles
 *      (bandeaux « Ouvrir dans l'application », consentement aux cookies,
 *      infobulles, promotions plein écran) et les empêcher de revenir ;
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
   * 1. Viewport : le meta que Spotify ne déclare pas
   *
   * Sans lui, la WebView se donne une largeur de mise en page de 980 px : la
   * page est alors dessinée pour un écran trois fois plus large que le
   * téléphone (d'où une interface énorme, coupée, qu'il faut faire glisser).
   * ------------------------------------------------------------------ */
  var VIEWPORT_CONTENT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

  function ensureViewport() {
    var head = document.head || document.documentElement;
    if (!head) return;
    var metas = document.querySelectorAll("meta[name='viewport']");
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
  }

  ensureViewport();
  window.setTimeout(ensureViewport, 400);
  window.setTimeout(ensureViewport, 1500);

  /* ------------------------------------------------------------------ *
   * 2. Pop-ups et bandeaux : masqués, puis retirés du DOM
   * ------------------------------------------------------------------ */
  var POPUPS = [
    // « Installer / ouvrir l'application »
    "div[data-testid='banner']",
    "[data-encore-id='banner']",
    "[data-testid='install-app-banner']",
    "[data-testid='mobile-app-banner']",
    "[data-testid='app-install-prompt']",
    "[data-testid='open-in-app-button']",
    "a[href^='/download']",
    "a[href*='play.google.com']",
    "a[href*='apps.apple.com']",
    "button[data-testid='web-player-link']",
    ".encore-internal-announcements",
    // Consentement aux cookies (OneTrust est ce que Spotify utilise sur le web)
    "#onetrust-consent-sdk",
    "#onetrust-banner-sdk",
    "#onetrust-pc-sdk",
    "#onetrust-pc-dark-filter",
    ".onetrust-pc-dark-filter",
    ".optanon-alert-box-wrapper",
    "[id^='onetrust']",
    "[class*='onetrust']",
    "iframe[title*='cookie' i]",
    "iframe[src*='consent' i]",
    "[data-testid='cookie-banner']",
    "[data-testid='cookie-policy-banner']",
    "[data-testid='consent-banner']",
    "[data-testid='gdpr-banner']",
    // Infobulles, bulles d'aide, menus contextuels
    "[data-testid='hover-or-focus-tooltip']",
    "[data-tippy-root]",
    "[role='tooltip']",
    // Promotions qui recouvrent la page
    "[data-testid='promo-banner']",
    "[data-testid='premium-upsell']",
    "[data-testid='upgrade-banner']",
    "[data-testid='upsell-banner']",
    "[data-testid='announcement-banner']",
  ];

  /* Même chose pour l'apparence : rien de ce qui fait « page web » ne doit
     rester (barres de défilement, surbrillance bleue au toucher, barre de
     sélection, menu d'appui long, rebond de défilement). */
  var css = document.createElement("style");
  css.setAttribute("data-sd", "native-mode");
  /* Une règle par sélecteur : si l'un d'eux devenait invalide (un attribut
     exotique ajouté plus tard), les autres continueraient de s'appliquer. */
  var hideCss = POPUPS.map(function (sel) {
    return sel + "{display:none !important}";
  }).join("\n");
  css.textContent =
    hideCss +
    "\n" +
    "html{-webkit-text-size-adjust:100% !important;-webkit-tap-highlight-color:transparent !important;overscroll-behavior:none !important}\n" +
    "body{overscroll-behavior:none !important;-webkit-tap-highlight-color:transparent !important}\n" +
    "*,*::before,*::after{-webkit-touch-callout:none !important;-webkit-user-drag:none}\n" +
    "html,body,div,span,li,p,h1,h2,h3,h4,h5,h6,a,button,label{-webkit-user-select:none;user-select:none}\n" +
    "input,textarea,[contenteditable='true'],[contenteditable='']{-webkit-user-select:text !important;user-select:text !important}\n" +
    "::-webkit-scrollbar{width:0 !important;height:0 !important;background:transparent !important}\n" +
    "::-webkit-scrollbar-thumb,::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent !important}\n";
  (document.head || document.documentElement).appendChild(css);

  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  /**
   * Les bannières de consentement posent `overflow:hidden` sur `<body>` pour
   * bloquer le défilement derrière elles. Comme on les masque au lieu de
   * cliquer « Accepter », le verrou resterait en place : on le relâche, mais
   * seulement si aucun vrai dialogue n'est ouvert.
   */
  function unlockScroll() {
    if (visible(document.querySelector("[role='dialog']"))) return;
    var b = document.body;
    var h = document.documentElement;
    if (!b) return;
    if (b.style && b.style.overflow === "hidden") b.style.overflow = "";
    if (h.style && h.style.overflow === "hidden") h.style.overflow = "";
    if (b.style && (b.style.position === "fixed" || b.style.position === "absolute")) b.style.position = "";
  }

  /**
   * Masque (CSS) et, pour les bannières de consentement — qui ne sont pas
   * gérées par React —, retire carrément du DOM : elles ne peuvent donc plus
   * intercepter le moindre appui.
   */
  function purge() {
    var found = 0;
    for (var i = 0; i < POPUPS.length; i++) {
      var nodes;
      try {
        nodes = document.querySelectorAll(POPUPS[i]);
      } catch (e) {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        found++;
        if (n.getAttribute("data-sd-purged") === "1") continue;
        n.setAttribute("data-sd-purged", "1");
        var sig = (n.id || "") + " " + (typeof n.className === "string" ? n.className : "");
        if (/onetrust|cookie|consent|optanon|gdpr/i.test(sig) && n.parentNode) {
          try {
            n.parentNode.removeChild(n);
          } catch (e) {}
        }
      }
    }
    if (found) unlockScroll();
    return found;
  }

  /* Le balayage complet est trop lourd pour être relancé à chaque rendu de
     Spotify (l'application redessine en permanence) : on ne relance `purge`
     que si le nœud ajouté ressemble de près ou de loin à un pop-up. */
  var LOOKS_LIKE_POPUP = /onetrust|cookie|consent|optanon|banner|announcement|upsell|promo|upgrade|install-app|open-in-app|tooltip|tippy|modal-overlay/i;
  function suspect(node) {
    if (!node || node.nodeType !== 1) return false;
    var sig = "";
    try {
      sig =
        (node.id || "") +
        " " +
        (typeof node.className === "string" ? node.className : "") +
        " " +
        (node.getAttribute("data-testid") || "") +
        " " +
        (node.getAttribute("aria-label") || "");
    } catch (e) {
      return false;
    }
    return LOOKS_LIKE_POPUP.test(sig);
  }

  purge();
  window.setTimeout(purge, 300);
  window.setTimeout(purge, 1200);
  window.setTimeout(purge, 3500);
  try {
    new MutationObserver(function (records) {
      var hit = false;
      for (var i = 0; i < records.length && !hit; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (suspect(added[j])) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) return;
      if (purge()) window.setTimeout(unlockScroll, 900);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

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
      /* Attention à la langue : le bouton annonce l'action à venir. « Pause »
         veut dire « déjà en lecture », mais « Lecture » (FR) / « Play » (EN)
         veut dire « en pause, appuie pour reprendre » — il faut donc cliquer. */
      if (b && /pause/i.test(b.getAttribute("aria-label") || "")) return true;
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
      var value = ms / 1000; // Spotify exprime sa barre de progression en secondes
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
  var from = null;
  var swallowUntil = 0;

  function pressPoint(e) {
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX || 0, y: t.clientY || 0 };
  }

  function startHold(e) {
    window.clearTimeout(hold);
    from = pressPoint(e);
    hold = window.setTimeout(function () {
      hold = 0;
      from = null;
      swallowUntil = Date.now() + 700;
      try {
        if (navigator.vibrate) navigator.vibrate(20);
      } catch (err) {}
      bridge("showUiChooser");
    }, 3000);
  }

  function cancelHold() {
    window.clearTimeout(hold);
    hold = 0;
    from = null;
  }

  /* Un doigt qui fait défiler la page n'est pas un appui long : au-delà de
     12 px, on abandonne. C'est ce qui évite le « pop-up » qui s'ouvrait en
     gardant le doigt posé pendant un défilement. */
  function movedFar(e) {
    if (!from) return false;
    var p = pressPoint(e);
    return Math.abs(p.x - from.x) > 12 || Math.abs(p.y - from.y) > 12;
  }

  ["touchstart", "mousedown"].forEach(function (ev) {
    document.addEventListener(ev, startHold, { passive: true, capture: true });
  });
  ["touchmove", "mousemove"].forEach(function (ev) {
    document.addEventListener(
      ev,
      function (e) {
        if (movedFar(e)) cancelHold();
      },
      { passive: true, capture: true }
    );
  });
  ["touchend", "touchcancel", "mouseup", "scroll"].forEach(function (ev) {
    document.addEventListener(ev, cancelHold, { passive: true, capture: true });
  });
  /* Le clic qui suit le relâchement appartient au choix de l'interface, pas à
     Spotify : sans ça, un appui long sur une liste lance le morceau touché. */
  document.addEventListener(
    "click",
    function (e) {
      if (swallowUntil && Date.now() < swallowUntil) {
        swallowUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );
})();
