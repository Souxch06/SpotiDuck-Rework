  /* ------------------------------------------------------------------ *
   * 6. rAF ticker — only runs while something actually moves
   * ------------------------------------------------------------------ */
  var Ticker = {
    raf: 0,
    last: 0,
    lastPush: 0,
    lastMini: 0,
    start: function () {
      if (this.raf) return;
      var self = this;
      self.raf = requestAnimationFrame(function tick(now) {
        self.raf = requestAnimationFrame(tick);
        if (now - self.last < 100) return; // 10 fps is plenty for a progress bar
        self.last = now;
        /* Les statistiques se nourrissent de l'avancement du lecteur : chaque
           seconde dont la position progresse est une seconde écoutée, et le
           relevé a lieu même en pause (pour fermer l'écoute en cours). */
        Stats.tick(State, Date.now());
        /* **Le mini-lecteur est réaffirmé.** Une fois par seconde : s'il a été
           poussé hors de l'écran (classe restée en place, geste interrompu), il
           revient de lui-même — sans dépendre d'un chemin de code précis. */
        if (now - self.lastMini > 1000) {
          self.lastMini = now;
          if (UI.reassertMini()) UI.paint(State, "réaffirmation");
          /* **Et rien de nous sur une page ouverte** : une playlist reste
             visible même si un chemin de code a laissé un de nos écrans en
             place. */
          if (UI.reassertSurfaces()) UI.paintChrome(State);
        }
        if (!State.playing || State.seeking) return;
        Spotify.calibrate();
        UI.paintProgress();
        /* Keep the Android media session / lock-screen scrubber honest: the
           old layer pushed a position only when it happened to scrape the DOM
           (>4 s drift, every 2 s), which made the lock screen lag behind. */
        if (now - self.lastPush > 15000) {
          self.lastPush = now;
          Bridge.mediaPosition(livePosition());
        }
      });
    },
  };

