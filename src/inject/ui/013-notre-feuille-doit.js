  /* ------------------------------------------------------------------ *
   * 10-quater. Content — notre feuille ne doit jamais effacer la page
   *
   * Le 24/09, la capture du téléphone a montré exactement ceci : notre barre du
   * haut, et **un écran noir en dessous**. La cause est une règle de notre
   * propre feuille : `#global-nav-bar` et `#Desktop_LeftSidebar_Id` sont
   * masquées (c'est voulu : ce sont les barres de bureau de Spotify, la nôtre
   * les remplace) — mais sur la disposition actuelle de la page, l'une des deux
   * **contient** le contenu. Masquer la barre masquait donc toute la page.
   *
   * Plutôt que de deviner lequel des deux conteneurs est l'ancêtre aujourd'hui,
   * on le **mesure** : à partir de l'élément de contenu, on remonte la chaîne
   * des ancêtres, et tout ancêtre que notre feuille a masqué est rétabli
   * (`display` et `visibility` en style en ligne, donc prioritaires sur nos
   * règles, mais uniquement sur **ces** éléments-là). Un ancêtre marqué
   * `data-sd-unhidden` reste visible dans le diagnostic et dans la sonde.
   *
   * Ce que ça ne fait pas : rétablir ce qui est masqué légitimement (la barre
   * latérale de bureau, la barre du haut de Spotify, le panneau de droite) —
   * elles ne sont pas des ancêtres du contenu.
   * ------------------------------------------------------------------ */
  var CONTENT_ANCHORS = [
    '[data-testid="home-page"]',
    "#main-view",
    "main[data-testid]",
    ".Root__main-view",
    "main",
  ];

  var Content = {
    restored: [],
    /** Rétablit les ancêtres du contenu masqués par notre feuille. */
    apply: function () {
      var anchor = pick(CONTENT_ANCHORS);
      if (!anchor || !anchor.parentNode) return 0;
      var fixed = 0;
      var node = anchor.parentNode;
      /* La liste de ce qui a été rétabli sert au diagnostic ; `apply` tourne à
         chaque changement de vue, donc sans contrôle elle grossissait sans fin
         (une longue session empilait des milliers d'entrées identiques et le
         diagnostic devenait illisible). On garde **un exemplaire de chaque
         nœud**, dans l'ordre où il a été rétabli, avec un plafond. */
      var restored = Content.restored;
      while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
        var cs = window.getComputedStyle(node);
        var hidden = cs.display === "none" || cs.visibility === "hidden";
        if (hidden) {
          node.style.setProperty("display", "block", "important");
          node.style.setProperty("visibility", "visible", "important");
          node.setAttribute("data-sd-unhidden", "1");
          var who = node.id || node.getAttribute("class") || node.tagName;
          /* Le style en ligne reste posé après coup : cette liste dit ce qui est
             **encore** maintenu visible, pas ce qui l'a été un jour. */
          if (restored.indexOf(who) < 0 && restored.length < 12) restored.push(who);
          fixed++;
        }
        node = node.parentNode;
      }
      var html = document.documentElement;
      if (fixed) html.classList.add("sd-content-restored");
      html.classList.toggle("sd-content-hidden", fixed === 0 && !!anchor && anchor.getBoundingClientRect().height < 4);
      return fixed;
    },
    /**
     * Ce qui est **rendu** dans l'ancre de contenu.
     *
     * `innerText` n'existe que pour du texte réellement affiché (un texte caché
     * n'y figure pas) ; le nombre d'éléments rendus se compte sur des boîtes non
     * vides. C'est la seule mesure qui distingue « la page est noire » de « la
     * page est une colonne étroite mais pleine ».
     */
    rendered: function (anchor) {
      var text = 0;
      try {
        var raw = typeof anchor.innerText === "string" ? anchor.innerText : anchor.textContent;
        text = String(raw || "").replace(/\s+/g, " ").trim().length;
      } catch (e) {
        text = 0;
      }
      var nodes = anchor.querySelectorAll("button, [role=button], a[href], img, input, iframe, svg, canvas");
      var els = 0;
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        if (r.width > 2 && r.height > 2) els++;
      }
      return { text: text, els: els };
    },

    /**
     * Le contenu attendu est-il là ? On mesure **ce qui est rendu**, pas la
     * largeur d'une boîte.
     *
     * Le 25/09, le téléphone a affiché l'alarme « la page n'a rien affiché »
     * avec, dans son propre diagnostic, `contenu 29×2756` : la page avait
     * 2 756 px de contenu, mais l'élément choisi ne faisait que 29 px de large —
     * et le test `largeur < 40 px`, écrit pour une autre disposition de la page,
     * la déclarait vide. Un seuil de largeur ne dit rien de ce qu'on voit ; ce
     * qui le dit, c'est du texte rendu et des éléments rendus. L'alarme ne se
     * déclenche donc plus que quand **rien** n'est rendu — le noir du 24/09.
     */
    state: function () {
      var anchor = pick(CONTENT_ANCHORS);
      if (!anchor) return { ok: false, why: "aucun élément de contenu" };
      var rect = anchor.getBoundingClientRect();
      var r = this.rendered(anchor);
      var size = Math.round(rect.width) + "×" + Math.round(rect.height);
      var why =
        "contenu " + size +
        " · rendu " + r.text + " car. / " + r.els + " élément" + (r.els > 1 ? "s" : "");
      if (r.text < 20 && r.els === 0) return { ok: false, why: why };
      return { ok: true, why: why };
    },

    /**
     * Si l'écran reste vide, on le **dit** — au lieu de laisser un écran noir
     * muet (« on voit rien »). Le panneau nomme l'état mesuré, propose de
     * recharger, et sait copier le diagnostic (une seule ligne à coller pour
     * savoir ce qui se passe sur un téléphone qu'on n'a pas sous la main).
     */
    /**
     * **Un écran noir se dit, même en changeant de page.** Jusqu'ici l'alerte
     * n'était armée qu'au démarrage : une playlist ouverte plus tard qui
     * n'affichait rien restait un écran noir muet (signalé : « quand on clique
     * sur les playlists, y'a un écran noir »). On la réarme donc après chaque
     * changement de vue, une fois, sans boucle.
     */
    alertSoon: function (ms) {
      var self = this;
      window.clearTimeout(this.alertTimer);
      this.alertTimer = window.setTimeout(function () {
        self.alertTimer = 0;
        self.alertIfBlank();
      }, typeof ms === "number" ? ms : 1500);
      return true;
    },

    alertIfBlank: function () {
      var state = this.state();
      var html = document.documentElement;
      if (state.ok) {
        this.hideAlert();
        return false;
      }
      html.classList.add("sd-content-blank");
      this.showAlert(state.why);
      return true;
    },

    hideAlert: function () {
      document.documentElement.classList.remove("sd-content-blank");
      if (this.alert) this.alert.hidden = true;
    },

    showAlert: function (why) {
      if (!this.alert) {
        var el = document.createElement("div");
        el.className = "sd-content-alert";
        el.setAttribute("role", "alert");
        el.innerHTML =
          '<div class="sd-content-alert-card">' +
          '<span class="sd-content-alert-title"></span>' +
          '<p class="sd-content-alert-text"></p>' +
          '<pre class="sd-content-alert-diag"></pre>' +
          '<div class="sd-content-alert-actions">' +
          '<button class="sd-content-alert-reload" type="button"></button>' +
          '<button class="sd-content-alert-copy" type="button"></button>' +
          '<button class="sd-content-alert-close" type="button"></button>' +
          "</div></div>";
        this.alert = el;
        UI.layer.appendChild(el);
        var self = this;
        $(".sd-content-alert-reload", el).addEventListener("click", function () {
          Toast.show(Settings.labels.reloading);
          try {
            location.reload();
          } catch (e) {
            /* rien de plus */
          }
        });
        $(".sd-content-alert-copy", el).addEventListener("click", function () {
          var text = self.diagnose();
          var done = function () {
            Toast.show(Settings.labels.diagnosticCopied);
          };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(done, function () {
                Toast.show(text.slice(0, 120));
              });
              return;
            }
          } catch (e) {
            /* repli ci-dessous */
          }
          Toast.show(text.slice(0, 120));
        });
        $(".sd-content-alert-close", el).addEventListener("click", function () {
          self.hideAlert();
        });
      }
      $(".sd-content-alert-title", this.alert).textContent = Settings.labels.blankTitle;
      $(".sd-content-alert-text", this.alert).textContent = Settings.labels.blankText.replace("%s", why);
      $(".sd-content-alert-diag", this.alert).textContent = this.diagnose();
      $(".sd-content-alert-reload", this.alert).textContent = Settings.labels.reload;
      $(".sd-content-alert-copy", this.alert).textContent = Settings.labels.copyDiagnostic;
      $(".sd-content-alert-close", this.alert).textContent = Settings.labels.close;
      this.alert.hidden = false;
      /* Le contenu peut encore arriver (un chargement lent, pas un échec) : on
         revérifie sans boucle serrée, et le panneau s'efface tout seul. */
      var self = this;
      var tries = 0;
      (function recheck() {
        if (++tries > 10) return;
        window.setTimeout(function () {
          if (self.alert && !self.alert.hidden && self.state().ok) {
            self.hideAlert();
            return;
          }
          if (self.alert && self.alert.hidden) return;
          recheck();
        }, 2000);
      })();
    },

    /**
     * Un extrait de ce que la page **dit** (ses propres mots, rendus).
     *
     * Sans lui, une remontée de bug dit « ça ne marche pas » et il faut deviner
     * quelle page l'utilisateur avait sous les yeux. Avec lui, la capture
     * contient la réponse : « Choisissez votre langue », « Connectez-vous pour
     * écouter », ou les titres des rangées de son accueil.
     */
    excerpt: function () {
      var anchor = pick(CONTENT_ANCHORS);
      if (!anchor) return "";
      var raw = "";
      try {
        raw = typeof anchor.innerText === "string" ? anchor.innerText : anchor.textContent;
      } catch (e) {
        raw = anchor.textContent || "";
      }
      return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 60);
    },

    /**
     * La version à montrer : celle de **l'application** (par le pont) et celle
     * de la **coque** (estampillée au build). Les deux doivent coïncider ; si
     * elles diffèrent, c'est que l'APK installé n'est pas celui qu'on croit — et
     * c'est précisément ce qu'il faut voir dans une remontée de bug.
     */
    version: function () {
      var app = Bridge.has("version") ? String(Bridge.call("version") || "") : "";
      if (app && app !== VERSION) return app + " (coque " + VERSION + ")";
      return VERSION;
    },

    /** Une ligne à coller : ce qu'un écran qu'on ne voit pas dit de lui-même. */
    diagnose: function () {
      var s = this.state();
      var vp = Viewport.measure();
      var extrait = this.excerpt();
      return (
        "SpotiDuck " + this.version() +
        " · interface " + (Bridge.has("uiMode") ? Bridge.call("uiMode") : "coque SpotiDuck") +
        " · vue " + vp.layout + "×" + viewH() + " px (écran " + (vp.device || "?") + ")" +
        " · unité " + Device.base.toFixed(2) +
        " · contenu " + s.why +
        " · ancres " + this.anchors() +
        /* Ce que les commandes trouveraient dans la page — sans rien presser :
           le diagnostic ne doit pas changer l'état de la lecture. `SpotiDuckUI
           .selfTest(true)` est la version qui appuie, pour la sonde de CI. */
        " · commandes " + Engine.selfTest().text +
        (extrait ? ' · extrait \"' + extrait + '\"' : "") +
        /* La session **réelle** (cookie du lecteur), qui ne se devine pas dans
           le DOM : la page peut afficher un accueil sans qu'un compte soit
           connecté (Spotify le fait), et l'utilisateur, lui, veut ses playlists. */
        " · session " + (Bridge.has("session") ? (Bridge.call("session") ? "oui" : "non") : "?") +
        " · accueil " + Home.describe() +
        " · biblio " + Library.describe() +
        " · " + Content.describe() +
        " · page " + location.pathname +
        " · lecteur " + (Spotify.ready() ? "prêt" : "absent") +
        /* Par où passent nos appels d'API, et ce qui a manqué : sans ça, une
           bibliothèque vide ne dit pas si c'est le jeton, le réseau ou le
           contrôle d'accès du navigateur. */
        " · api " + Net.describe()
      );
    },

    /**
     * Toutes les ancres candidates, mesurées.
     *
     * L'ancre choisie ne suffit pas à comprendre : « contenu 29×2756 » a laissé
     * deux hypothèses ouvertes — la page n'a pas de `#main-view` (donc ce n'est
     * pas l'accueil du lecteur), ou elle en a un que **notre** feuille a écrasé.
     * Les mesurer toutes les départage en une ligne.
     */
    anchors: function () {
      var parts = [];
      for (var i = 0; i < CONTENT_ANCHORS.length; i++) {
        var sel = CONTENT_ANCHORS[i];
        var name = sel.replace(/^\[data-testid="?|"?\]$/g, "").replace(/^#/, "");
        var el = document.querySelector(sel);
        if (!el) {
          parts.push(name + " absent");
          continue;
        }
        var r = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        parts.push(name + " " + Math.round(r.width) + "×" + Math.round(r.height) + " " + cs.display);
      }
      return parts.join(" · ");
    },

    /** Une ligne pour le diagnostic : ce qui a dû être rétabli, et pourquoi. */
    describe: function () {
      if (!Content.restored.length) return "contenu : rien à rétablir";
      return "contenu rétabli : " + Content.restored.slice(0, 3).join(" > ");
    },
  };

