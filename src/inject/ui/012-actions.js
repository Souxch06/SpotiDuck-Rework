  /* ------------------------------------------------------------------ *
   * 10. Actions — optimistic UI + verification
   *     The old layer wrote `isfav = true` / `repmode = 'mixed'` in JS and
   *     *hoped* the web player agreed. Here every action updates the UI
   *     immediately, then re-reads the DOM shortly after so the two can
   *     never drift apart.
   * ------------------------------------------------------------------ */
  /**
   * Boutons de droite de la barre de navigation : ils ouvrent **les** écrans de
   * Spotify (notifications, activité des amis, menu du profil) en cliquant le
   * bouton correspondant du web player. Si Spotify ne propose pas ce bouton
   * (page de connexion, autre version), on le dit au lieu de laisser un bouton
   * qui ne fait rien.
   */
  var SPOTIFY_BUTTONS = {
    bell: [
      '[data-testid="notification-button"]',
      'button[aria-label*="otification"]',
      '[data-testid="whats-new-button"]',
      'button[aria-label*="ouveaut"]',
    ],
    friends: [
      '[data-testid="friends-button"]',
      'button[aria-label*="ctivit"]',
      'button[aria-label*="riends"]',
      'button[aria-label*="rofil d"]',
    ],
    profile: [
      '[data-testid="user-widget-link"]',
      'button[data-testid="user-widget-link"]',
      '[data-testid="user-widget-dropdown"]',
      'button[aria-label*="rofil"]',
      'button[aria-label*="count"]',
    ],
  };

  var Actions = {
    /* Play Protect interrompt parfois l'installation d'un APK signé hors du
       Play Store. L'application ne peut pas le désactiver (c'est un service
       Google, pas une permission Android) mais elle ouvre le réglage — sinon
       il faut le chercher dans le Play Store. */
    playprotect: function () {
      if (Bridge.call("openPlayProtect")) {
        Toast.show(Settings.labels.playProtectHint, 4200);
        return true;
      }
      Toast.show(Settings.labels.playProtectManual, 4200);
      return false;
    },
    settle: function (delay) {
      clearTimeout(Actions._t);
      Actions._t = setTimeout(function () {
        syncFromDom("settle");
      }, delay || 700);
    },
    /**
     * **Ce qu'on dit quand la commande n'a pas trouvé de bouton vivant.**
     *
     * Deux cas très différents, et un seul message juste : si rien ne joue, les
     * commandes de Spotify sont désactivées — le dire est exact et actionnable ;
     * si une musique joue, c'est la page qui n'expose pas la commande.
     */
    blame: function () {
      Toast.show(State.title ? Settings.labels.transportMissing : Settings.labels.transportNoTrack, 2800);
    },
    /**
     * **Dernier recours : le clavier du lecteur.**
     *
     * Le lecteur web écoute ses propres raccourcis (`Espace`, `Ctrl` + flèches) :
     * c'est le seul chemin qui reste quand la disposition de la page ne laisse
     * pas trouver ses boutons — et il vaut mieux qu'un bouton muet. On ne parle
     * qu'ensuite, et seulement si rien ne joue (le raccourci n'aurait alors rien
     * pu faire).
     */
    fallback: function (key, watch, avant) {
      var self = this;
      var ref = typeof avant === "string" ? avant : this.snapshot(watch);
      Spotify.key(key);
      /* **Vérifier, comme partout ailleurs.** Le raccourci a très bien pu agir :
         on relit le lecteur peu après, et on ne parle que si rien n'a bougé —
         une alarme à tort est un défaut, un bouton muet aussi.
         **Jugé sur la page, pas sur notre affichage :** `playPause` a déjà posé
         l'état optimiste, donc comparer `State` à une valeur d'avant ne prouve
         rien (c'est exactement comme ça qu'un appui muet restait sans message).
         Sur l'état de lecture, c'est donc ce que le lecteur répond qui décide. */
      setTimeout(function () {
        syncFromDom("fallback");
        if (watch === "playing") {
          var dom = Spotify.readPlaying();
          if (dom === null || String(dom) === ref) self.blame();
          return;
        }
        if (self.snapshot(watch) === ref) self.blame();
      }, 800);
    },
    /** Ce qu'on regarde pour savoir si la commande a fait quelque chose. */
    snapshot: function (watch) {
      if (watch === "playing") return String(State.playing);
      if (watch === "shuffle") return String(State.shuffle);
      if (watch === "repeat") return State.repeat;
      return (State.title || "") + "|" + (State.artist || "");
    },
    playPause: function () {
      var want = !State.playing;
      Auto.wantPlay = want;
      Auto.selfPaused = !want;
      if (want) {
        Auto.stuckTries = 0;
        Auto.resumeCount = 0;
      }
      emit({ playing: want }, "optimistic");
      buzz(Settings.labels.buzzTap);
      /* Le bouton de Spotify d'abord ; s'il n'y en a pas de vivant, le clavier
         du lecteur — et on ne revient sur l'affichage optimiste que si rien ne
         joue, seule situation où l'on sait que rien n'a pu se passer. */
      Engine.feed();
      if (!Spotify.playPause(want)) {
        /* La référence est la **vérité du DOM avant l'affichage optimiste** :
           c'est avec elle qu'on jugera si le raccourci a changé quelque chose. */
        this.fallback(" ", "playing", String(!want));
      } else if (want) {
        /* Starting playback may require the "Écouter sur cet appareil"
           hand-off first, and Spotify sometimes swallows the first request
           entirely — both cases are handled by the Auto module. */
        setTimeout(function () {
          Auto.maybeTakeover();
        }, 400);
        Auto.armStuck();
      }
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
      Auto.wantPlay = true;
      Auto.selfPaused = false;
      if (!Spotify.next()) {
        this.fallback("ArrowRight", "track");
        return;
      }
      setTimeout(function () {
        Auto.maybeTakeover();
      }, 400);
      emit({ anchorPos: 0, position: 0, anchorAt: performance.now() }, "optimistic");
      Actions.settle(900);
    },
    prev: function () {
      buzzer();
      /* Comportement natif : au-delà de trois secondes, « précédent » remet
         d'abord le titre au début. **Mais seulement si cela marche** : le curseur
         de progression peut être momentanément absent (page en cours de
         remplacement), et le résultat était un bouton qui ne faisait absolument
         rien — l'utilisateur croyait la commande perdue, alors qu'il attendait
         simplement la piste précédente. Sans curseur, on revient donc au
         comportement normal. */
      if (livePosition() > 3000 && Spotify.seek(0)) {
        emit({ anchorPos: 0, position: 0, anchorAt: performance.now() }, "optimistic");
        Actions.settle(900);
        return;
      }
      if (!Spotify.prev()) {
        this.fallback("ArrowLeft", "track");
        return;
      }
      emit({ anchorPos: 0, position: 0, anchorAt: performance.now() }, "optimistic");
      Actions.settle(900);
    },
    shuffle: function () {
      buzzer();
      var want = !State.shuffle;
      emit({ shuffle: want }, "optimistic");
      if (!Spotify.toggleShuffle()) {
        emit({ shuffle: !want }, "rollback");
        this.blame();
      }
      this.settle(500);
    },
    repeat: function () {
      buzzer();
      var order = { off: "context", context: "track", track: "off" };
      var want = order[State.repeat] || "context";
      emit({ repeat: want }, "optimistic");
      if (!Spotify.cycleRepeat()) {
        emit({ repeat: State.repeat }, "rollback");
        this.blame();
      }
      this.settle(500);
    },
    /** Ouvre un écran de Spotify depuis la barre de navigation supérieure. */
    spotifyButton: function (which) {
      var list = SPOTIFY_BUTTONS[which] || [];
      for (var i = 0; i < list.length; i++) {
        var el = $(list[i]);
        if (el && el.getClientRects().length) {
          try {
            el.click();
            return true;
          } catch (e) {
            /* on essaie le suivant */
          }
        }
      }
      Toast.show(Settings.labels.notAvailable, 2200);
      return false;
    },

    like: function () {
      buzzer();
      var want = !State.liked;
      emit({ liked: want }, "optimistic");
      if (!Spotify.toggleLike()) emit({ liked: !want }, "rollback");
      Bridge.mediaStatus(State);
      this.settle(1200);
    },
    /**
     * Se déplacer dans la piste.
     *
     * Deux défauts corrigés ici :
     *  • la **confirmation relisait le curseur en secondes** (`valeur * 1000`)
     *    pendant que l'écriture suivait l'unité mesurée : sur une page graduée
     *    en millisecondes, 40 s posées sur la barre rendaient « 11 h 06 » et
     *    la progression repartait de là — le geste était juste, l'affichage
     *    mentait jusqu'à la prochaine seconde ;
     *  • `seeking: false` était rendu **avant** de savoir si la commande était
     *    passée, et l'échec ne disait rien : un appui sans effet ressemblait à
     *    un curseur cassé. On rouvre donc la vérification comme pour les autres
     *    commandes (relire, puis parler si rien n'a bougé).
     */
    seek: function (ms) {
      var target = Math.max(0, Number(ms) || 0);
      emit({ anchorPos: target, position: target, anchorAt: performance.now(), seeking: false }, "seek");
      buzz(6);
      // Spotify needs a moment to confirm; re-anchor from the DOM after that.
      if (!Spotify.seek(target)) {
        this.blame();
        this.settle(300);
        return false;
      }
      setTimeout(function () {
        var input = Spotify.progressInput();
        if (input) {
          var p = Spotify.ticksToMs(input.value);
          emit({ anchorPos: p, anchorAt: performance.now() }, "seek-confirm");
          Bridge.mediaPosition(p);
        }
      }, 400);
      return true;
    },
    /** Le geste donne une proportion : c'est ici qu'elle devient une position. */
    seekRatio: function (ratio) {
      return this.seek(clamp(Number(ratio) || 0, 0, 1) * trackDurationMs());
    },
    share: function () {
      /* Share the *real* track URL (the old layer shared the open.spotify.com
         home page, which made the feature useless). */
      var url = Spotify.trackHref();
      var copy = function () {
        try {
          navigator.clipboard.writeText(url);
          Toast.show(Settings.labels.copied);
        } catch (e) {
          Toast.show(url, 2600);
        }
      };
      if (navigator.share) {
        var p = null;
        try {
          p = navigator.share({ title: State.title, text: State.artist, url: url });
        } catch (e) {
          p = null; // not allowed (not a user gesture) → clipboard
        }
        if (p && typeof p.then === "function") {
          p.then(null, function () {
            /* cancelled — no need to shout about it */
          });
          return;
        }
        if (p) return;
      }
      copy();
    },
    openArtist: function () {
      var a = pick(SEL.artist);
      if (a && a.tagName === "A" && a.getAttribute("href")) location.assign(a.getAttribute("href"));
    },
    openAlbum: function () {
      var a = Spotify.albumLink();
      if (a && a.getAttribute("href")) location.assign(a.getAttribute("href"));
    },
  };
  function buzzer() {
    buzz(10);
  }

