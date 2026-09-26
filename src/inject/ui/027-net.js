  /* ------------------------------------------------------------------ *
   * 11e-quinquies-bis. Net — les appels à l'API du lecteur
   *
   * Constaté le 25/09 sur le téléphone : la page de bibliothèque s'affichait
   * mais annonçait « Votre bibliothèque n'a pas répondu pour l'instant »,
   * avec un jeton pourtant bien capté. La cause est dans la console de la
   * vraie page : le `fetch` du navigateur vers `api.spotify.com` **depuis**
   * `open.spotify.com` est refusé par le contrôle d'accès (l'API répond au
   * contrôle préalable sans en-tête `Access-Control-Allow-Origin`), donc la
   * requête n'aboutit jamais.
   *
   * L'application sait déjà faire ces requêtes **elle-même** : `AndBridge.nFetch`
   * est la voie que l'interface d'origine utilise pour ses appels de lecture
   * (mêmes en-têtes, mêmes cookies, hors navigateur). Un appel natif ne connaît
   * pas le CORS : la bibliothèque et l'historique d'écoute passent par là
   * d'abord, et retombent sur `fetch` quand il n'y a pas de pont (banc de test,
   * navigateur de bureau).
   *
   * Rien n'échoue en silence : la raison exacte (code HTTP, jeton refusé,
   * requête bloquée, pont indisponible) est gardée dans `Net.reason` et
   * affichée sur la page — une capture suffit alors à savoir ce qui manque.
   * ------------------------------------------------------------------ */
  var API_ROOT = "https://api.spotify.com/v1";
  var Net = {
    /* « pont » (natif) ou « navigateur » — d'où a répondu la dernière requête. */
    via: "",
    status: 0,
    reason: "",
    at: 0,
    /* Les requêtes en attente d'une réponse du pont : `id` → résolveur. */
    pending: {},
    ids: 0,
    /* Sans réponse du pont, on rend la main au bout de ce délai. */
    timeoutMs: 12000,
    /* Le pont s'est tu : inutile de refaire attendre chaque appel suivant. */
    asyncDead: false,
    /* Les derniers essais, en clair : « /me → pont 401 ». C'est ce que la page
       montre quand elle n'a rien à afficher — une capture dit alors tout. */
    history: [],
    path: "",

    hasBridge: function () {
      return Bridge.has("nFetch");
    },

    /* La voie **non bloquante** : c'est celle que la coque utilise. `nFetch`
       s'exécute sur le fil JavaScript de la WebView — la page entière attend le
       réseau, les boutons du lecteur ne répondent plus. */
    hasAsync: function () {
      return Bridge.has("nFetchAsync");
    },

    /** Android rappelle ici : `window.__sdNet(id, {status, body})`. */
    install: function () {
      var self = this;
      window.__sdNet = function (id, raw) {
        return self.answer(id, raw);
      };
    },

    answer: function (id, raw) {
      var finish = this.pending[id];
      if (!finish) return false;
      var answer = null;
      try {
        answer = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {
        answer = null;
      }
      if (!answer || typeof answer !== "object") {
        finish({ status: 0, data: null, why: "réponse du pont illisible", bridge: true });
        return true;
      }
      var status = Number(answer.status) || 0;
      if (status !== 200) {
        finish({ status: status, data: null, why: Net.statusWhy(status), bridge: true });
        return true;
      }
      var data = null;
      try {
        data = JSON.parse(answer.body || "null");
      } catch (e) {
        data = null;
      }
      if (!data || typeof data !== "object") {
        finish({ status: status, data: null, why: "réponse illisible (JSON)", bridge: true });
        return true;
      }
      finish({ status: status, data: data, why: "", bridge: true });
      return true;
    },

    throughBridgeAsync: function (url, token) {
      var self = this;
      var id = "n" + ++this.ids + "-" + this.at;
      return new Promise(function (resolve) {
        var settled = false;
        var finish = function (r) {
          if (settled) return;
          settled = true;
          delete self.pending[id];
          resolve(r);
        };
        self.pending[id] = finish;
        setTimeout(function () {
          if (!self.pending[id]) return;
          /* Muet : on le retient, pour que les appels suivants ne fassent pas
             attendre à leur tour. */
          self.asyncDead = true;
          finish({
            status: 0,
            data: null,
            why: "le pont n'a pas répondu (" + Math.round(self.timeoutMs / 1000) + " s)",
            bridge: true,
            dead: true,
          });
        }, self.timeoutMs);
        try {
          Bridge.call(
            "nFetchAsync",
            id,
            url,
            JSON.stringify({ method: "GET", headers: self.requestHeaders(false) })
          );
        } catch (e) {
          finish({ status: 0, data: null, why: "pont indisponible", bridge: true });
        }
      });
    },

    /**
     * Une réponse JSON de l'API, ou `null`. Jamais d'exception : l'appelant
     * décide de ce qu'il montre, et `Net.reason` dit pourquoi c'est vide.
     */
    get: function (path) {
      var self = this;
      var url = /^https?:\/\//.test(path) ? path : API_ROOT + path;
      var token = Api.authToken;
      this.at = Date.now();
      this.path = path;
      this.via = "";
      this.status = 0;
      this.reason = "";
      if (!token) {
        this.reason = "jeton absent";
        this.trace("", 0, "jeton absent");
        return Promise.resolve(null);
      }
      var bridge = null;
      if (this.hasAsync()) bridge = this.throughBridgeAsync(url, token);
      else if (this.hasBridge()) bridge = Promise.resolve(this.throughBridge(url, token));
      if (!bridge) return this.throughFetch(url, token).then(function (r) { return self.accept(r); });
      return bridge.then(function (r) {
        if (r && r.data) return self.accept(r);
        /* Le pont est **muet** : la voie du navigateur ne le remplacera pas —
           elle est refusée par le contrôle d'accès — donc on ne fait pas
           attendre quelqu'un pour rien. */
        if (r && r.dead) {
          self.via = "";
          self.status = 0;
          self.reason = r.why;
          self.trace("pont", 0, r.why);
          return null;
        }
        return self.throughFetch(url, token).then(function (f) {
          if (f && f.data) return self.accept(f);
          self.holdReason(f, r);
          return null;
        });
      });
    },

    /**
     * L'enveloppe de la requête : **celle de la page**, plus le jeton.
     *
     * Le pont natif recopie ces en-têtes tels quels (il écarte seulement ceux
     * qu'il régénère lui-même) : lui donner les mêmes que le lecteur, c'est
     * parler à Spotify comme le lecteur lui parle.
     */
    requestHeaders: function (browser) {
      var headers = Api.apiHeaders(browser);
      if (!headers.authorization && Api.authToken) headers.authorization = Api.authToken;
      return headers;
    },

    /** La première réponse utile : on retient par où elle est venue. */
    accept: function (r) {
      this.via = r && r.bridge ? "pont" : "navigateur";
      this.status = (r && r.status) || 0;
      this.reason = "";
      this.trace(this.via, this.status, "");
      return r ? r.data : null;
    },

    /** Un essai retenu, pour pouvoir le montrer. */
    trace: function (via, status, why) {
      if (!this.path) return;
      this.history.push({ path: this.path, via: via, status: status, why: why || "" });
      if (this.history.length > 8) this.history = this.history.slice(-8);
    },

    /** « /me → pont 401 (jeton refusé (401)) » — la dernière tentative par appel. */
    logLines: function () {
      var seen = {};
      var lines = [];
      for (var i = this.history.length - 1; i >= 0; i--) {
        var h = this.history[i];
        if (seen[h.path]) continue;
        seen[h.path] = 1;
        var where = h.via === "pont" ? "pont" : h.via === "navigateur" ? "navigateur" : "aucune voie";
        lines.push(h.path + " → " + where + (h.status ? " " + h.status : "") + (h.why ? " · " + h.why : ""));
      }
      return lines.reverse();
    },

    /** La raison, sans se répéter : celle du pont puis celle du navigateur. */
    holdReason: function (browser, bridge) {
      var parts = [];
      [bridge, browser].forEach(function (r) {
        if (!r || !r.why || parts.indexOf(r.why) >= 0) return;
        parts.push(r.why);
      });
      this.reason = parts.join(" · ");
      this.status = (browser && browser.status) || (bridge && bridge.status) || 0;
      this.trace(browser ? "navigateur" : "pont", this.status, this.reason);
    },

    /** La voie native : hors navigateur, donc sans contrôle d'accès. */
    throughBridge: function (url, token) {
      void token;
      var raw = Bridge.call(
        "nFetch",
        url,
        JSON.stringify({ method: "GET", headers: this.requestHeaders(false) })
      );
      if (typeof raw !== "string" || !raw) return null;
      var answer = null;
      try {
        answer = JSON.parse(raw);
      } catch (e) {
        return { status: 0, data: null, why: "réponse du pont illisible" };
      }
      if (!answer || typeof answer !== "object") {
        return { status: 0, data: null, why: "réponse du pont vide" };
      }
      var status = Number(answer.status) || 0;
      if (status !== 200) {
        return { status: status, data: null, why: Net.statusWhy(status) };
      }
      var data = null;
      try {
        data = JSON.parse(answer.body || "null");
      } catch (e) {
        data = null;
      }
      if (!data || typeof data !== "object") {
        return { status: status, data: null, why: "réponse illisible (JSON)" };
      }
      return { status: status, data: data, why: "", bridge: true };
    },

    /** La voie du navigateur : celle du banc, et le repli sans pont. */
    throughFetch: function (url, token) {
      if (!window.fetch) return Promise.resolve({ status: 0, data: null, why: "navigateur sans fetch" });
      return window.fetch(url, { headers: this.requestHeaders(true) }).then(
        function (r) {
          if (!r) return { status: 0, data: null, why: "aucune réponse" };
          if (!r.ok) return { status: r.status, data: null, why: Net.statusWhy(r.status) };
          return r.json().then(
            function (data) {
              return { status: r.status, data: data, why: "" };
            },
            function () {
              return { status: r.status, data: null, why: "réponse illisible (JSON)" };
            }
          );
        },
        function (e) {
          var msg = String((e && e.message) || e || "");
          var blocked = /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
          return {
            status: 0,
            data: null,
            why: blocked ? "requête bloquée par le navigateur (contrôle d'accès)" : "échec réseau",
          };
        }
      );
    },

    statusWhy: function (status) {
      if (status === 419) return "jeton expiré (419)";
      if (status === 401) return "jeton refusé (401)";
      if (status === 403) return "accès refusé (403)";
      if (status === 429) return "trop de requêtes (429)";
      if (status >= 500) return "Spotify a répondu " + status;
      if (status > 0) return "Spotify a répondu " + status;
      return "pas de réponse (réseau)";
    },

    /** En une ligne : par où on est passé, et ce qui a manqué. */
    describe: function () {
      if (this.reason) return "aucune réponse : " + this.reason;
      if (!this.via) return "aucun appel encore";
      return "réponse par " + this.via + (this.status ? " (" + this.status + ")" : "");
    },
  };

  var LIBRARY_API = API_ROOT;
  /** Combien de temps une lecture de la bibliothèque reste bonne. */
  var LIBRARY_TTL = 10 * 60 * 1000;
  var LIBRARY_PAGE = 50;
  /* Ouverture d'une page (voir le module `Open`) : on vérifie que la page a
     suivi, trois fois, à 700 ms — puis on navigue pour de vrai. */
  var OPEN_STEP = 700;
  var OPEN_TRIES = 3;
  var OPEN_LIMIT = 8000;
  /* Les dernières lignes lues, gardées sur l'appareil : c'est ce qui affiche la
     bibliothèque **tout de suite** à la deuxième ouverture (et après un
     rechargement de page), sans attendre le réseau. */
  var LIBRARY_CACHE_KEY = "sd.library.cache";
  var LIBRARY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  /* **Version du cache.** La 2.11.11 y a écrit les playlists ramassées dans
     toute la page (recommandations comprises) : « il y a des playlists qui ne
     sont pas les miennes ». Un cache d'avant cette version est donc ignoré —
     sinon il réafficherait exactement ce qu'on vient de retirer. */
  var LIBRARY_CACHE_VERSION = 2;

  var Library = {
    el: null,
    built: false,
    items: [],
    counts: { playlist: 0, album: 0, artist: 0, show: 0, liked: 0 },
    /* idle | loading | ready | empty | no-token | guest | error */
    state: "idle",
    /* La bibliothèque vient-elle de la liste de Spotify (repli) ? */
    fromSidebar: false,
    /* Où la liste de Spotify a été trouvée, et si on a dû la déplier. */
    scan: [],
    woke: "",
    woken: false,
    /* Le rafraîchissement par l'API tourne-t-il ? Ce qu'on montre avant qu'il
       réponde, et ce qu'on a lu du cache. */
    refreshing: false,
    keep: [],
    cached: false,
    cache: [],
    cacheRead: false,
    /* Le compte est-il bien celui du jeton ? (`/me`) */
    account: "",
    accountId: "",
    /* Playlists et albums de la page écartés parce qu'ils ne sont pas au
       compte (recommandations de l'accueil). */
    ignored: 0,
    loading: false,
    loadedAt: 0,
    filter: "all",
    timer: 0,
    tries: 0,
    /* Où en est la lecture : « (2/5) » — un chargement qui n'avance plus doit se
       voir, pas rester une phrase immobile. */
    step: 0,
    steps: 5,
    /* Aucune lecture ne reste en l'air plus longtemps que ça. */
    deadlineMs: 25000,
    deadline: 0,

    /** Une requête de l'API du lecteur — par le pont natif quand il existe
        (hors navigateur, donc sans contrôle d'accès), `fetch` sinon. */
    get: function (path) {
      return Net.get(path);
    },

    /** Une pochette : la plus grande disponible, jamais l'icône 64 px. */
    cover: function (obj) {
      var list = (obj && obj.images) || [];
      if (!list.length) return "";
      var best = list[0];
      for (var i = 1; i < list.length; i++) {
        if ((list[i].width || 0) > (best.width || 0)) best = list[i];
      }
      return best.url || "";
    },

    /** Les lignes de la bibliothèque, à partir des cinq réponses de l'API. */
    parse: function (res) {
      var rows = [];
      var liked = res[4];
      var me = this.accountId;
      if (liked && liked.total) {
        rows.push({
          type: "liked",
          name: Settings.labels.libraryLiked,
          sub: Settings.labels.libraryTracks.replace("%s", liked.total),
          href: "/collection/tracks",
          img: "",
        });
      }
      ((res[0] && res[0].items) || []).forEach(function (pl) {
        if (!pl || !pl.id) return;
        /* **À qui est cette playlist ?** `/me/playlists` rend celles du compte
           (les vôtres) **et** celles que vous suivez. On le dit sur la ligne au
           lieu de laisser croire que tout est à soi — c'est la demande du
           25/09 : « qu'il n'y ait que mes playlists ». */
        var owner = (pl.owner && pl.owner.id) || "";
        var mine = !!(me && owner && owner === me);
        rows.push({
          type: "playlist",
          name: pl.name || "",
          sub: mine
            ? Settings.labels.libraryMine
            : (pl.owner && pl.owner.display_name
                ? Settings.labels.libraryFollowed.replace("%s", pl.owner.display_name)
                : Settings.labels.libraryPlaylists),
          href: "/playlist/" + pl.id,
          img: Library.cover(pl),
          mine: mine,
        });
      });
      ((res[1] && res[1].items) || []).forEach(function (entry) {
        var al = entry && entry.album;
        if (!al || !al.id) return;
        rows.push({
          type: "album",
          name: al.name || "",
          sub: ((al.artists || [])[0] || {}).name || "",
          href: "/album/" + al.id,
          img: Library.cover(al),
        });
      });
      ((res[2] && res[2].items) || []).forEach(function (ar) {
        if (!ar || !ar.id) return;
        rows.push({
          type: "artist",
          name: ar.name || "",
          sub: (ar.genres || [])[0] || Settings.labels.libraryArtists,
          href: "/artist/" + ar.id,
          img: Library.cover(ar),
        });
      });
      ((res[3] && res[3].items) || []).forEach(function (entry) {
        var sh = entry && entry.show;
        if (!sh || !sh.id) return;
        rows.push({
          type: "show",
          name: sh.name || "",
          sub: sh.publisher || "",
          href: "/show/" + sh.id,
          img: Library.cover(sh),
        });
      });
      return rows;
    },

    /**
     * **La liste de Spotify, lue dans la page.**
     *
     * Repli quand l'API du lecteur ne répond pas : la barre latérale est déjà
     * remplie par Spotify, avec le compte de l'utilisateur, et sans jeton ni
     * requête réseau de notre part. On en tire les mêmes lignes (titre, type,
     * adresse, pochette) — moins complètes que l'API, mais **vraies**, et elles
     * mènent au bon endroit.
     */
    /**
     * **La bibliothèque de l'utilisateur, pas la page.**
     *
     * Signalé : « les playlists sont beaucoup trop nombreuses, il y a des
     * playlists qui ne sont pas les miennes ». La lecture avait été élargie à
     * toute la page (rangées de l'accueil, recommandations, « Écoutés
     * récemment ») : elle ramassait donc les playlists **de Spotify** en même
     * temps que celles du compte. On ne lit plus que les zones qui portent la
     * bibliothèque : la barre latérale du lecteur et le panneau latéral, tous
     * deux intitulés « Votre bibliothèque ». Le reste de la page est ignoré —
     * et on le compte, pour pouvoir le dire.
     */
    fromSpotifyList: function () {
      /* Trois endroits peuvent porter vos playlists : les surfaces de la
         bibliothèque (barre latérale, panneau) — tout y est au compte —, les
         **rangées « Vos playlists »** de l'accueil, et, ailleurs dans la page,
         les cartes qui **disent** qu'elles sont à vous ou qui mènent à vos
         titres likés. Tout le reste est écarté : une playlist recommandée par
         Spotify n'est pas une playlist de votre compte, et « il y en a qui ne
         sont pas les miennes » ne doit plus arriver. */
      var self = this;
      var page = pick(SEL.mainView);
      this.ignored = 0;
      /* **La bibliothèque se reconnaît à ce qu'elle dit**, pas seulement à ses
         identifiants : le 25/09, la lecture ne sortait plus des zones connues
         (`#Desktop_LeftSidebar_Id`, panneau) — et sur un téléphone dont la
         disposition a changé, cela pouvait vouloir dire « aucune playlist » sur
         une page qui les affichait toutes. Un conteneur qui porte le mot
         (« Votre bibliothèque », `data-testid` qui le dit, `aria-label` qui le
         dit) et qui contient des playlists **est** la bibliothèque. */
      var scopes = this.libraryScopes();
      var trusted = scopes.slice();
      var shelves = this.mineShelves();
      this.shelves = shelves.length;
      shelves.forEach(function (node) {
        if (scopes.indexOf(node) < 0) scopes.push(node);
      });
      /* La page entière est parcourue, mais **seuls** y sont prises les lignes
         qui prouvent qu'elles sont à vous ; les autres sont comptées. */
      if (page) scopes.push(page);
      var rows = [];
      var seen = {};
      this.scan = [];
      scopes.forEach(function (scope) {
        if (rows.length >= 100) return;
        var before = rows.length;
        /* `scopeIsMine` : la zone est une rangée « Vos playlists » repérée par
           son titre — tout ce qu'elle contient est à vous. */
        var scopeIsMine = !!(scope.getAttribute && scope.getAttribute("data-sd-mine") === "1");
        var fromLibrary = trusted.indexOf(scope) >= 0 || scopeIsMine;
        var fromPage = scope === page;
        var links = scope.querySelectorAll(
          'a[href^="/playlist/"], a[href^="/album/"], a[href^="/artist/"], a[href^="/show/"], a[href^="/collection"]'
        );
        for (var i = 0; i < links.length && rows.length < 100; i++) {
          var a = links[i];
          /* Jamais les nôtres : notre page mène aussi aux playlists. */
          if (a.closest && a.closest(".sd-layer")) continue;
          if (fromPage && a.closest && a.closest("#Desktop_LeftSidebar_Id, #Desktop_PanelContainer_Id")) continue;
          var href = (a.getAttribute("href") || "").split("?")[0];
          if (!href || seen[href]) continue;
          var type = "";
          if (/^\/playlist\//.test(href)) type = "playlist";
          else if (/^\/album\//.test(href)) type = "album";
          else if (/^\/artist\//.test(href)) type = "artist";
          else if (/^\/show\//.test(href)) type = "show";
          else if (/collection/.test(href)) type = "liked";
          if (!type) continue;
          /* Hors des surfaces de la bibliothèque, il faut une preuve : la rangée
             est à vous, la carte porte le nom du compte, ou ce sont vos titres
             likés. Sans preuve → écartée (et comptée si elle vient de la page). */
          if (!fromLibrary && type !== "liked" && !self.isMineCard(a)) {
            if (fromPage) self.ignored++;
            continue;
          }
          var name = self.linkName(a, type);
          if (!name) continue;
          seen[href] = 1;
          var img = a.querySelector("img");
          rows.push({
            type: type,
            name: name.split("\n")[0].slice(0, 80),
            /* Lues dans **votre** bibliothèque : c'est ce que dit le sous-titre
               quand la page ne donne pas mieux (l'API, elle, nomme l'auteur). */
            sub: (name.split("\n")[1] || "").trim().slice(0, 80) || Settings.labels.libraryInYours,
            href: href,
            img: img ? img.currentSrc || img.src || "" : "",
          });
        }
        /* Le journal doit dire **d'où** vient chaque ligne : une source mal
           nommée (« corps ») ferait croire à une lecture large qui n'existe
           plus. */
        var label =
          scope === pick(SEL.sidebar)
            ? "barre latérale"
            : scope === pick(SEL.panel)
            ? "panneau"
            : fromPage
            ? "page (à vous)"
            : scopeIsMine
            ? "rangée à vous"
            : "bibliothèque";
        if (rows.length > before) self.scan.push(label + " " + (rows.length - before));
      });
      return rows;
    },

    /**
     * **Où est la bibliothèque ?** Les repères historiques d'abord, puis tout
     * conteneur qui se présente comme la bibliothèque : un titre, un
     * `data-testid`, un `aria-label` qui porte le mot, et des playlists dedans.
     * La disposition du web player change (et n'est pas la même sur un
     * téléphone) : une liste d'identifiants en dur, c'est zéro ligne lue le jour
     * où Spotify renomme son conteneur.
     */
    libraryScopes: function () {
      var found = [];
      var self = this;
      var add = function (node, known) {
        if (!node || found.indexOf(node) >= 0) return;
        if (!node.querySelector) return;
        if (!node.querySelector("a[href^='/playlist/'], a[href^='/album/'], a[href^='/collection/']")) return;
        if (!known) {
          var head = node.querySelector("h1, h2, h3, [role='heading']");
          var hay = (
            (node.getAttribute("aria-label") || "") +
            " " +
            (node.getAttribute("data-testid") || "") +
            " " +
            (head ? head.textContent || "" : "")
          ).toLowerCase();
          /* « bibliothèque » / « your library » : le mot qui décide. */
          if (!/biblioth|library/.test(hay)) return;
        }
        found.push(node);
      };
      add(pick(SEL.sidebar), true);
      add(pick(SEL.panel), true);
      var candidates = document.querySelectorAll(
        '[data-testid*="librar" i], [data-testid*="collect" i], [aria-label*="iblioth" i], [aria-label*="ibrary" i], nav, aside, [role="navigation"]'
      );
      var max = Math.min(candidates.length, 60);
      var i;
      for (i = 0; i < max && found.length < 10; i++) add(candidates[i], false);
      /* **Et par le titre.** Une bibliothèque peut n'avoir aucun repère
         technique : c'est son titre qui la nomme (« Votre bibliothèque »), et
         le conteneur qui la porte est le plus proche ancêtre qui contient des
         playlists. C'est ainsi que la barre latérale se présente elle-même. */
      var heads = document.querySelectorAll("h1, h2, h3, [role='heading']");
      var cap = Math.min(heads.length, 400);
      for (i = 0; i < cap && found.length < 10; i++) {
        var text = (heads[i].textContent || "").trim();
        if (!text || text.length > 40) continue;
        if (!/biblioth|library/i.test(text)) continue;
        var node = heads[i];
        var walk = 0;
        while (node && node !== document.body && walk < 6) {
          if (node.querySelector && node.querySelector("a[href^='/playlist/'], a[href^='/album/'], a[href^='/collection/']")) break;
          node = node.parentElement;
          walk++;
        }
        if (node && node !== document.body) add(node, true);
      }
      this.scopes = found.length;
      return found;
    },

    /**
     * **Les rangées de *vos* playlists.** Spotify met en avant vos propres
     * playlists dans une rangée de l'accueil (« Vos playlists », « Your
     * playlists ») — celle-là est à vous, contrairement aux rangées de
     * recommandations qui l'entourent. On la repère par son titre et on la
     * marque (`data-sd-mine`) ; le reste de l'accueil reste dehors.
     */
    mineShelves: function () {
      var root = pick(SEL.mainView);
      if (!root) return [];
      var found = [];
      var heads = root.querySelectorAll("h2, h3, [role='heading'], span, div");
      var max = 0;
      for (var i = 0; i < heads.length && max < 400; i++, max++) {
        var text = (heads[i].textContent || "").trim();
        if (!text || text.length > 40) continue;
        if (!/^(vos|tes|mes|your|my)\s+(playlists?|titres lik[eé]s|liked songs)/i.test(text)) continue;
        /* La rangée, c'est le plus proche ancêtre qui la contient en entier. */
        var node = heads[i];
        var walk = 0;
        while (node && node !== root && walk < 6) {
          if (node.querySelector && node.querySelector("a[href^='/playlist/'], a[href^='/collection/tracks']")) break;
          node = node.parentElement;
          walk++;
        }
        if (node && node !== root && found.indexOf(node) < 0) {
          node.setAttribute("data-sd-mine", "1");
          found.push(node);
        }
      }
      return found;
    },

    /** Cette carte dit-elle qu'elle est à vous ? Le nom du compte y figure. */
    isMineCard: function (a) {
      var href = (a.getAttribute("href") || "").split("?")[0];
      if (/^\/collection\/tracks/.test(href)) return true;
      var who = this.account || this.accountId || "";
      if (!who) return false;
      /* Le nom du compte, tel que la page l'écrit (la carte se termine souvent
         par « Playlist · Votre nom », la rangée par « Vos playlists »). */
      var hay = ((a.getAttribute("aria-label") || "") + " " + (a.textContent || "")).toLowerCase();
      return hay.indexOf(String(who).toLowerCase()) >= 0;
    },

    /**
     * Le nom d'une ligne de Spotify. Le libellé complet est préférable (`aria-label`),
     * mais la barre latérale n'en pose pas toujours : on prend alors le texte,
     * et à défaut une infobulle. Pas de nom → pas de ligne : une liste de lignes
     * vides ne serait pas « reconnaître ses playlists ».
     */
    linkName: function (a, type) {
      var name = (a.getAttribute("aria-label") || "").trim();
      if (!name) {
        var title = a.getAttribute("title") || "";
        var inner = a.querySelector('[data-testid="card-title"], .wrapped-ellipsis, p, span, div');
        name = (title || (inner ? inner.textContent : "") || a.textContent || "").replace(/\s+/g, " ").trim();
      }
      if (!name && type === "liked") name = Settings.labels.libraryLiked;
      /* Spotify écrit le nom accessible en entier — « Mes tubes · Playlist ·
         Moi », « Album Un · Album · Artiste » — alors que le titre est la
         première partie : sans ce nettoyage, la bibliothèque afficherait la
         phrase complète à la place du nom. */
      name = name.replace(/\s*[·•|]\s*(playlist|album|artiste|artist|podcast|émission|show|single|compilation|titre|song)\b.*$/i, "").trim();
      return name || (a.getAttribute("aria-label") || "").trim();
    },

    /**
     * **Demander à Spotify de remplir sa liste.**
     *
     * Sur un téléphone, la barre latérale est étroite : Spotify la garde
     * repliée et ne rend alors pas les lignes de la bibliothèque (elles
     * n'existent pas dans le document). Déplier la barre — l'appui que
     * l'utilisateur ferait lui-même — fait rendre la liste, et notre page peut
     * alors la lire. On le fait une fois, sans bruit, et on relit après.
     */
    wake: function () {
      if (this.woken || !Settings.libraryBoard) return false;
      this.woken = true;
      var candidates = [];
      try {
        candidates = document.querySelectorAll(
          '#Desktop_LeftSidebar_Id button, #Desktop_LeftSidebar_Id [role="button"], button[aria-label]'
        );
      } catch (e) {
        candidates = [];
      }
      for (var i = 0; i < candidates.length; i++) {
        var b = candidates[i];
        if (b.closest && b.closest(".sd-layer")) continue;
        var label = (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
        if (!label) continue;
        if (!/(bibliothèque|library|développer|developper|agrandir|expand|voir plus|show more)/i.test(label)) continue;
        if (b.getAttribute("aria-expanded") === "true") continue;
        try {
          b.click();
        } catch (e) {
          continue;
        }
        this.woke = label.slice(0, 40);
        return true;
      }
      return false;
    },

    /**
     * **« Le truc avec mes titres likés » — toujours en tête.**
     *
     * L'entrée des titres likés vient du total annoncé par l'API ; quand elle
     * manque (API muette, ou liste lue dans la page), la ligne existait quand
     * même chez Spotify et l'utilisateur l'attend : on la pose, en tête, sans
     * chiffre plutôt que de la faire disparaître.
     */
    ensureLiked: function (rows) {
      var list = rows || [];
      if (!list.length) return list;
      /* **Une seule entrée « Titres likés », et la même pour tout le monde.**
         Signalé le 25/09 : deux lignes « Titres likés » se suivaient dans la
         liste (la nôtre, puis celle que Spotify affiche lui-même et que le
         repli relit dans la page). La liste est donc remise d'aplomb ici, à
         l'endroit par lequel passent toutes les sources : les doublons de
         titre et d'adresse tombent, l'entrée des titres likés reste **en
         tête**, et elle garde son chiffre quand l'API l'a donné. */
      var liked = null;
      var propres = [];
      var vues = {};
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (!row) continue;
        if (row.type === "liked") {
          if (!liked) liked = row;
          continue;
        }
        var cle = row.type + "|" + (row.href || row.name || "");
        if (vues[cle]) continue;
        vues[cle] = 1;
        propres.push(row);
      }
      /* Pas de « vos titres likés » pour un lecteur dont on **sait** qu'il n'est
         pas connecté. Mais quand la page montre déjà votre bibliothèque, cette
         entrée en fait partie : on ne la laisse pas manquer sous prétexte que
         l'API n'a pas répondu (c'est exactement le cas où l'on vient de lire
         vos playlists dans la page). */
      if (!liked && !this.account && this.accountState() === "out") return propres;
      if (!liked) {
        liked = {
          type: "liked",
          name: Settings.labels.libraryLiked,
          sub: Settings.labels.libraryLikedHint,
          href: "/collection/tracks",
          img: "",
        };
      }
      propres.unshift(liked);
      return propres;
    },

    /** Relit la liste de Spotify après un rendu, sans bloquer la page. */
    retrySidebar: function (delay) {
      var self = this;
      setTimeout(function () {
        /* Ne remplace jamais des lignes déjà affichées : quand elles viennent du
           cache, la relecture sert seulement à les rafraîchir si la liste de
           Spotify en montre plus. */
        if (self.items.length && !self.cached) return;
        var rows = self.fromSpotifyList();
        if (!rows.length) return;
        self.items = self.ensureLiked(rows);
        self.counts = self.tallyRows(self.items);
        self.fromSidebar = true;
        self.state = "ready";
        self.loadedAt = Date.now();
        self.apply();
        Toast.show(Settings.labels.libraryFromSpotify.replace("%s", String(rows.length)), 2200);
      }, delay || 1200);
    },

    /** Les compteurs, quand les lignes viennent de la liste de Spotify. */
    tallyRows: function (rows) {
      var n = { playlist: 0, album: 0, artist: 0, show: 0, liked: 0 };
      for (var i = 0; i < rows.length; i++) {
        if (n[rows[i].type] !== undefined) n[rows[i].type]++;
      }
      return n;
    },

    /** Les totaux annoncés par l'API (pas seulement la première page). */
    tally: function (res) {
      var n = { playlist: 0, album: 0, artist: 0, show: 0, liked: 0 };
      var keys = ["playlist", "album", "artist", "show", "liked"];
      for (var i = 0; i < 5; i++) {
        var body = res[i];
        if (body && typeof body.total === "number") n[keys[i]] = body.total;
      }
      return n;
    },

    /**
     * Lit la bibliothèque. Silencieux quand il n'y a pas de jeton — c'est le cas
     * d'une session fermée, et il n'y a alors rien à dire : la page de connexion
     * ou l'écran d'accueil maison sont déjà là.
     */
    /**
     * **Afficher d'abord, interroger ensuite.**
     *
     * Signalé : « ça prend du temps à charger pour afficher ». La page attendait
     * la fin de six appels réseau avant de montrer quoi que ce soit — alors que
     * les lignes de Spotify sont **déjà dans la page** et qu'un cache local peut
     * les rendre tout de suite. On montre donc immédiatement ce qu'on a
     * (cache, puis liste de Spotify), et l'API ne sert plus qu'à *enrichir*
     * en arrière-plan. La page n'attend jamais le réseau.
     */
    load: function (force) {
      if (!Settings.libraryBoard) {
        this.items = [];
        this.state = "idle";
        return false;
      }
      if (!force && this.loadedAt && Date.now() - this.loadedAt < LIBRARY_TTL) return false;
      /* 1. Ce qu'on peut montrer **maintenant**, sans réseau. */
      var shown = this.showNow();
      /* 2. Le rafraîchissement par l'API, en arrière-plan. */
      this.refresh(shown);
      return false;
    },

    /** Ce qu'on a sous la main : ce qui est déjà lu, le cache, puis Spotify. */
    showNow: function () {
      if (this.items.length) return true;
      var cached = this.readCache();
      if (cached.length) {
        this.items = cached;
        this.counts = this.tallyRows(cached);
        this.fromSidebar = true;
        this.cached = true;
        this.state = "ready";
        this.scan = ["cache " + cached.length];
        this.apply();
        return true;
      }
      var rows = this.fromSpotifyList();
      if (rows.length) {
        this.items = this.ensureLiked(rows);
        this.counts = this.tallyRows(this.items);
        this.fromSidebar = true;
        this.state = "ready";
        this.apply();
        return true;
      }
      /* Rien de visible : la liste de Spotify est peut-être repliée (téléphone).
         On la déplie une fois — c'est un appui que l'utilisateur ferait — et on
         relit dans la foulée. */
      if (this.wake()) this.retrySidebar(1200);
      /* La barre latérale se remplit **après** notre lecture sur un téléphone :
         sans cela on montrerait « aucune playlist » alors que les vôtres
         arrivent une seconde plus tard (mesuré en CI : 14 liens dans la barre,
         0 ligne chez nous). */
      this.watchList();
      return false;
    },

    /**
     * **Les vôtres arrivent parfois après nous.** La liste de Spotify se remplit
     * avec son propre chargement ; on observe donc les zones de la bibliothèque
     * le temps de les voir se remplir, et on relit à ce moment-là — jamais en
     * boucle (douze relectures au plus, puis on rend la main, et l'observation
     * s'arrête dès qu'il y a des lignes à l'écran).
     */
    watchList: function () {
      if (!window.MutationObserver || this.obsList) return false;
      var self = this;
      var nodes = [pick(SEL.sidebar), pick(SEL.panel), pick(SEL.mainView)].filter(Boolean);
      if (!nodes.length) return false;
      this.rearms = 0;
      this.obsList = new MutationObserver(
        debounce(function () {
          if (State.tab !== "library" || self.items.length) {
            /* C'est rempli : plus rien à observer pour cette visite. */
            if (self.items.length && self.obsList) {
              self.obsList.disconnect();
              self.obsList = 0;
            }
            return;
          }
          if (self.rearms++ >= 12) {
            self.obsList.disconnect();
            self.obsList = 0;
            return;
          }
          self.load(true);
        }, 1200)
      );
      nodes.forEach(function (node) {
        self.obsList.observe(node, { childList: true, subtree: true });
      });
      return true;
    },

    /** Les dernières lignes connues, gardées d'une visite à l'autre. */
    readCache: function () {
      if (this.cacheRead) return this.cache || [];
      this.cacheRead = true;
      try {
        var raw = window.localStorage.getItem(LIBRARY_CACHE_KEY);
        var data = raw ? JSON.parse(raw) : null;
        if (
          data &&
          data.v === LIBRARY_CACHE_VERSION &&
          data.items &&
          data.items.length &&
          Date.now() - (data.at || 0) < LIBRARY_CACHE_TTL
        ) {
          this.cache = data.items.slice(0, 120);
        } else if (data) {
          /* Cache d'une autre version : on le jette au lieu de réafficher des
             playlists qui ne sont pas au compte. */
          this.cache = [];
          try {
            window.localStorage.removeItem(LIBRARY_CACHE_KEY);
          } catch (e) {}
        }
      } catch (e) {
        this.cache = [];
      }
      return this.cache || [];
    },

    writeCache: function () {
      if (!this.items.length || this.fromSidebar) return false;
      try {
        window.localStorage.setItem(
          LIBRARY_CACHE_KEY,
          JSON.stringify({ v: LIBRARY_CACHE_VERSION, at: Date.now(), items: this.items.slice(0, 120) })
        );
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * Le rafraîchissement par l'API : jamais bloquant. S'il aboutit, ses lignes
     * (plus complètes : totaux, pochettes, sous-titres) remplacent celles qu'on
     * montrait ; s'il échoue, ce qu'on montrait reste à l'écran, avec la raison.
     */
    refresh: function (haveRows) {
      var self = this;
      if (this.refreshing) return false;
      if (!Api.authToken) {
        if (!haveRows) {
          /* Rien à montrer et pas de jeton : le dire, puis aller le chercher. */
          this.state = "no-token";
          this.apply();
        }
        if (!Api.refreshState) {
          Api.refreshToken().then(function (ok) {
            if (ok) self.refresh(haveRows);
          });
        }
        return false;
      }
      this.refreshing = true;
      this.keep = this.items.slice();
      this.state = haveRows ? "ready" : "loading";
      if (!haveRows) this.apply();
      /* **Une requête à la fois.** Le pont natif répond de façon bloquante (le
         fil JavaScript attend le réseau) : cinq requêtes lancées d'un coup
         gèleraient l'écran le temps de toutes les attendre. On les enchaîne en
         laissant la page respirer entre deux, et on s'arrête à la première panne
         franche — inutile de faire attendre quelqu'un dont le réseau ne répond
         pas, la page peut tout de suite le dire. */
      var paths = [
        /* **Qui répond ?** `/me` est le seul appel qui distingue le jeton du
           compte d'un jeton **anonyme** du lecteur déconnecté. Sans lui, un
           jeton anonyme fait répondre « Votre compte est vide » — un mensonge
           sur les données de l'utilisateur. */
        "/me",
        "/me/playlists?limit=" + LIBRARY_PAGE,
        "/me/albums?limit=" + LIBRARY_PAGE,
        "/me/artists?limit=" + LIBRARY_PAGE,
        "/me/shows?limit=" + LIBRARY_PAGE,
        "/me/tracks?limit=1",
      ];
      var res = [null, null, null, null, null, null];
      this.step = 0;
      this.steps = paths.length;
      /* **Rien ne reste en chargement indéfiniment.** Le pont natif peut se
         taire (réseau absent, requête qui n'aboutit pas) : au bout du délai, la
         lecture se termine avec ce qu'elle a, et la page le dit. */
      clearTimeout(this.deadline);
      this.deadline = setTimeout(function () {
        if (!self.loading) return;
        Net.reason = Settings.labels.libraryTimeout;
        Net.status = 0;
        finish();
      }, this.deadlineMs);
      var done = false;
      var triedRefresh = false;
      var finish = function () {
        if (done) return;
        done = true;
        clearTimeout(self.deadline);
        self.deadline = 0;
        self.loading = false;
        self.refreshing = false;
        self.loadedAt = Date.now();
        var profile = res[0];
        /* Le nom, pas l'identifiant : c'est ce que l'utilisateur reconnaît
           (« il arrive pas à reconnaître mes playlists »). */
        self.account = profile ? profile.display_name || profile.id || "" : "";
        self.accountId = profile && profile.id ? profile.id : "";
        var sources = res.slice(1);
        var fresh = self.parse(sources);
        var answered = sources.some(function (r) {
          return !!r;
        });
        if (fresh.length) {
          /* L'API a répondu : ses lignes sont plus complètes que le repli, on
             les prend — et on les garde pour la prochaine ouverture. */
          self.items = self.ensureLiked(fresh);
          /* Les totaux de l'API (toute la bibliothèque, pas seulement la page
             lue) : « Titres likés 128 » compte des **titres**, pas des lignes —
             le compte de l'en-tête, lui, compte les lignes affichées. */
          self.counts = self.tally(sources);
          self.fromSidebar = false;
          self.cached = false;
          self.writeCache();
          self.state = "ready";
          self.apply();
          return;
        }
        /* **L'API n'a rien donné : ce qu'on montrait reste.** C'est tout l'objet
           du repli — une page qui se vide alors qu'elle affichait les playlists
           de Spotify une seconde plus tôt serait le pire des comportements. */
        if (self.keep.length) {
          self.items = self.ensureLiked(self.keep);
          self.state = "ready";
          self.apply();
          return;
        }
        self.items = [];
        self.counts = self.tally(sources);
        self.fromSidebar = false;
        if (self.items.length) {
          self.state = "ready";
        } else {
          /* **Repli : la liste de Spotify elle-même.** Elle est déjà sur
             l'écran (c'est elle qui interroge le compte), elle ne dépend ni du
             jeton ni du réseau de l'application. Si l'API ne répond pas, on
             montre ce qu'elle affiche au lieu d'un écran qui dit « rien ». */
          var rows = self.fromSpotifyList();
          if (!rows.length && self.wake()) {
            /* La liste de Spotify va peut-être apparaître : on la relit deux
               fois plutôt que de conclure trop vite (son rendu suit l'appui). */
            self.retrySidebar(1200);
          }
          if (rows.length) {
            /* Par la même remise d'aplomb que les autres sources : c'est par
               ici qu'arrivaient les deux « Titres likés » (celui de Spotify et
               le nôtre), et c'est ici qu'ils tombent. */
            self.items = self.ensureLiked(rows);
            self.counts = self.tallyRows(self.items);
            self.fromSidebar = true;
            self.state = "ready";
          } else if (!self.account) {
            /* Pas de compte derrière le jeton : on ne dit pas « bibliothèque
               vide », on dit que le compte n'est pas accessible. */
            self.state = answered ? "guest" : "error";
          } else if (answered) {
            self.state = "empty";
          } else {
            self.state = "error";
          }
        }
        self.apply();
      };
      var step = function (index) {
        if (index >= paths.length) {
          finish();
          return;
        }
        self.get(paths[index]).then(function (data) {
          res[index] = data;
          self.step = index + 1;
          if (self.loading) self.apply();
          var refused =
            Net.status === 401 || Net.status === 403 || Net.status === 419 || Net.status === 400;
          if (refused && !triedRefresh) {
            /* Le jeton est refusé : on en redemande un à la page, **une fois**,
               puis on relit. Sans ça, la seule issue était de se reconnecter. */
            triedRefresh = true;
            self.loading = false;
            clearTimeout(self.deadline);
            self.deadline = 0;
            Api.forgetToken();
            Api.refreshToken().then(function (ok) {
              if (ok) {
                self.load(true);
                return;
              }
              self.loading = true;
              finish();
            });
            return;
          }
          if (
            !data &&
            index === 0 &&
            (Net.status === 0 || Net.status === 401 || Net.status === 403 || Net.status === 419)
          ) {
            /* Rien n'a répondu — ou le jeton est refusé. Les cinq autres appels
               posent la même question avec le même jeton : ils n'auront pas une
               autre réponse. On va directement au repli (la liste de Spotify) au
               lieu de faire attendre quelqu'un huit secondes pour rien. */
            finish();
            return;
          }
          setTimeout(function () {
            step(index + 1);
          }, 0);
        });
      };
      step(0);
      return true;
    },

    build: function () {
      if (this.built) return true;
      var el = document.createElement("div");
      el.className = "sd-lib";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", Settings.labels.library);
      el.innerHTML =
        '<div class="sd-lib-head">' +
        '<div class="sd-lib-id"><h1 class="sd-lib-title"></h1><span class="sd-lib-sum"></span></div>' +
        '<span class="sd-lib-count" hidden></span>' +
        "</div>" +
        '<div class="sd-lib-chips" role="tablist">' +
        '<button class="sd-chip sd-lib-chip" type="button" role="tab" data-filter="all"></button>' +
        '<button class="sd-chip sd-lib-chip" type="button" role="tab" data-filter="playlist"></button>' +
        '<button class="sd-chip sd-lib-chip" type="button" role="tab" data-filter="album"></button>' +
        '<button class="sd-chip sd-lib-chip" type="button" role="tab" data-filter="artist"></button>' +
        '<button class="sd-chip sd-lib-chip" type="button" role="tab" data-filter="show"></button>' +
        "</div>" +
        '<div class="sd-lib-list"></div>' +
        /* **La phrase d'état, et son icône.** Elle dit pourquoi la liste est ce
           qu'elle est (repli, rien à montrer, panne) : c'est la première chose
           qu'on lit quand la bibliothèque n'est pas celle qu'on attendait. */
        '<p class="sd-lib-note" hidden>' +
        svg(ICONS.infoLine, "sd-lib-note-glyph") +
        '<span class="sd-lib-note-text"></span>' +
        "</p>" +
        /* Le journal des essais : sans lui, « la bibliothèque ne reconnaît pas
           mes playlists » oblige à deviner entre le jeton, le réseau et l'API.
           **Replié par défaut** : c'est un diagnostic, pas la bibliothèque —
           déployé sur huit lignes, il occupait plus d'écran que les playlists. */
        '<details class="sd-lib-log" hidden><summary class="sd-lib-log-title"></summary>' +
        '<ul class="sd-lib-log-list"></ul></details>' +
        '<div class="sd-lib-actions">' +
        '<button class="sd-btn sd-lib-retry" type="button"></button>' +
        /* Sans session, « Réessayer » ne peut rien donner : la porte de sortie
           est la connexion, au même endroit que le bouton de l'accueil. */
        '<a class="sd-btn sd-lib-login" href="' +
        CLASSIC_LOGIN +
        '"></a>' +
        "</div>";
      this.el = el;
      UI.layer.appendChild(el);
      var self = this;
      /* **La hauteur de l'en-tête, mesurée.** Les filtres se collent juste en
         dessous (`top: var(--sd-lib-head-h)`), et cette hauteur dépend de la
         police de l'appareil : la deviner en dur décalerait les puces d'un
         téléphone à l'autre. On la relève, et on la relève encore quand la page
         change de taille (rotation, clavier, densité). */
      var head = $(".sd-lib-head", el);
      var mesure = function () {
        if (!head) return;
        var h = head.getBoundingClientRect().height;
        if (h > 0) el.style.setProperty("--sd-lib-head-h", Math.round(h) + "px");
      };
      this.measureHead = mesure;
      mesure();
      if (window.ResizeObserver && head) {
        try {
          new ResizeObserver(mesure).observe(head);
        } catch (e) {
          /* pas de mesure continue : la valeur posée au montage suffit */
        }
      }
      $$(".sd-lib-chip", el).forEach(function (chip) {
        chip.addEventListener("click", function () {
          self.filter = chip.getAttribute("data-filter") || "all";
          self.render();
        });
      });
      var retry = $(".sd-lib-retry", el);
      if (retry) {
        retry.addEventListener("click", function () {
          /* **Un nouvel essai, vraiment.** `Api.refreshState` garde la trace du
             dernier essai de jeton ; la laisser en place faisait de
             « Réessayer » un bouton muet — aucun appel, aucun changement, juste
             l'air de rien (mesuré au banc, sans session). On efface donc la
             trace, pour que l'essai ait lieu pour de bon. */
          Api.refreshState = "";
          Net.reason = "";
          self.state = "loading";
          self.loadedAt = 0;
          self.apply();
          self.load(true);
        });
      }
      this.built = true;
      return true;
    },

    /** Le résumé en une ligne : ce que contient le compte, en clair. */
    summary: function () {
      var c = this.counts || {};
      var parts = [];
      if (c.playlist) parts.push(Settings.labels.libraryPlaylists + " " + c.playlist);
      if (c.album) parts.push(Settings.labels.libraryAlbums + " " + c.album);
      if (c.artist) parts.push(Settings.labels.libraryArtists + " " + c.artist);
      if (c.show) parts.push(Settings.labels.libraryShows + " " + c.show);
      if (c.liked) parts.push(Settings.labels.libraryLiked + " " + c.liked);
      /* **Le compte en tête** quand on a lu quelque chose : la preuve que
         c'est bien sa bibliothèque, pas celle d'un autre. */
      if (this.account && parts.length) {
        parts.unshift(Settings.labels.libraryAccount.replace("%s", this.account.slice(0, 24)));
      }
      return parts.join(" · ") || Settings.labels.librarySummary;
    },

    /**
     * Le lecteur est-il ouvert sur un compte ? Trois signaux, du plus sûr au
     * moins sûr : le lecteur lui-même (sa page est là), puis la session que
     * connaît l'application. « Je ne sais pas » reste une réponse honnête.
     */
    accountState: function () {
      var state = LoginState.state();
      if (state === "in") return "in";
      if (state === "out" || state === "login") return "out";
      if (Bridge.has("session")) return Bridge.call("session") ? "in" : "out";
      return "?";
    },

    /** Ce qu'il y a à dire quand la liste est vide (jamais un écran muet). */
    note: function () {
      if (this.state === "loading") {
        /* Où en est la lecture, en clair : « (2/6) ». Cet état ne dure que si
           la page n'avait **rien** à montrer : dès qu'il y a des lignes (cache
           ou liste de Spotify), elles sont affichées et la note est celle du
           repli. */
        return this.step
          ? Settings.labels.libraryLoadingProgress.replace("%s", String(this.step)).replace("%s", String(this.steps))
          : Settings.labels.libraryLoading;
      }
      if (this.state === "no-token") return Settings.labels.libraryNoToken;
      if (this.state === "guest") {
        /* Ce que l'on **sait** d'abord : la session. « Pas connecté » est une
           réponse ; « je n'ai pas pu vérifier » en est une autre, et les deux
           valent mieux que « ton compte est vide ». */
        var head =
          this.accountState() === "out" ? Settings.labels.libraryGuest : Settings.labels.libraryUnknown;
        return Net.reason ? head + " " + Settings.labels.libraryWhy.replace("%s", Net.reason) : head;
      }
      /* Jamais un « ça n'a pas marché » muet : la raison exacte est dans le
         message, pour qu'une seule capture suffise à savoir ce qui manque. */
      if (this.state === "error") {
        if (Net.reason === Settings.labels.libraryTimeout) {
          return Settings.labels.libraryTimeout + " " + Settings.labels.libraryWhy.replace("%s", Net.reason);
        }
        return Net.reason
          ? Settings.labels.libraryError + " " + Settings.labels.libraryWhy.replace("%s", Net.reason)
          : Settings.labels.libraryError;
      }
      if (this.state === "empty") return Settings.labels.libraryEmpty;
      if (this.items.length && !this.filtered().length) return Settings.labels.homeEmptyCategory;
      if (this.fromSidebar) {
        var base = Settings.labels.librarySidebar.replace("%s", String(this.items.length));
        /* Et si l'API travaille encore en arrière-plan, on le dit — sans que
           cela retarde quoi que ce soit à l'écran. */
        if (this.refreshing) base += " " + Settings.labels.libraryRefreshing;
        return base;
      }
      return "";
    },

    /** Les lignes visibles avec le filtre courant. */
    filtered: function () {
      var want = this.filter;
      return this.items.filter(function (row) {
        return want === "all" || row.type === want;
      });
    },

    render: function () {
      if (!this.el) return 0;
      $(".sd-lib-sum", this.el).textContent = this.summary();
      var heading = $(".sd-lib-title", this.el);
      if (heading) heading.textContent = Settings.labels.library;
      var names = {
        all: Settings.labels.libraryAll,
        playlist: Settings.labels.libraryPlaylists,
        album: Settings.labels.libraryAlbums,
        artist: Settings.labels.libraryArtists,
        show: Settings.labels.libraryShows,
      };
      var total = this.items.length;
      var parType = {};
      this.items.forEach(function (row) {
        parType[row.type] = (parType[row.type] || 0) + 1;
      });
      $$(".sd-lib-chip", this.el).forEach(function (chip) {
        var key = chip.getAttribute("data-filter");
        var label = names[key] || key;
        var n = key === "all" ? total : parType[key] || 0;
        /* **Le compteur, dans la puce** : il dit ce qu'on va trouver avant
           d'appuyer, et il évite de croire à une bibliothèque vide quand un
           filtre ne montre rien. */
        chip.textContent = "";
        chip.appendChild(document.createTextNode(label + " "));
        var compte = document.createElement("span");
        compte.className = "sd-lib-chip-n";
        compte.textContent = n ? String(n) : "0";
        chip.appendChild(compte);
        var active = key === Library.filter;
        chip.classList.toggle("is-active", active);
        /* Une catégorie vide est **grisée**, pas retirée : la puce dit qu'elle
           existe et qu'il n'y a rien dedans — la faire disparaître ferait
           bouger les autres sous le doigt. */
        chip.classList.toggle("is-empty", !n && !active);
        chip.setAttribute("aria-selected", active ? "true" : "false");
      });
      var list = $(".sd-lib-list", this.el);
      /* **Un filtre qui ne montre rien n'est pas un écran vide** : la liste se
         range et la phrase dit pourquoi (la classe existait dans la feuille,
         personne ne la posait). */
      this.el.classList.toggle("sd-lib-nofilter", !!this.items.length && !this.filtered().length);
      /* **Ne pas reconstruire 82 lignes à chaque repeint.** `render` est appelé
         à chaque changement de vue et à chaque relevé de la bibliothèque :
         recréer toutes les lignes (et redemander toutes les pochettes) à chaque
         fois, c'est ce qui rendait la page saccadée — « c'est encore bugué ».
         On ne rebâtit la liste que si elle doit vraiment changer. */
      var shown = this.filtered();
      var signature =
        this.filter +
        "|" +
        shown.length +
        "|" +
        (shown[0] ? shown[0].href : "") +
        "|" +
        (shown[shown.length - 1] ? shown[shown.length - 1].href : "");
      var sameList = signature === this.renderedSignature;
      /* Le journal : montré seulement quand la page n'a rien à lister. */
      var logBox = $(".sd-lib-log", this.el);
      if (logBox) {
        /* Le journal s'affiche dès que l'**API** a failli : quand la page ne
           liste rien, et aussi quand elle liste les lignes de Spotify — dans ce
           cas, savoir que le jeton a été refusé est justement ce qu'il faut pour
           réparer. */
        var apiTrouble = !this.items.length || this.fromSidebar;
        var lines = apiTrouble ? Net.logLines() : [];
        if (apiTrouble) {
          /* **Ce que la page a gardé de son propre trafic.** Un appel refusé
             s'explique presque toujours ici : sans `client-token`, Spotify
             refuse la requête alors que le jeton est bon. */
          lines.push(Settings.labels.libraryHeaders.replace("%s", Api.headerNames() || "aucun"));
          if (Api.refreshState) {
            lines.push(Settings.labels.libraryTokenRefresh.replace("%s", Api.refreshState));
          }
          if (this.scan && this.scan.length) {
            lines.push(Settings.labels.libraryScan.replace("%s", this.scan.join(" · ")));
          }
          if (this.woke) lines.push(Settings.labels.libraryScan.replace("%s", "barre latérale ouverte : " + this.woke));
          if (this.ignored) {
            lines.push(
              (this.ignored === 1 ? Settings.labels.libraryIgnoredOne : Settings.labels.libraryIgnored).replace(
                "%s",
                String(this.ignored)
              )
            );
          }
        }
        var withToken = !apiTrouble
          ? []
          : [
              /* Le jeton et le compte, avant les essais : si le jeton vient du
                 lecteur **déconnecté**, tout le reste s'explique d'un coup. */
              Settings.labels.libraryTokenAge
                .replace("%s", Api.tokenAt ? Stats.sinceText(Api.tokenAt) : "jamais")
                .replace("%s", this.account ? "compte " + this.account : "pas de compte"),
            ];
        logBox.hidden = !lines.length && !withToken.length;
        var logTitle = $(".sd-lib-log-title", logBox);
        if (logTitle) {
          logTitle.textContent = "";
          logTitle.appendChild(document.createTextNode(Settings.labels.libraryLogHint));
          var count = document.createElement("span");
          count.className = "sd-lib-log-n";
          count.textContent = String(withToken.length + lines.length);
          logTitle.appendChild(count);
          var chev = document.createElement("span");
          chev.className = "sd-lib-log-chev";
          chev.innerHTML = svg(ICONS.chevronDown);
          logTitle.appendChild(chev);
        }
        var logList = $(".sd-lib-log-list", logBox);
        if (logList) {
          logList.textContent = "";
          withToken.concat(lines).forEach(function (text) {
            var li = document.createElement("li");
            li.textContent = text;
            logList.appendChild(li);
          });
        }
      }
      var note = $(".sd-lib-note", this.el);
      var actions = $(".sd-lib-actions", this.el);
      var retry = $(".sd-lib-retry", this.el);
      var message = this.note();
      /* Le texte dans son propre élément : l'icône de la phrase n'est pas
         effacée à chaque repeint (et `textContent` reste exactement le
         message — c'est ce que lisent le banc et la sonde). */
      var noteText = $(".sd-lib-note-text", note);
      if (noteText) noteText.textContent = message;
      else note.textContent = message;
      note.hidden = !message;
      /* Le ton : une **panne** (rouge discret) ne se lit pas comme une simple
         information (« ces lignes viennent de Spotify »). */
      var panne =
        this.state === "no-token" || this.state === "error" || this.state === "guest";
      note.classList.toggle("is-warn", !!message && panne);
      note.classList.toggle("is-info", !!message && !panne);
      /* Quand il n'y a rien à montrer, on dit quoi faire : réessayer, et où
         retrouver la bibliothèque de Spotify si on la préfère. */
      if (retry) retry.textContent = Settings.labels.libraryRetry;
      if (actions) {
        var nothing =
          !!message &&
          (this.state === "no-token" ||
            this.state === "error" ||
            this.state === "empty" ||
            this.state === "guest");
        var login = $(".sd-lib-login", this.el);
        if (login) {
          login.textContent = Settings.labels.librarySignIn;
          /* **La porte de connexion suit le message, pas l'opinion de la
             page.** Elle apparaît exactement quand la bibliothèque explique
             qu'il manque quelque chose (« Connectez-vous… ») — sinon elle est
             rangée. Chercher à deviner l'état de session la cachait justement
             quand on ne savait rien : l'instruction « connectez-vous » était
             affichée sans bouton pour le faire. */
          login.hidden = !nothing;
        }
        actions.hidden = !nothing && (!login || login.hidden);
        if (nothing && retry) retry.setAttribute("aria-label", Settings.labels.libraryRetry + " — " + Settings.labels.libraryHint);
      }
      /* L'en-tête vient peut-être de changer de hauteur (résumé plus long,
         libellés, police de l'appareil) : les filtres se recollent en dessous. */
      if (this.measureHead) this.measureHead();
      /* **Combien de lignes, pour de vrai.** Le compte suit le filtre : « 3 / 12 »
         dit d'un coup d'œil qu'on regarde une partie de la bibliothèque. */
      var badge = $(".sd-lib-count", this.el);
      if (badge) {
        var taille = this.items.length;
        var quoi = shown.length + (this.filter === "all" ? "" : " / " + taille);
        badge.textContent = Settings.labels[taille === 1 ? "libraryCountOne" : "libraryCountMany"].replace("%s", quoi);
        badge.hidden = !taille;
      }
      if (!sameList) list.textContent = "";
      if (sameList) return shown.length;
      shown.forEach(function (row) {
        var link = document.createElement("a");
        link.className = "sd-lib-row sd-lib-row-" + row.type;
        link.href = row.href;
        var art = document.createElement("span");
        art.className = "sd-lib-art";
        if (row.img) {
          var img = document.createElement("img");
          img.src = row.img;
          img.alt = "";
          img.setAttribute("loading", "lazy");
          art.appendChild(img);
        } else {
          /* **Sans pochette, le type se voit quand même.** Un cœur pour tout le
             monde faisait ressembler un album à une playlist ; chaque type a son
             glyphe, et la vignette se lit comme un repère, pas comme une image
             manquante. */
          var glyphes = {
            liked: ICONS.heartSolid,
            playlist: ICONS.musicNote,
            album: ICONS.discLine,
            artist: ICONS.personLine,
            show: ICONS.micLine,
          };
          art.classList.add("is-empty");
          art.innerHTML = svg(glyphes[row.type] || ICONS.musicNote, "sd-lib-glyph");
        }
        var text = document.createElement("span");
        text.className = "sd-lib-text";
        var name = document.createElement("span");
        name.className = "sd-lib-name";
        name.textContent = row.name;
        var sub = document.createElement("span");
        sub.className = "sd-lib-sub";
        sub.textContent = row.sub;
        text.appendChild(name);
        text.appendChild(sub);
        link.appendChild(art);
        link.appendChild(text);
        list.appendChild(link);
      });
      this.renderedSignature = signature;
      return shown.length;
    },

    /**
     * Le chemin sur lequel **notre** bibliothèque a sa place.
     *
     * L'onglet Bibliothèque ne navigue pas : l'URL reste celle d'où l'on vient.
     * Notre page est plein écran, elle doit donc se retirer dès qu'une sous-page
     * s'ouvre (une playlist, un album…) — sinon elle recouvrirait la playlist
     * qu'on vient d'ouvrir depuis elle.
     */
    isLibraryPath: function () {
      if (Home.isHomePath()) return true;
      return /^\/search(\/|$)/.test((location.pathname || "").replace(/\/+$/, ""));
    },

    shouldShow: function () {
      if (!Settings.libraryBoard) return false;
      if (!this.built) return false;
      if (State.tab !== "library") return false;
      if (!this.isLibraryPath()) return false;
      /* **Toujours**, y compris sans données : sur ce téléphone, la barre
         latérale de Spotify ne montre aucune playlist (« je ne vois aucune de
         mes playlists ») — la garder comme repli, c'est laisser un écran noir.
         Notre page, elle, dit toujours où elle en est (chargement, pas de jeton,
         API muette, ou sa liste). */
      return true;
    },

    apply: function () {
      if (!this.build()) return false;
      this.render();
      var show = this.shouldShow();
      this.el.hidden = !show;
      /* **Notre** page remplace la barre latérale de Spotify : on ne la masque
         que lorsqu'on a de quoi la remplacer. Sinon elle reste telle quelle —
         c'est le seul moyen de ne pas perdre l'accès à sa musique. */
      document.documentElement.classList.toggle("sd-lib-on", show);
      return show;
    },

    /** À chaque changement de vue : on entre dans la bibliothèque, ou on en sort. */
    enter: function () {
      /* La page est construite même hors de son onglet (et reste cachée) : c'est
         ce qui permet à la sonde et au diagnostic de la **mesurer** partout —
         « bibliothèque absente » ne doit pas être confondu avec « masquée
         exprès », c'est exactement l'erreur qui a coûté deux versions à
         l'accueil. */
      this.build();
      if (State.tab !== "library" || !this.isLibraryPath()) {
        this.leave();
        return false;
      }
      /* `load` montre immédiatement ce qu'il a (cache ou liste de Spotify) et
         lance le rafraîchissement en arrière-plan ; `watch` ne sert que s'il n'y
         a **rien** à montrer (première visite, page encore vide). */
      this.load();
      if (!this.items.length) this.watch();
      return this.apply();
    },

    leave: function () {
      if (this.el) this.el.hidden = true;
      if (this.timer) {
        window.clearTimeout(this.timer);
        this.timer = 0;
      }
      document.documentElement.classList.remove("sd-lib-on");
      return true;
    },

    /**
     * Le jeton de la page n'arrive pas toujours avant la première lecture (il
     * est capté sur les requêtes du lecteur), et la bibliothèque peut être
     * ouverte avant. On retente donc quelques fois, espacées, puis on s'arrête :
     * pas de boucle qui tourne dans le vide.
     */
    watch: function () {
      var self = this;
      /* `setTimeout` en chaîne, jamais `setInterval` : un intervalle qui survit à
         un changement de vue est exactement ce que l'ancienne couche faisait (et
         que le banc interdit). Cinq essais au plus, puis on s'arrête. */
      if (this.timer) return false;
      this.tries = 0;
      var again = function () {
        if (self.tries++ >= 5 || self.items.length || State.tab !== "library") {
          self.timer = 0;
          return;
        }
        self.load(true);
        self.timer = window.setTimeout(again, 4000);
      };
      this.timer = window.setTimeout(again, 4000);
      return true;
    },

    /** Ce que le diagnostic dit de la bibliothèque, en trois mots. */
    describe: function () {
      if (!Settings.libraryBoard) return "désactivée (réglage)";
      if (this.state === "loading") return "chargement";
      if (this.state === "no-token") return "pas de jeton (session fermée ?)";
      if (this.state === "error") return "indisponible (" + Net.describe() + ")";
      if (this.state === "guest") return "compte non accessible (" + Net.describe() + ")";
      if (this.fromSidebar) return "lue dans la liste de Spotify (" + this.items.length + " éléments)";
      if (this.state === "empty") return "vide (0 élément)";
      if (this.state === "idle") return "pas encore lue";
      return this.items.length + " éléments";
    },
  };

