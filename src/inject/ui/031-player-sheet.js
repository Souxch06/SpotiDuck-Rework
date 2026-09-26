  /* ------------------------------------------------------------------ *
   * 12. Player sheet
   * ------------------------------------------------------------------ */
  var Player = {
    open: false,
    openSheet: function () {
      if (this.open) return;
      this.open = true;
      document.documentElement.classList.add("sd-player-open");
      UI.el.player.setAttribute("aria-hidden", "false");
      UI.paintChrome(State);
      Back.sync();
      buzz(8);
      var img = UI.el.artImg;
      if (img) {
        img.style.transition = "none";
        img.style.transform = "scale(0.92)";
        requestAnimationFrame(function () {
          img.style.transition = "transform 320ms cubic-bezier(.32,.72,0,1)";
          img.style.transform = "";
        });
      }
    },
    closeSheet: function () {
      if (!this.open) return;
      this.open = false;
      document.documentElement.classList.remove("sd-player-open");
      UI.el.player.setAttribute("aria-hidden", "true");
      UI.el.player.style.removeProperty("--sd-drag");
      UI.el.player.classList.remove("is-settling");
      Sheets.close(false); // the options sheet never outlives the player
      UI.paintChrome(State);
      Back.release();
      buzz(4);
    },
  };

