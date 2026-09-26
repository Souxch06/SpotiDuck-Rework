  /* ------------------------------------------------------------------ *
   * 13. Queue sheet (Spotify's own "file d'attente" panel, shown on top of
   *     the mini player — no re-implementation, so it can never desync)
   * ------------------------------------------------------------------ */
  var Queue = {
    open: false,
    toggle: function () {
      this.open ? this.close() : this.openSheet();
    },
    openSheet: function () {
      var panel = pick(SEL.panel);
      if (!panel) {
        var q = Spotify.queueButton();
        if (q) q.click();
        return;
      }
      this.open = true;
      UI.paintChrome(State);
      Back.sync();
      buzz(6);
    },
    close: function () {
      if (!this.open) return;
      this.open = false;
      UI.paintChrome(State);
      Back.release();
    },
  };

