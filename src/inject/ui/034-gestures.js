  /* ------------------------------------------------------------------ *
   * 15. Gestures — swipe on the mini player, drag the sheet, scrub
   * ------------------------------------------------------------------ */
  var Gestures = {
    bind: function () {
      /* **Plus de gestes sur le lecteur.** Le mini-lecteur ne se déplace plus et
         la feuille ne se ferme plus au glissement : c'était la même famille de
         gestes que le défilement, et « le lecteur disparaît quand je scroll vers
         le bas » venait de là (un doigt posé sur la pochette pour faire défiler
         était pris pour un tirage de fermeture). Le lecteur est **statique** :
         il ne bouge et ne se ferme que sur une commande explicite (le bouton
         « Fermer », ou le retour d'Android). Le curseur de lecture, lui, reste
         glissant : c'est un curseur, pas le lecteur. */
      this.seekDrag();
      this.miniSeekDrag();
    },
    /* Barre de progression du mini-lecteur : on peut y poser le doigt pour se
       déplacer dans le morceau sans ouvrir le lecteur plein écran. */
    miniSeekDrag: function () {
      var rail = UI.el.miniSeek;
      var fill = UI.el.miniProgress;
      var cur = UI.el.miniCur;
      if (!rail) return;
      var dragging = false;
      function ratioFrom(ev) {
        var r = rail.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
      }
      function preview(ratio) {
        var ms = ratio * trackDurationMs();
        State.seekPreview = ms;
        fill.style.width = (ratio * 100).toFixed(2) + "%";
        if (cur) cur.textContent = fmtTime(ms);
      }
      rail.addEventListener("pointerdown", function (ev) {
        /* La durée annoncée par la page peut manquer (première seconde d'un
           titre) : tant que le curseur de Spotify existe, on sait où l'on va. */
        if (!trackDurationMs()) return;
        ev.stopPropagation(); // ne pas ouvrir le lecteur plein écran
        dragging = true;
        emit({ seeking: true }, "mini-seek-start");
        rail.classList.add("is-dragging");
        try {
          rail.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* WebViews plus anciennes */
        }
        preview(ratioFrom(ev));
      });
      rail.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        ev.stopPropagation();
        preview(ratioFrom(ev));
      });
      var end = function (ev) {
        if (!dragging) return;
        dragging = false;
        rail.classList.remove("is-dragging");
        /* Une seule vibration, et une seule voie de sortie : `seekRatio`
           (l'appui sur la barre ne doit pas non plus ouvrir la feuille). */
        Actions.seekRatio(ratioFrom(ev));
      };
      rail.addEventListener("pointerup", end);
      rail.addEventListener("pointercancel", end);
      /* Un simple appui sur la barre ne doit pas ouvrir la feuille. */
      ["click", "pointerdown", "pointerup"].forEach(function (type) {
        rail.addEventListener(type, function (ev) {
          ev.stopPropagation();
        });
      });
      /* Clavier, comme la barre du lecteur plein écran : une télécommande ou un
         clavier Bluetooth doit pouvoir se déplacer dans la piste. */
      rail.addEventListener("keydown", function (ev) {
        var step = ev.shiftKey ? 30000 : 5000;
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          Actions.seek(livePosition() + step);
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          Actions.seek(Math.max(0, livePosition() - step));
        } else if (ev.key === "Home" || ev.key === "End") {
          ev.preventDefault();
          Actions.seek(ev.key === "Home" ? 0 : trackDurationMs());
        }
      });
    },

    /* mini player: tap → open, swipe ← → next, swipe → → previous, swipe ↑ → open */
    /* full player: drag the header/artwork down to dismiss */
    /* seek bar: real touch scrubbing (the old layer had none — it only sent
       a synthetic `change` on the desktop <input type=range> from Android) */
    seekDrag: function () {
      var rail = UI.el.seekRail;
      var seek = UI.el.seek;
      var dragging = false;
      function ratioFrom(ev) {
        var r = rail.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
      }
      function preview(ratio) {
        var ms = ratio * trackDurationMs();
        State.seekPreview = ms;
        UI.el.seekFill.style.width = (ratio * 100).toFixed(2) + "%";
        UI.el.seekThumb.style.left = (ratio * 100).toFixed(2) + "%";
        UI.el.tCur.textContent = fmtTime(ms);
      }
      rail.addEventListener("pointerdown", function (ev) {
        /* Idem mini-lecteur : la durée annoncée peut manquer un instant, la
           course du curseur de Spotify sait où l'on va. */
        if (!trackDurationMs()) return;
        dragging = true;
        emit({ seeking: true }, "seek-start");
        seek.classList.add("is-dragging");
        try {
          rail.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* older WebViews */
        }
        preview(ratioFrom(ev));
      });
      rail.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        preview(ratioFrom(ev));
      });
      var end = function (ev) {
        if (!dragging) return;
        dragging = false;
        seek.classList.remove("is-dragging");
        Actions.seekRatio(ratioFrom(ev));
      };
      rail.addEventListener("pointerup", end);
      rail.addEventListener("pointercancel", end);
      /* keyboard support (the layer is also usable with a remote/TV remote) */
      seek.addEventListener("keydown", function (ev) {
        var step = ev.shiftKey ? 30000 : 5000;
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          Actions.seek(livePosition() + step);
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          Actions.seek(Math.max(0, livePosition() - step));
        } else if (ev.key === "Home" || ev.key === "End") {
          /* `End` sans repli de durée retombait sur 0 : la télécommande
             ramenait au début quand on voulait aller à la fin. */
          ev.preventDefault();
          Actions.seek(ev.key === "Home" ? 0 : trackDurationMs());
        }
      });
    },
  };

