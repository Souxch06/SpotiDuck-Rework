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
    /* **Les en-têtes de la page**, tels quels.
     *
     * Le lecteur ne demande pas `api.spotify.com` avec le seul jeton : il
     * envoie aussi `client-token` (et sa version d'application). Ces en-têtes
     * étaient captés… puis jamais renvoyés : nos appels partaient donc
     * « nus », et Spotify les refusait (401/403/429) alors que ceux de la page
     * passaient. C'est exactement « il n'arrive pas à reconnaître mes
     * playlists » : la requête était la bonne, l'enveloppe ne l'était pas.
     * Tout ce qui suit renvoie la même enveloppe que la page. */
    headers: {},
    /* Ce qui vaut la peine d'être renvoyé : le strict nécessaire, pas les
       en-têtes de navigateur (longueur, encodage, cache) que la requête native
       repose elle-même. */
    KEEP: /^(authorization|client-token|spotify-app-version|app-platform|accept-language|x-spotify-[a-z-]+)$/,

    keepHeader: function (name, value) {
      var key = String(name || "").toLowerCase();
      if (!value || !this.KEEP.test(key)) return;
      this.headers[key] = String(value);
      if (key === "client-token") this.clientToken = String(value);
    },

    /** Les en-têtes à envoyer, jeton compris. `browser` écarte ce que le
     *  navigateur interdit de poser (`origin`, `referer`). */
    apiHeaders: function (browser) {
      var out = {};
      for (var k in this.headers) {
        if (browser && (k === "origin" || k === "referer")) continue;
        out[k] = this.headers[k];
      }
      if (this.authToken) out.authorization = this.authToken;
      if (browser && out["accept-language"]) delete out["accept-language"];
      return out;
    },

    /** Ce qu'on a réussi à garder, en clair : « authorization, client-token ». */
    headerNames: function () {
      var kept = [];
      for (var k in this.headers) kept.push(k);
      if (this.authToken && kept.indexOf("authorization") < 0) kept.unshift("authorization");
      return kept.sort().join(", ");
    },
    patchedXhr: false,
    reloads: 0,
    lastReload: 0,
    patched: false,
    RE_DEVICES: /\/track-playback\/v1\/devices/,
    RE_CONNECT: /\/connect-state\/v1\/player\/(?:command|transfer)\/from\/([^/]+)\/to\/([^/?]+)/,

    watch: function () {
      /* Le jeton peut aussi partir en **XHR** (`setRequestHeader`) selon les
         appels du lecteur : sans cette seconde prise, la bibliothèque maison
         resterait vide sur un téléphone dont la page n'utilise pas `fetch` pour
         ses requêtes d'API — et « je ne vois aucune de mes playlists » se
         reproduirait à l'identique. */
      if (!this.patchedXhr && window.XMLHttpRequest && XMLHttpRequest.prototype) {
        this.patchedXhr = true;
        var sendHeader = XMLHttpRequest.prototype.setRequestHeader;
        if (typeof sendHeader === "function") {
          XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            try {
              var key = String(name).toLowerCase();
              if (key === "authorization" && value && value !== Api.authToken) {
                Api.authToken = value;
                Api.tokenAt = Date.now();
                Api.tokenHost = "";
              }
              Api.keepHeader(key, value);
            } catch (e) {
              /* une requête ne doit jamais échouer parce qu'on l'observe */
            }
            return sendHeader.apply(this, arguments);
          };
        }
      }
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
    /* Quand le jeton a été capté, et sur quel hôte : un jeton **anonyme** du
       lecteur déconnecté n'ouvre pas la bibliothèque du compte, et il faut
       pouvoir le dire au lieu de prétendre que le compte est vide. */
    tokenAt: 0,
    tokenHost: "",
    /* Pourquoi un renouvellement a échoué, s'il a échoué : « refusé »,
       « anonyme », « illisible ». Dit dans le journal de la bibliothèque. */
    refreshState: "",
    refreshing: null,

    /** Le jeton n'est plus bon : on l'oublie avant d'en redemander un. */
    forgetToken: function () {
      this.authToken = "";
      this.tokenAt = 0;
      this.tokenHost = "";
    },

    /**
     * **Le jeton, redemandé à la page du lecteur.**
     *
     * La capture n'attrape que les requêtes que la page a déjà faites : sur un
     * téléphone dont la bibliothèque échoue, le jeton manquait ou était refusé —
     * et il n'y avait alors aucun moyen de s'en sortir sans se reconnecter.
     * La page du lecteur sait donner son propre jeton (`/get_access_token`,
     * même origine, donc pas de contrôle d'accès). S'il est **anonyme**, c'est
     * le lecteur qui n'est pas connecté : on le dit au lieu de faire semblant.
     */
    refreshToken: function () {
      var self = this;
      if (this.refreshing) return this.refreshing;
      /* Pas de `fetch` (page nue, vieux moteur) : on ne peut rien demander, et
         on le dit — plutôt que de lever une exception au milieu du rendu. */
      if (typeof fetch !== "function") {
        this.refreshState = "indisponible";
        return Promise.resolve(false);
      }
      this.refreshing = fetch("/get_access_token?reason=transport&productType=web_player", {
        credentials: "same-origin",
      }).then(
        function (r) {
          return r && r.ok ? r.json() : null;
        },
        function () {
          return null;
        }
      ).then(function (data) {
        self.refreshing = null;
        if (!data || !data.accessToken) {
          self.refreshState = "refusé";
          return false;
        }
        if (data.isAnonymous) {
          self.refreshState = "anonyme";
          return false;
        }
        self.refreshState = "ok";
        self.authToken = /^Bearer /.test(data.accessToken)
          ? data.accessToken
          : "Bearer " + data.accessToken;
        self.tokenAt = Date.now();
        self.tokenHost = location.host;
        return true;
      });
      return this.refreshing;
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
      this.keepAll(h);
      var ct = this.header(h, "Client-Token");
      if (ct && ct !== this.clientToken) this.clientToken = ct;
      var at = this.header(h, "Authorization");
      if (at && at !== this.authToken) {
        this.authToken = at;
        this.tokenAt = Date.now();
        this.tokenHost = (/([a-z0-9.-]+\.spotify\.com)/i.exec(String(url)) || [])[1] || "";
      }
      var m = this.RE_CONNECT.exec(url);
      if (m && m[2]) {
        this.devId = m[2];
        this.uri = m[1];
      }
    },
    /** Garde ce qui compte, quelle que soit la forme des en-têtes reçus. */
    keepAll: function (h) {
      if (!h) return;
      var self = this;
      try {
        if (typeof h.forEach === "function") {
          h.forEach(function (value, name) {
            self.keepHeader(name, value);
          });
          return;
        }
        if (h.length && typeof h.length === "number" && typeof h[0] !== "string") {
          for (var j = 0; j < h.length; j++) if (h[j]) self.keepHeader(h[j][0], h[j][1]);
          return;
        }
        for (var k in h) self.keepHeader(k, h[k]);
      } catch (e) {}
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

