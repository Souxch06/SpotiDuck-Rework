  /* ------------------------------------------------------------------ *
   * 11h. Device — l'unité de l'interface, déduite de l'appareil
   *
   * `--sd-u` dimensionne **tout** : barres, typographie, pochette du
   * mini-lecteur, feuilles, lecteur plein écran. Elle était figée à 1 — la même
   * interface pour un téléphone de 360 px et une tablette de 800, avec un
   * réglage manuel pour compenser les différences. Le réglage manuel reste
   * (c'est devenu un *facteur*), mais la base est désormais **mesurée** :
   *
   *     base = clamp(0,92 ; min(largeur / 412 ; hauteur / 915) ; 1,15)
   *
   *   · 360×800   → 0,92   (plancher : le texte ne descend pas sous Material)
   *   · 412×915   → 1,00   (la référence du projet)
   *   · 480×1040  → 1,14
   *   · 800×1280  → 1,15   (plafond : au-delà, c'est la place qui gagne)
   *   · 915×412   → 0,92   (paysage : les barres restent fines)
   *
   * La hauteur compte autant que la largeur, sinon un téléphone en paysage
   * aurait des barres plus hautes que le tiers de son écran. Le plancher existe
   * pour la même raison : sur un petit écran on resserre la mise en page, on ne
   * rétrécit pas le texte.
   *
   * Les paliers (`sd-size-compact`, `sd-size-normal`, `sd-size-wide`,
   * `sd-orient-landscape`) sont posés ici et consommés par la feuille
   * `76-device.css` : c'est là que se règlent les hauteurs de barres, pas dans
   * le script.
   * ------------------------------------------------------------------ */
  var Device = {
    base: 1,
    apply: function () {
      var html = document.documentElement;
      var w = viewW();
      var h = viewH();
      /* clamp(valeur, mini, maxi) : l'ancienne forme donnait `0,92` comme
         valeur et la mesure comme minimum — d'où 1,40 sur une tablette au lieu
         du plafond de 1,15. */
      var base = clamp(Math.min(w / 412, h / 915), 0.92, 1.15);
      base = Math.round(base * 1000) / 1000;
      this.base = base;
      html.style.setProperty("--sd-u-base", String(base));
      var wide = w >= 600;
      var compact = w < 380;
      html.classList.toggle("sd-size-compact", compact && !wide);
      html.classList.toggle("sd-size-normal", !compact && !wide);
      html.classList.toggle("sd-size-wide", wide);
      html.classList.toggle("sd-orient-landscape", w > h);
    },
    /** Une ligne pour le diagnostic : c'est ce qui explique un rendu. */
    describe: function () {
      var html = document.documentElement;
      return (
        "unité " + this.base.toFixed(2) +
        " · " + viewW() + "×" + viewH() + " px" +
        (html.classList.contains("sd-orient-landscape") ? " · paysage" : " · portrait") +
        (html.classList.contains("sd-size-wide") ? " · écran large" : "")
      );
    },
  };

  /** Applique la densité choisie : un **facteur**, multiplié par la base
      mesurée de l'appareil (voir `Device`). */
  function applyDensity(value) {
    var html = document.documentElement;
    html.classList.remove("sd-density-compact", "sd-density-normal", "sd-density-large");
    html.classList.add("sd-density-" + (value === "compact" || value === "large" ? value : "normal"));
    /* La densité change la hauteur rendue du mini-lecteur : la réserve du bas
       se remet à l'heure à l'image suivante (le temps que la feuille ait suivi). */
    if (UI.built) UI.askMeasure();
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
    /* **Un réglage qui ne prend effet qu'après avoir changé d'onglet est un
       réglage qui ne fait rien** (« je décoche l'accueil SpotiDuck, rien ne
       bouge ») : nos deux pages maison et les statistiques ne se regardent que
       sur un changement de vue. On les redemande donc ici, pour que l'appui se
       voie tout de suite — et dans les deux sens, éteindre comme rallumer. */
    if (key === "homeBoard" || key === "libraryBoard" || key === "stats") {
      UI.lastRouteKey = "";
      UI.paintChrome(State);
      /* Les deux pages se rangent ou se montrent d'elles-mêmes selon le réglage
         (`Home.refresh` éteint la sienne, `Library.apply` idem) ; `Stats.load`
         remet la mesure en route quand on la rallume. */
      Home.refresh("réglage");
      Library.enter();
      if (key === "stats") Stats.load();
    }
    if (key === "accentFromArt") {
      /* La couleur reprise de la pochette : l'éteindre doit rendre sa couleur
         de base au lecteur, pas laisser le dégradé en place. */
      if (!value) {
        document.documentElement.style.removeProperty("--sd-player-bg");
        document.documentElement.style.removeProperty("--sd-mini-bg");
      } else Accent.apply(State.cover, State.title);
    }
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
          self.switchRow("homeBoard", Settings.labels.homeBoard),
          self.switchRow("libraryBoard", Settings.labels.libraryBoard),
          self.switchRow("stats", Settings.labels.stats),
          self.actionRow("stats-clear", Settings.labels.statsClear, ICONS.refreshLine),
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
          self.actionRow("reload", Settings.labels.reloadPlayerAction, ICONS.refreshLine),
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

