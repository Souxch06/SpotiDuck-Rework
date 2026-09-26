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
        /* `labels.previous` n'existe pas (la clé s'appelle `prev`) : l'appui
           restait correct mais le bouton s'annonçait « undefined » à voix haute,
           et l'audit de la feuille signalait un contrôle sans nom. */
        '<button class="sd-iconbtn sd-mini-prev" type="button" aria-label="' +
        Settings.labels.prev +
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
        "</div>" +
        /* Ligne 4 · ce que l'application d'origine met sous la progression :
           paroles, karaoké, file d'attente, appareils, volume. Rien n'est
           décoratif : chaque commande pilote celle de Spotify, et disparaît
           si Spotify ne l'expose pas sur la page courante. */
        '<div class="sd-mini-row2">' +
        '<button class="sd-iconbtn sd-mini-lyrics" type="button" aria-label="' +
        Settings.labels.lyrics +
        '">' +
        svg(ICONS.lyricsLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-karaoke" type="button" aria-label="' +
        Settings.labels.karaoke +
        '" hidden>' +
        svg(ICONS.micLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-queue" type="button" aria-label="' +
        Settings.labels.queue +
        '">' +
        svg(ICONS.queueLine) +
        "</button>" +
        '<button class="sd-iconbtn sd-mini-devices" type="button" aria-label="' +
        Settings.labels.devices +
        '" hidden>' +
        svg(ICONS.deviceLine) +
        "</button>" +
        '<div class="sd-mini-volume" hidden>' +
        '<span class="sd-mini-volicon" aria-hidden="true">' +
        svg(ICONS.speakerLine) +
        "</span>" +
        '<input class="sd-mini-vol" type="range" min="0" max="100" step="1" value="100" aria-label="' +
        Settings.labels.volume +
        '">' +
        "</div>" +
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
        '<a class="sd-btn sd-welcome-cta" href="' + CLASSIC_LOGIN + '">' +
        Settings.labels.welcomeCta +
        "</a>" +
        '<p class="sd-welcome-note">' +
        Settings.labels.welcomeNote +
        "</p>" +
        "</div>";

      /* Le bouton de l'écran d'accueil passe par la partie native, comme
         celui de la page de connexion : même adresse, mais chargée par la
         WebView elle-même, sans dépendre du routeur de Spotify. Sans ça, un
         appui qui n'aboutit pas laissait l'utilisateur sur l'écran d'accueil
         sans aucun moyen d'avancer. */
      var welcomeCta = welcome.querySelector(".sd-welcome-cta");
      if (welcomeCta) {
        welcomeCta.addEventListener("click", function (event) {
          try {
            if (window.AndBridge && AndBridge.openLogin) {
              event.preventDefault();
              Bridge.call("openLogin");
            }
          } catch (e) {}
        });
      }

      /* ---- queue sheet scrim + grabber ---- */
      var scrim = document.createElement("div");
      scrim.className = "sd-scrim";
      var grabber = document.createElement("div");
      grabber.className = "sd-sheet-grabber";

      /* ---- login helper + offline banner ---- */
      var loginCta = document.createElement("a");
      loginCta.className = "sd-login-cta";
      loginCta.href = CLASSIC_LOGIN;
      /* La navigation passe par la partie native quand elle est là : même
         adresse, mais chargée par la WebView elle-même, sans dépendre du
         routeur de Spotify. */
      loginCta.addEventListener("click", function (event) {
        try {
          if (window.AndBridge && AndBridge.openLogin) {
            event.preventDefault();
            Bridge.call("openLogin");
          }
        } catch (e) {}
      });
      loginCta.textContent = Settings.labels.classicLogin;
      /* Le voile d'ouverture : jamais d'écran noir pendant qu'une page
         s'ouvre. Il couvre la **zone de contenu** — la navigation et le
         lecteur restent à leur place et utilisables —, il dit ce qu'il ouvre,
         et il se retire dès que la page est là (module `Open`). */
      var openVeil = document.createElement("div");
      openVeil.className = "sd-open";
      openVeil.hidden = true;
      openVeil.setAttribute("role", "status");
      openVeil.setAttribute("aria-live", "polite");
      openVeil.innerHTML =
        '<span class="sd-open-bar" aria-hidden="true"></span>' +
        '<span class="sd-open-card"><span class="sd-open-spin" aria-hidden="true"></span>' +
        '<span class="sd-open-text"></span></span>';

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
      L.appendChild(openVeil);
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
        miniLyrics: $(".sd-mini-lyrics", mini),
        miniKaraoke: $(".sd-mini-karaoke", mini),
        miniQueue: $(".sd-mini-queue", mini),
        miniDevices: $(".sd-mini-devices", mini),
        miniVolWrap: $(".sd-mini-volume", mini),
        miniVol: $(".sd-mini-vol", mini),
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
        open: openVeil,
        welcome: welcome,
        welcomeCta: $(".sd-welcome-cta", welcome),
      };
      this.built = true;
      this.bind();
      this.watchSize();
      this.paint(State, "build");
    },

    /**
     * **La place réservée en bas de l'écran = la hauteur réelle du mini-lecteur.**
     *
     * Les feuilles fixent une hauteur *espérée* (`--sd-mini-h`, par taille
     * d'écran) ; le mini-lecteur, lui, se dimensionne seul (sa pochette suit la
     * largeur de l'écran, ses deux rangées de commandes ont leur propre taille,
     * la densité change tout). Quand les deux divergeaient, la page passait
     * sous la barre — une bande de 60 px de contenu injoignable, le défaut
     * signalé le 25/09.
     *
     * Trois cas, et pas un de plus :
     *   • le mini-lecteur n'est pas affiché (page de connexion, écran d'accueil,
     *     `hidden`) → **0**, rien à réserver ;
     *   • il est affiché et mesure quelque chose → **sa hauteur réelle** ;
     *   • il est affiché mais ne mesure rien (pas encore de mise en page :
     *     premier rendu, banc sans moteur de layout) → on **retire** notre
     *     valeur en ligne et la feuille reprend la main. Écrire `0px` ici
     *     serait exactement l'autre moitié du même bug : la page glisserait
     *     sous la barre.
     */
    measure: function () {
      var e = this.el;
      if (!e || !e.mini) return false;
      var html = document.documentElement;
      var h = 0;
      try {
        h = Math.ceil(e.mini.getBoundingClientRect().height || 0);
      } catch (err) {
        h = 0;
      }
      var gone = !!e.mini.hidden || !e.mini.isConnected;
      if (!gone) {
        try {
          gone = window.getComputedStyle(e.mini).display === "none";
        } catch (err) {
          /* feuille illisible : on considère qu'il est affiché */
        }
      }
      var value = null;
      if (gone) value = "0px";
      else if (h > 0) value = h + "px";
      var current = html.style.getPropertyValue("--sd-mini-h-current");
      if (value === null) {
        if (!current) return false;
        html.style.removeProperty("--sd-mini-h-current");
        return true;
      }
      if (current === value) return false;
      html.style.setProperty("--sd-mini-h-current", value);
      return true;
    },

    /** Mesurer **une fois par image**, pas à chaque écriture du repeint :
        `paint` tourne aussi sur le défilement, et une lecture de boîte par
        frame suffit à faire bégayer la page. */
    askMeasure: function () {
      if (this._measureQueued || !this.built) return false;
      this._measureQueued = true;
      var self = this;
      requestAnimationFrame(function () {
        self._measureQueued = false;
        if (self.measure()) self.paintChrome(State);
      });
      return true;
    },

    /** Toute taille de boîte qui change se traduit en réserve : un seul
        observateur, posé une fois, sans boucle de sondage. */
    watchSize: function () {
      var self = this;
      if (this.sizeWatched || !window.ResizeObserver) return false;
      this.sizeWatched = true;
      var ro = new ResizeObserver(function () {
        if (self.measure()) self.paintChrome(State);
      });
      [this.el.mini, this.el.tabbar, this.el.nav].forEach(function (node) {
        if (node) {
          try {
            ro.observe(node);
          } catch (e) {
            /* un nœud détaché entre-temps : la mesure du ticker suffira */
          }
        }
      });
      this.ro = ro;
      return true;
    },

    /* ---------------- painting ---------------- */
    paint: function (s, reason) {
      if (!this.built) return;
      var e = this.el;


      /* **Vos statistiques s'alimentent ici** — mais sur ce qui est
         réellement écouté : `Stats.tick` suit l'avancement du lecteur et
         attribue au titre en cours le temps passé. Noter la durée annoncée à
         l'apparition du titre (ce qui se faisait avant) comptait quatre minutes
         pour un titre survolé dix secondes : « les statistiques sont pas
         bonne ». Le relevé a aussi lieu dans `Ticker`, pour la seconde près. */
      Stats.tick(s);

      /* titles — sans titre, le mini-lecteur dit où il en est plutôt que de
         rester vide (il reste affiché, c'est le lecteur de l'application). */
      /* Sans piste, l'état vide dit **pourquoi** : session fermée ou rien
         lancé. Et si la session est fermée, l'appui sur la barre ouvre la
         connexion (voir le clic plus bas). */
      var signedOut = !s.hasTrack && !!LoginState && LoginState.state() === "out";
      document.documentElement.classList.toggle("sd-mini-signed-out", signedOut);
      var miniTitle = s.title || (signedOut ? Settings.labels.miniSignedOut : Settings.labels.noTrack);
      var miniArtist = s.artist || (signedOut ? Settings.labels.miniSignedOutHint : Settings.labels.app);
      if (e.miniTitle.textContent !== miniTitle) e.miniTitle.textContent = miniTitle;
      if (e.miniArtist.textContent !== miniArtist) e.miniArtist.textContent = miniArtist;
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
      /* Sans titre : les commandes de transport sont **désactivées**, pas
         masquées — on voit ce que l'application sait faire. */
      [e.miniPrev, e.miniPlay, e.miniNext, e.miniShuffle, e.miniRepeat, e.miniLike].forEach(
        function (btn) {
          if (!btn) return;
          /* **Jamais `disabled`.** Un bouton désactivé ne reçoit aucun événement :
             l'appui ne déclenchait ni commande ni message — exactement « les
             boutons du lecteur ne font rien ». Mesuré en CI le 26/09 : à l'endroit
             du bouton, `elementFromPoint` répondait la rangée, pas le bouton, car
             la feuille éteint les `button[disabled]`. L'état est donc annoncé
             (`aria-disabled`) et dessiné (`.is-unavailable`), **mais l'appui
             arrive à la commande**, qui répond « aucun titre en lecture ».
             Un `disabled` laissé par une autre voie est retiré ici. */
          if (btn.disabled) btn.disabled = false;
          var off = !s.hasTrack && !Spotify.mediaEl();
          btn.setAttribute("aria-disabled", off ? "true" : "false");
          if (btn.classList.contains("is-unavailable") === off) return;
          btn.classList.toggle("is-unavailable", off);
        }
      );
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
      /* … et la rangée bonus du mini-lecteur, qui suit les mêmes capacités :
         un bouton qui ne peut rien faire ne s'affiche pas du tout. */
      e.miniLyrics.hidden = !Spotify.lyricsButton();
      e.miniKaraoke.hidden = !Spotify.karaokeButton();
      e.miniDevices.hidden = !Spotify.devicesButton();
      e.miniQueue.hidden = !Spotify.queueButton() && !$("#Desktop_PanelContainer_Id");
      /* Paroles et karaoké : Spotify expose `aria-pressed` sur ses propres
         boutons. On le reflète, sinon nos boutons ne diraient jamais qu'ils
         sont actifs (et l'audit se plaint d'une classe jamais stylée). */
      [
        [e.miniLyrics, Spotify.lyricsButton()],
        [e.miniKaraoke, Spotify.karaokeButton()],
      ].forEach(function (pair) {
        var btn = pair[0];
        var src2 = pair[1];
        var on =
          !!src2 &&
          (src2.getAttribute("aria-pressed") === "true" ||
            src2.getAttribute("aria-checked") === "true");
        toggle(btn, "is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
      var volInput = Spotify.volumeInput();
      e.miniVolWrap.hidden = !volInput;
      if (volInput) {
        var vol = clamp(Math.round(Number(volInput.value) || 0), 0, 100);
        if (e.miniVol.value !== String(vol)) e.miniVol.value = String(vol);
        toggle(e.miniVolWrap, "is-muted", vol === 0);
      }

      /* duration (feuille du lecteur + mini-lecteur) */
      e.tDur.textContent = fmtTime(s.duration);
      if (e.miniDur) e.miniDur.textContent = fmtTime(s.duration);
      this.paintProgress();

      /* route chrome */
      this.paintChrome(s);
      /* Les rangées du mini-lecteur apparaissent et disparaissent selon ce que
         la page expose (paroles, karaoké, appareils, volume) : la réserve du bas
         suit ce changement, à l'image suivante. */
      this.askMeasure();
      pushToAndroid();
    },

    paintProgress: function () {
      if (!this.built) return;
      var s = State;
      var pos = livePosition();
      /* La durée **annoncée** par la page vaut 0 pendant un instant (première
         seconde d'un titre, reprise en cours de lecture) : la barre restait
         plate alors que la position avançait. La course du curseur sert de repli. */
      var total = s.duration > 0 ? s.duration : trackDurationMs();
      var ratio = total > 0 ? clamp(pos / total, 0, 1) : 0;
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

    /**
     * **Le mini-lecteur ne reste pas « parti ».**
     *
     * Il peut être poussé hors de l'écran par une classe restée en place ou par
     * un transform laissé par un geste interrompu. Plutôt que d'espérer qu'un
     * chemin de code le remette, on le **réaffirme** : la classe qui l'affiche,
     * et pas de transform en trop. Une fois par seconde, sans rien recalculer
     * d'autre — et jamais pendant qu'un doigt le déplace.
     */
    reassertMini: function () {
      if (!this.built || !this.el || !this.el.mini) return false;
      var html = document.documentElement;
      var fixed = false;
      /* La réserve du bas suit la hauteur rendue : vérifiée au même rythme que
         l'affirmation du lecteur (une fois par seconde), donc rien ne reste
         décalé après un changement de police, de densité ou de rangées. */
      if (this.measure()) fixed = true;
      if (!html.classList.contains("sd-mini-on")) {
        html.classList.add("sd-mini-on");
        fixed = true;
      }
      var mini = this.el.mini;
      if (!mini.classList.contains("is-dragging") && mini.style.transform) {
        mini.style.transform = "";
        fixed = true;
      }
      if (mini.hidden) {
        mini.hidden = false;
        fixed = true;
      }
      /* Et si la feuille du lecteur n'est plus ouverte, la classe qui l'affiche
         ne doit pas rester : c'est elle qui cache le mini-lecteur. */
      if (!Player.open && html.classList.contains("sd-player-open")) {
        html.classList.remove("sd-player-open");
        fixed = true;
      }
      /* **Un dialogue fermé ne doit pas éteindre le lecteur.** La classe qui
         fait reculer notre coque devant un dialogue de Spotify était posée par
         une simple présence dans le DOM : un dialogue resté monté une fois
         fermé l'éteignait **pour de bon** (« le lecteur disparaît »). On la
         revérifie donc ici — une fois par seconde, et seulement quand elle est
         posée. */
      if (html.classList.contains("sd-native-modal") && Polish.syncOverlay()) fixed = true;
      return fixed;
    },

    /**
     * **Aucun de nos écrans ne recouvre une page ouverte.**
     *
     * « Quand on clique sur les playlists, y'a un écran noir » (25/09). Une
     * playlist ouverte **depuis** la bibliothèque laissait nos écrans pleine
     * page — accueil maison, bibliothèque — par-dessus, ou la barre latérale de
     * Spotify restait en pleine page. Plutôt que d'espérer que chaque chemin de
     * code range ce qu'il a ouvert, on le **réaffirme** : dès que la vue est une
     * sous-page, nos écrans pleine page sont rangés, la classe d'état est
     * remise d'aplomb et le garde-fou de contenu est réappliqué. Une fois par
     * seconde, comme le mini-lecteur — et sans rien recalculer d'autre.
     */
    reassertSurfaces: function () {
      if (!this.built || !this.el) return false;
      /* Le chemin décide (voir `Spotify.isSubPagePath`) : une playlist ouverte
         depuis la bibliothèque n'est pas reconnue par le DOM tout de suite. */
      if (!Spotify.isSubPagePath()) return false;
      var html = document.documentElement;
      var changed = false;
      /* Les deux écrans ne sont pas des enfants de notre coque (ils vivent dans
         la page) : `this.el.home` et `this.el.lib` n'ont donc jamais existé, et
         ce garde-fou ne s'est **jamais déclenché** — l'écran noir signalé
         passait malgré lui. On interroge les modules eux-mêmes. */
      if (Home.el && !Home.el.hidden) {
        Home.hide();
        changed = true;
      }
      if (Library.el && !Library.el.hidden) {
        Library.leave();
        changed = true;
      }
      if (html.classList.contains("sd-lib-on")) {
        html.classList.remove("sd-lib-on");
        changed = true;
      }
      if (html.classList.contains("sd-welcome-on")) {
        Welcome.hide();
        changed = true;
      }
      if (!html.classList.contains("sd-subpage")) {
        html.classList.add("sd-subpage");
        changed = true;
      }
      /* Et le contenu ne peut pas rester masqué par une de nos règles (§31). */
      Content.apply();
      return changed;
    },

    /** Header / tab-bar visibility for the current route + tab. */
    paintChrome: function (s) {
      var e = this.el;
      var html = document.documentElement;
      var isLibrary = s.tab === "library";
      var isSubPage = s.route === "page";

      /* **Une page ouverte reste ouverte.** `sd-subpage` était annulé sur
         l'onglet Bibliothèque : une playlist ouverte depuis la bibliothèque
         n'était donc pas reconnue, et la barre latérale de Spotify — que la
         feuille transforme en page pleine sur cet onglet — restait posée
         par-dessus (« quand on clique sur les playlists, il y a un écran
         noir », 25/09). La vue fait foi, pas l'onglet. */
      html.classList.toggle("sd-subpage", isSubPage);
      html.classList.toggle("sd-has-track", !!s.hasTrack);
      /* **Le lecteur ne disparaît plus.** `sd-mini-on` dépendait d'une lecture
         instantanée de l'état : la barre de lecture de Spotify quitte l'arbre
         pendant un défilement (rendu différé) et, à ce moment-là, la classe
         tombait — le lecteur s'effaçait sous le doigt. Vu une fois, il reste
         donc affiché (voir `Spotify.seen`). */
      /* Le mini-lecteur suit le **lecteur**, pas la piste : dès qu'un lecteur
         existe, il est là — avec l'état vide « Aucun titre en lecture ». Avant,
         il n'existait qu'avec une piste : sur un compte qui n'a rien lancé,
         l'écran restait vide en bas (le fameux « des trucs n'apparaissent
         pas »). */
      /* **Le lecteur ne disparaît pas.** Il y avait trois conditions pour
         l'afficher — une piste, un lecteur prêt, « vu une fois depuis le
         chargement de la page » — et chacune pouvait manquer : après un
         rechargement, sur une session fermée, ou pendant un rendu différé, le
         bas de l'écran se vidait. « Le lecteur a de nouveau disparu » (25/09).
         La barre est donc **toujours** là : c'est le lecteur de l'application.
         La page de connexion, elle, la masque explicitement (`html.sd-login`). */
      Spotify.seen = Spotify.seen || !!s.hasTrack || Spotify.ready();
      html.classList.add("sd-mini-on");
      html.classList.toggle("sd-mini-empty", !s.hasTrack);
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
      /* Barre de navigation ou barre de titre — jamais les deux : elles
         occupent le **même** bord, collées en haut, donc l'une recouvrait
         l'autre et la barre de titre (retour + nom de la page) était
         invisible sur la bibliothèque. L'application d'origine fait pareil :
         on quitte la bibliothèque par « Fermer », pas par l'onglet. */
      /* **La barre de navigation reste aussi sur la bibliothèque.** C'est la
         seule navigation de l'application (la barre d'onglets du bas est
         désactivée par défaut) : la masquer là enfermait l'utilisateur —
         « quand on clique sur l'onglet bibliothèque, la barre en haut disparaît
         et rien d'autre n'apparaît ; je reste bloqué ». Seules les sous-pages
         (playlist, album) prennent la barre, avec leur bouton retour. */
      var navOn = !isSubPage;
      html.classList.toggle("sd-nav-on", navOn);
      var key = s.tab + "/" + s.route;
      /* Un changement de vue remplace le contenu : c'est le moment de
         revérifier que notre feuille n'a rien effacé. */
      /* `key` est calculé **avant** d'être lu : déclaré après, il valait
         `undefined` au premier passage (les `var` sont remontées), donc le bloc
         se croyait toujours sur une nouvelle vue et se rejouait à chaque
         repeint. */
      if (UI.lastRouteKey !== key) {
        UI.lastRouteKey = key;
        Content.apply();
        Home.refresh("vue");
        Library.enter();
      }
      e.navItems.forEach(function (item) {
        var name = item.getAttribute("data-tab");
        var active = name === s.tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });

      /* Barre de titre : **sous-pages seulement** (retour + nom de la page).
         Sur la bibliothèque, c'est la page elle-même qui porte son titre, et la
         barre de navigation reste au-dessus : deux barres au même bord se
         recouvriraient, et c'est la navigation qui doit gagner. */
      e.topbar.classList.toggle("is-visible", isSubPage);
      e.topbarBack.style.display = isSubPage ? "" : "none";
      e.topbarClose.style.display = "none";
      if (isSubPage) {
        e.topbarTitle.classList.remove("is-large");
        var label = Spotify.pageTitle() || "";
        if (e.topbarTitle.textContent !== label) e.topbarTitle.textContent = label;
      }

      // Class-driven so the mini player docks correctly when the bar is off
      // (see `html.sd-no-tabbar` in the stylesheet).
      html.classList.toggle("sd-no-tabbar", !Settings.tabbar);
      document.body.classList.toggle("sd-player-open", Player.open);
      document.body.classList.toggle("sd-panel-open", Queue.open);
      /* **La classe qui montre la feuille et cache le mini-lecteur est posée
         ici** — au même endroit que l'état qui la décide. Elle n'était posée
         qu'à l'ouverture : un chemin de fermeture qui n'appelait pas
         `closeSheet` la laissait en place, et le mini-lecteur restait hors de
         l'écran (`transform: 120 %`) : « le lecteur a de nouveau disparu ». */
      html.classList.toggle("sd-player-open", Player.open);
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
        /* Pas de session : le lecteur ne peut rien ouvrir d'utile — l'appui
           mène à la connexion, comme le bouton de l'écran d'accueil. */
        if (document.documentElement.classList.contains("sd-mini-signed-out")) {
          location.href = CLASSIC_LOGIN;
          return;
        }
        Player.openSheet();
      });
      e.mini.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          Player.openSheet();
        }
      });

      /* **Le défilement ne doit rien effacer.** Spotify remonte et redescend
         ses barres pendant qu'on fait défiler la page : on réapplique l'état de
         la coque au fil du défilement, à cadence douce. « Le lecteur disparaît
         quand on scroll vers le bas » — deux fois signalé. */
      var scrollPaint = 0;
      document.addEventListener(
        "scroll",
        function () {
          var now = Date.now();
          if (now - scrollPaint < 120) return;
          scrollPaint = now;
          UI.paint(State, "défilement");
        },
        true
      );
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
      /* Rangée bonus : paroles, karaoké, file d'attente, appareils, volume.
         `stopPropagation` partout : le mini-lecteur, lui, ouvre le lecteur
         plein écran au moindre appui. */
      e.miniLyrics.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var b = Spotify.lyricsButton();
        if (b) b.click();
      });
      e.miniKaraoke.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var b = Spotify.karaokeButton();
        if (b) b.click();
      });
      e.miniQueue.addEventListener("click", function (ev) {
        ev.stopPropagation();
        /* **Ouvrir *et* fermer** : ce bouton n'appelait qu'`openSheet`, donc un
           second appui ne faisait rien (mesuré au banc : `sd-queue-open` restait
           après deux appuis). La feuille du lecteur, elle, basculait déjà. */
        Queue.toggle();
      });
      e.miniDevices.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var b = Spotify.devicesButton();
        if (b) b.click();
      });
      ["input", "change", "click", "pointerdown", "touchstart"].forEach(function (name) {
        e.miniVol.addEventListener(name, function (ev) {
          ev.stopPropagation();
          if (name === "input" || name === "change") Volume.set(this.value);
        });
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
      /* Le voile ne s'affiche que sous la file d'attente et les menus : un clic
         dessus ferme ce qui est réellement ouvert (le lecteur plein écran, lui,
         se ferme par son chevron ou par le bouton retour — il n'y a rien « à côté
         de lui » à toucher). `Queue.close` sans ce garde-fou tournait à vide et
         repeignait les barres pour rien. */
      e.scrim.addEventListener("click", function () {
        if (Sheets.active) Sheets.close();
        else if (Queue.open) Queue.close();
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

