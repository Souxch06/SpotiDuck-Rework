  /* ------------------------------------------------------------------ *
   * 11c. Back — the Android back button closes our panels first.
   *      Opening a panel pushes ONE history entry, so the WebView never
   *      leaves the app by accident (the old layer had no handling at all).
   * ------------------------------------------------------------------ */
  var Back = {
    pushed: false,
    top: function () {
      if (Sheets.active) return "sheet";
      if (Queue.open) return "queue";
      if (Player.open) return "player";
      return null;
    },
    sync: function () {
      if (this.top() && !this.pushed) {
        this.pushed = true;
        try {
          history.pushState({ sd: "panel" }, "");
        } catch (e) {}
      }
    },
    release: function () {
      if (!this.pushed) return;
      this.pushed = false;
      try {
        history.back();
      } catch (e) {}
    },
    /** Returns true when the press was consumed by us. */
    handle: function () {
      var t = this.top();
      if (!t) return false;
      this.pushed = false; // set first: close() must not pop twice
      if (t === "sheet") Sheets.close(false);
      else if (t === "queue") Queue.close();
      else Player.closeSheet();
      if (this.top()) this.sync(); // a sheet closed over the player → one more
      return true;
    },
  };
  window.addEventListener("popstate", function () {
    /* L'événement que **nous** émettons pour ouvrir une page n'est pas un
       retour de l'utilisateur : il ne doit pas fermer un panneau. */
    if (Open.synthetic) return;
    if (Back.pushed) Back.handle();
  });

