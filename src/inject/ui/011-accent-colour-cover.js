  /* ------------------------------------------------------------------ *
   * 9. Accent colour (cover art → player gradient)
   *    Cross-origin covers can taint the canvas: every step is guarded and
   *    falls back to a deterministic hue derived from the track name, so the
   *    player never ends up with a flat black background.
   * ------------------------------------------------------------------ */
  var Accent = {
    cache: {},
    apply: function (url, seed) {
      var html = document.documentElement;
      if (!Settings.accentFromArt || !url) {
        html.style.removeProperty("--sd-player-bg");
        html.style.removeProperty("--sd-mini-bg");
        return;
      }
      if (this.cache[url]) {
        this.set(this.cache[url]);
        return;
      }
      var self = this;
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        var rgb = self.sample(img);
        if (!rgb) rgb = self.fallback(seed || url);
        self.cache[url] = rgb;
        self.set(rgb);
      };
      img.onerror = function () {
        var rgb = self.fallback(seed || url);
        self.cache[url] = rgb;
        self.set(rgb);
      };
      img.src = url;
    },
    /** Average the most saturated pixel cluster of a 24×24 thumbnail. */
    sample: function (img) {
      try {
        var c = document.createElement("canvas");
        c.width = c.height = 24;
        var ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        var data = ctx.getImageData(0, 0, 24, 24).data;
        var r = 0, g = 0, b = 0, n = 0, best = null, bestScore = -1;
        for (var i = 0; i < data.length; i += 4) {
          var R = data[i], G = data[i + 1], B = data[i + 2];
          var max = Math.max(R, G, B), min = Math.min(R, G, B);
          var sat = max === 0 ? 0 : (max - min) / max;
          var lum = (R * 0.299 + G * 0.587 + B * 0.114) / 255;
          var score = sat * (1 - Math.abs(lum - 0.45));
          if (score > bestScore) {
            bestScore = score;
            best = [R, G, B];
          }
          r += R; g += G; b += B; n++;
        }
        var avg = [r / n, g / n, b / n];
        var base = bestScore > 0.25 ? best : avg;
        return [Math.round(base[0]), Math.round(base[1]), Math.round(base[2])];
      } catch (e) {
        return null; // tainted canvas (no CORS header) → caller falls back
      }
    },
    fallback: function (seed) {
      var hue = hashHue(String(seed || "spotiduck"));
      var c = hslToRgb(hue, 0.45, 0.28);
      return c;
    },
    /** Darken/saturate for a real-looking Spotify gradient. */
    set: function (rgb) {
      var deep = mix(rgb, [0, 0, 0], 0.62);
      var html = document.documentElement;
      html.style.setProperty(
        "--sd-player-bg",
        "linear-gradient(to bottom, rgb(" + deep.join(",") + ") 0%, #121212 46%, #000 100%)"
      );
      html.style.setProperty("--sd-mini-bg", "rgb(" + mix(rgb, [0, 0, 0], 0.76).join(",") + ")");
      html.style.setProperty("--sd-accent", "rgb(" + rgb.join(",") + ")");
    },
  };

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(function (v) {
      return Math.round((v + m) * 255);
    });
  }

