  /* ------------------------------------------------------------------ *
   * 10-ter. Volume — celui de Spotify, pas un second
   * ------------------------------------------------------------------ */
  var Volume = {
    get: function () {
      var i = Spotify.volumeInput();
      return i ? clamp(Math.round(Number(i.value) || 0), 0, 100) : 0;
    },
    set: function (value) {
      var i = Spotify.volumeInput();
      if (!i) return;
      var v = clamp(Math.round(Number(value) || 0), 0, 100);
      i.value = String(v);
      /* Spotify écoute `input` ; `change` est là pour les moteurs qui ne
         relâchent qu'au relâchement du doigt. */
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new Event("change", { bubbles: true }));
    },
  };

