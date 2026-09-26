  /* ------------------------------------------------------------------ *
   * 5 bis. L'élément qui joue, **écouté** (aucun interrogateur périodique)
   *
   * La page tient son état dans un `<audio>` ; les mutations du DOM, elles,
   * peuvent être rares (le lecteur ne touch pas à l'arbre pendant qu'il joue,
   * ou n'y touche plus du tout quand la barre est hors écran). Sans cette
   * écoute, la coque restait sur une position figée et sur « aucun titre » —
   * et « aucun titre » désactivait ses propres commandes. Les événements de
   * l'élément sont la source la plus directe qui existe.
   * ------------------------------------------------------------------ */
  var MEDIA_EVENTS = ["play", "pause", "ended", "timeupdate", "seeked", "durationchange"];
  var Media = {
    el: null,
    onEvent: function (ev) {
      var m = Media.el;
      if (!m || !ev) return;
      if (ev.type === "timeupdate") {
        /* Le ticker extrapole déjà la position depuis la dernière ancre ; on ne
           recale que si l'écart devient visible, et jamais pendant un geste. */
        if (State.seeking) return;
        var p = Math.round(Number(m.currentTime) * 1000) || 0;
        if (Math.abs(p - livePosition()) > 1500) {
          emit({ position: p, anchorPos: p, anchorAt: performance.now() }, "media");
        }
        return;
      }
      syncFromDom("media");
    },
    /** Branché sur l'élément courant, s'il a changé. Appelé à chaque
     *  synchronisation du DOM : c'est l'événement qui nous prévient, pas une
     *  boucle. */
    watch: function () {
      var m = null;
      try {
        m = Spotify.mediaEl();
      } catch (e) {
        m = null;
      }
      if (m === Media.el) return;
      if (Media.el) {
        for (var i = 0; i < MEDIA_EVENTS.length; i++) {
          try {
            Media.el.removeEventListener(MEDIA_EVENTS[i], Media.onEvent);
          } catch (e) {
            /* élément déjà jeté */
          }
        }
      }
      Media.el = m;
      if (!m) return;
      for (var j = 0; j < MEDIA_EVENTS.length; j++) {
        try {
          m.addEventListener(MEDIA_EVENTS[j], Media.onEvent);
        } catch (e) {
          /* un <video> sans ces événements : tant pis, on garde les autres */
        }
      }
      syncFromDom("media");
    },
  };

