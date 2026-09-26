  /* ------------------------------------------------------------------ *
   * 16. Theme detection (follow Spotify's own palette)
   * ------------------------------------------------------------------ */
  var Theme = {
    apply: function () {
      var light = false;
      if (Settings.theme === "light") light = true;
      else if (Settings.theme === "auto") {
        light = !!(
          document.querySelector(".encore-light-theme") ||
          (getComputedStyle(document.body).backgroundColor || "").match(/rgba?\(2[0-9]{2}/)
        );
      }
      document.documentElement.classList.toggle("sd-theme-light", light);
    },
  };

