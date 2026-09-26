  /* ------------------------------------------------------------------ *
   * 11d. Auto — playback hand-off, stuck-player recovery, screen wake
   *      (everything the native app did from a 5 s interval, event driven)
   * ------------------------------------------------------------------ */
  var Auto = {
    /* The user asked for playback through our UI (play/pause, next, a library
       tap…). Everything that "pushes" Spotify around is gated on this. */
    wantPlay: false,
    takeoverBusy: false,
    _watchBar: null,
    _watchObs: null,
    stuckTries: 0,
    selfPaused: false,
    resumeCount: 0,
    /* Les libellés du relais, tels qu'ils sortent des fichiers de langue que la
       sonde de CI relève chez Spotify. La liste était courte : elle ne connaissait
       que « Écouter sur cet appareil », alors que le lecteur mobile sert
       `mwp.header.listening` = « Vous écoutez sur » et « Lecture sur cet appareil ».
       Un relais dont le libellé n'est pas dans la liste n'est pas cliqué — et sur
       une barre où tout est désactivé, c'est le lecteur qui ne répond plus. */
    TAKEOVER_RE: /(couter sur cet appareil|lire sur cet appareil|lecture sur cet appareil|vous écoutez sur|read on this device|listen on this device|prendre le contr|take control|transf[ée]rer|continuer la lecture)/i,

    start: function () {
      this.watch();
      this.wake();
      document.addEventListener("visibilitychange", function () {
        Auto.wake();
        if (document.visibilityState === "visible") {
          syncFromDom("visible");
          Login.apply();
        }
      });
      window.addEventListener("online", Offline.check);
      window.addEventListener("offline", Offline.check);
    },

    /* ---- "Écouter sur cet appareil" ---------------------------------- */
    /** Spotify only offers the transfer button when another device is
     *  playing; we watch the bar instead of polling it every 5 seconds. */
    /**
     * Le guetteur du relais. Il est **rebranchable** : React remplace le nœud de la
     * barre à chaque fois qu'il redessine le lecteur (changement de piste, page
     * pleine, relais qui apparaît) — un observeur posé sur le nœud du moment
     * survivait sur un nœud détaché, et le relais n'était plus jamais tenté de
     * toute la session. `boot` le rappelle donc à chaque mutation de page ; le
     * rappel ne coûte qu'une comparaison d'identité quand le nœud n'a pas bougé.
     */
    watch: function () {
      if (!window.MutationObserver) return;
      var bar = pick(SEL.npBar);
      if (!bar) return;
      if (this._watchBar === bar) return;
      var i;
      if (this._watchObs) {
        for (i = 0; i < this._watchObs.length; i++) this._watchObs[i].disconnect();
      }
      this._watchBar = bar;
      var obs = new MutationObserver(
        debounce(function () {
          /* NB: never pass a method straight to `debounce` — it calls back with a
             null `this`, which is exactly how a bound-less module method breaks. */
          Auto.maybeTakeover();
        }, 300)
      );
      obs.observe(bar, { childList: true, subtree: true });
      this._watchObs = [obs];
      var panel = pick(SEL.panel);
      if (panel) {
        var obs2 = new MutationObserver(
          debounce(function () {
            Auto.maybeTakeover();
          }, 300)
        );
        obs2.observe(panel, { childList: true, subtree: true });
        this._watchObs.push(obs2);
      }
    },
    takeoverButton: function () {
      for (var i = 0; i < SEL.takeover.length; i++) {
        var nodes = $$(SEL.takeover[i]);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (el.closest && el.closest(".sd-layer")) continue; // never ours
          /* `data-testid="takeover-button"` est une parole de Spotify sur ce que
             est son propre bouton : s'offrir en plus le filtrage par libellé, c'est
             laisser une traduction décider si la lecture revient ici. Les autres
             candidats, eux, sont choisis par ressemblance et doivent être nommés. */
          var label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          if (el.getAttribute("data-testid") === "takeover-button") return el;
          if (this.TAKEOVER_RE.test(label)) return el;
        }
      }
      /* Last resort: when the bar has no track loaded at all, the only bright
         accent button of the bar is the transfer call-to-action. */
      if (!State.hasTrack) {
        var green = pick(['aside[data-testid="now-playing-bar"] div.encore-bright-accent-set button']);
        if (green) return green;
      }
      return null;
    },
    /**
     * Tente le relais. **Rend vrai quand quelque chose roule** (un relais pressé,
     * ou un relais déjà en cours) : l'appelant s'en sert pour séquencer son propre
     * secours au lieu de partir en parallèle.
     */
    maybeTakeover: function () {
      if (!Settings.takeControl) return false;
      if (this.takeoverBusy) return true;
      /* Only ever take playback over when the user *asked* for playback from
         this UI (or enabled the auto-resume option). Clicking the prompt just
         because it appeared would steal playback from a speaker that is
         happily playing — the old layer's behaviour bug in reverse. */
      if (!this.wantPlay) return false;
      var btn = this.takeoverButton();
      if (!btn) return false;
      this.takeoverBusy = true;
      var self = this;
      try {
        btn.click();
      } catch (e) {
        /* the button may vanish between the observer callback and the click */
      }
      Toast.show(Settings.labels.takeover);
      buzz(12);
      /* Spotify then asks *which* device to hand playback to: click the first
         row of that list, exactly like the native app does. */
      setTimeout(function () {
        var row = pick(SEL.takeoverRows);
        if (row) {
          try {
            row.click();
          } catch (e) {}
        }
        self.takeoverBusy = false;
      }, 600);
      if (this.wantPlay) this.armStuck();
      return true;
    },

    /* ---- stuck-player recovery --------------------------------------- */
    /** Spotify occasionally swallows the first play request. The old layer
     *  waited 10 s, told Android (`deferMessage('unlock')`) and skipped to the
     *  next track — same recovery, but never more than twice per request. */
    armStuck: function () {
      clearTimeout(this._stuck);
      this._stuck = setTimeout(function () {
        if (State.playing || !Auto.wantPlay || Auto.stuckTries >= 2) return;
        Auto.stuckTries++;
        Bridge.defer("unlock");
        Toast.show(Settings.labels.unlock);
        if (!Spotify.next()) Spotify.playPause();
      }, 10000);
    },

    /* ---- optional auto-resume ---------------------------------------- */
    maybeResume: function () {
      if (!Settings.resume || this.selfPaused || !State.hasTrack) return;
      if (document.visibilityState === "hidden" || this.resumeCount >= 3) return;
      this.resumeCount++;
      setTimeout(function () {
        if (!State.playing && Settings.resume && !Auto.selfPaused) Spotify.playPause();
      }, 600);
    },

    /* ---- screen wake lock for video/canvas playback ------------------ */
    wake: function () {
      if (!Bridge.has("wakeUp")) return;
      var video = $(".VideoPlayer__container video");
      try {
        if (State.playing && video && document.visibilityState === "hidden") Bridge.wakeUp();
        else if (document.visibilityState === "visible" && !video && Bridge.isWoke()) Bridge.wakeOff();
      } catch (e) {
        /* bridge hiccup — never break the UI over it */
      }
    },
  };

