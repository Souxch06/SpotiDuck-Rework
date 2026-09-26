  /* ------------------------------------------------------------------ *
   * 11e. Open — ouvrir une page **dans** le lecteur, jamais en
   *      rechargeant l'application.
   *
   * Signalé le 25/09 : « quand on appuie sur une playlist, écran noir » — et
   * le retour ne ramenait pas à la bibliothèque. Nos lignes de bibliothèque
   * sont des liens : l'appui faisait donc charger l'adresse par la WebView
   * comme un premier chargement. La page se vidait, Spotify se rechargeait en
   * entier (plusieurs secondes de noir), notre coque repartait de zéro, et le
   * bouton retour sortait de la page au lieu de revenir en arrière.
   *
   * Le lecteur est une application d'une **seule page** : il sait afficher ses
   * propres adresses sans se recharger. On lui passe donc la main, dans cet
   * ordre :
   *   1. le lien de Spotify pour la **même** adresse, s'il est dans la page —
   *      c'est lui qui a le routeur et l'historique ;
   *   2. sinon l'adresse est poussée dans l'historique et l'événement de
   *      navigation est émis : c'est ainsi qu'une application d'une seule page
   *      apprend qu'une adresse a changé ;
   *   3. et si la page n'a pas suivi après trois vérifications, on navigue pour
   *      de vrai — mais **le voile est déjà posé**, donc l'écran n'est jamais
   *      noir : il dit ce qu'il ouvre.
   * ------------------------------------------------------------------ */
  var Open = {
    busy: false,
    tries: 0,
    /* Vrai pendant l'émission de notre propre événement de navigation. */
    synthetic: false,

    bind: function () {
      if (this.bound) return false;
      this.bound = true;
      var self = this;
      /* En capture : nos liens n'ont pas de routeur, la page en a un. */
      document.addEventListener(
        "click",
        function (ev) {
          if (ev.defaultPrevented) return;
          if (ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
          if (!a || !a.closest || !a.closest(".sd-layer")) return;
          var href = a.getAttribute("href") || "";
          /* Un lien externe (la connexion, un partage) ne nous regarde pas. */
          if (href.charAt(0) !== "/") return;
          ev.preventDefault();
          var nom = $(".sd-lib-name", a) || $(".sd-home-title", a);
          self.open(href, nom ? (nom.textContent || "").trim() : "");
        },
        true
      );
      return true;
    },

    /** Le lien de Spotify pour la même adresse, hors de notre coque. */
    twin: function (href) {
      var cible = href.split("?")[0].replace(/\/+$/, "");
      var links = $$('a[href^="/"]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        if (a.closest && a.closest(".sd-layer")) continue;
        var h = (a.getAttribute("href") || "").split("?")[0].replace(/\/+$/, "");
        if (h === cible) return a;
      }
      return null;
    },

    open: function (href, name) {
      if (!href || href.charAt(0) !== "/") return false;
      if (this.busy) return false;
      this.busy = true;
      this.href = href.split("?")[0].replace(/\/+$/, "");
      this.tries = 0;
      this.veil(name);
      var twin = this.twin(href);
      this.parLien = !!twin;
      if (twin) {
        try {
          twin.click();
        } catch (e) {}
      } else {
        try {
          history.pushState({ sd: "open", open: href }, "", href);
        } catch (e) {}
        this.pulse();
      }
      var self = this;
      /* Filet de sécurité : le voile ne reste jamais plus longtemps que ça,
         même si la page ne dit rien. */
      clearTimeout(this.lettre);
      this.lettre = setTimeout(function () {
        self.done();
      }, OPEN_LIMIT);
      this.check();
      return true;
    },

    /**
     * **L'événement de navigation.** Une application d'une seule page affiche
     * une adresse ainsi : on la pousse, puis on lui dit qu'elle a changé.
     * Nos propres écouteurs savent que celui-ci vient de nous (`synthetic`) —
     * sinon l'historique se décrémentait deux fois et le retour tombait à côté.
     */
    pulse: function () {
      var ev = null;
      try {
        ev = typeof PopStateEvent === "function" ? new PopStateEvent("popstate", { state: { sd: "open" } }) : null;
        if (!ev) {
          ev = document.createEvent("Event");
          ev.initEvent("popstate", true, false);
        }
      } catch (e) {
        return false;
      }
      this.synthetic = true;
      try {
        window.dispatchEvent(ev);
      } catch (e) {
        /* rien : la vérification qui suit décidera */
      }
      this.synthetic = false;
      return true;
    },

    /** La page demandée est-elle arrivée ? */
    arrive: function () {
      /* Une sous-page est rendue : c'est la réponse la plus sûre. */
      if (Spotify.route() === "page") return true;
      /* Certaines adresses n'ont pas de section à elles : si **le routeur a
         suivi le lien de Spotify** et que l'adresse est la bonne, c'est arrivé. */
      if (this.parLien && location.pathname.replace(/\/+$/, "") === this.href) return true;
      return false;
    },

    check: function () {
      var self = this;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () {
        if (!self.busy) return;
        if (self.arrive()) {
          self.done();
          return;
        }
        if (++self.tries >= OPEN_TRIES) {
          /* La page n'a pas suivi (adresse que son routeur ignore, routeur
             absent) : on navigue pour de vrai — le voile est déjà posé, donc
             l'écran montre « Ouverture… », jamais du noir. */
          self.busy = false;
          clearTimeout(self.lettre);
          try {
            location.assign(self.href);
          } catch (e) {
            self.done();
          }
          return;
        }
        self.check();
      }, OPEN_STEP);
    },

    /** Le voile : l'écran dit ce qu'il fait pendant que la page s'ouvre. */
    veil: function (name) {
      var node = (UI.el && UI.el.open) || $(".sd-open");
      if (!node) return false;
      var text = $(".sd-open-text", node);
      if (text) text.textContent = name ? Settings.labels.openingOf.replace("%s", name) : Settings.labels.opening;
      node.hidden = false;
      return true;
    },

    hide: function () {
      var node = (UI.el && UI.el.open) || $(".sd-open");
      if (node) node.hidden = true;
      return !!node;
    },

    /** La page est là (ou on renonce) : le voile se retire. */
    done: function (keep) {
      this.busy = false;
      this.tries = 0;
      clearTimeout(this.timer);
      clearTimeout(this.lettre);
      if (!keep) this.hide();
      return true;
    },

    /** Le retour pendant l'ouverture : on annule ce qu'on a poussé. */
    cancel: function () {
      var pousse = this.busy && !this.parLien;
      this.done();
      if (pousse) {
        try {
          history.back();
        } catch (e) {}
      }
      return true;
    },
  };

