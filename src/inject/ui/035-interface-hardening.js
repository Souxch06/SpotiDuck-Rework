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

    /**
     * **Un dialogue compte quand il est *visible*.**
     *
     * `querySelector` seul tombait sur les dialogues que Spotify garde montés
     * dans son arbre une fois fermés : la coque croyait alors qu'un dialogue
     * était ouvert **pour toujours** — nos barres s'éteignaient (dont le
     * mini-lecteur, en `opacity: 0`) et notre calque passait derrière la page.
     * C'est exactement ce que l'utilisateur appelle « le lecteur disparaît » et
     * « tous les affichages sont bugués ». Un dialogue ouvert, lui, a une taille.
     */
    dialogVisible: function (node) {
      if (!node) return false;
      if (node.hidden === true) return false;
      if (node.getAttribute("aria-hidden") === "true") return false;
      var rects = node.getClientRects ? node.getClientRects() : null;
      if (!rects || !rects.length) return false;
      var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || 1) < 0.05)) return false;
      return true;
    },

    syncOverlay: function () {
      var open = false;
      for (var i = 0; i < this.OVERLAYS.length && !open; i++) {
        var found = document.querySelectorAll(this.OVERLAYS[i]);
        for (var j = 0; j < found.length; j++) {
          /* Our own player and sheets are dialogs too — never treat them as a
             native overlay, or the shell would hide itself on open. */
          if (found[j].closest(".sd-layer")) continue;
          if (!this.dialogVisible(found[j])) continue;
          open = true;
          break;
        }
      }
      if (open === this.overlayOpen) return false;
      this.overlayOpen = open;
      document.documentElement.classList.toggle("sd-native-modal", open);
      return true;
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
      window.addEventListener("orientationchange", function () {
      Device.apply();
      apply();
    });
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

