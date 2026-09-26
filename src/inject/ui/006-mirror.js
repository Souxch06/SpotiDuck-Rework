  /* ------------------------------------------------------------------ *
   * 5. Mirror — DOM → State (event driven, no 2 s polling loop)
   * ------------------------------------------------------------------ */
  var lastPush = { key: "", at: 0 };

  function syncFromDom(reason) {
    /* L'élément qui joue a peut-être été remplacé (nouvelle piste, vue changée) :
       c'ici qu'on le re-écoute, au rythme des mutations du DOM. */
    Media.watch();
    var patch = Spotify.read();
    if (patch.position !== undefined) {
      State.anchorPos = patch.position;
      State.anchorAt = performance.now();
    }
    if (patch.title !== undefined) patch.hasTrack = !!patch.title;
    emit(patch, reason || "sync");
  }

  function pushToAndroid() {
    var key = [State.title, State.artist, State.playing, State.repeat, State.liked, State.cover].join("|");
    var now = Date.now();
    if (key === lastPush.key && now - lastPush.at < 30000) return;
    lastPush.key = key;
    lastPush.at = now;
    Bridge.mediaStatus(State);
    Bridge.mediaPosition(livePosition());
  }

  var Mirror = {
    observer: null,
    probe: null,
    start: function () {
      var bar = pick(SEL.npBar);
      if (!bar) {
        /* La barre « lecture en cours » n'existe qu'une fois le web player
           prêt (et la session ouverte). On la guette au lieu d'abandonner :
           la coque, elle, est déjà affichée. */
        if (!this.probe && window.MutationObserver) {
          var self = this;
          this.probe = new MutationObserver(function () {
            if (!pick(SEL.npBar)) return;
            self.probe.disconnect();
            self.probe = null;
            self.start();
            startPlayer();
          });
          this.probe.observe(document.body, { childList: true, subtree: true });
        }
        return false;
      }
      if (this.observer) this.observer.disconnect();
      this.observer = new MutationObserver(function () {
        syncFromDom("dom");
      });
      this.observer.observe(bar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-checked", "aria-label", "src", "value"],
      });
      /* **La position suit le curseur de Spotify.** Le nœud `<input>` est
         recréé à chaque fois que React redessine la barre (changement de piste,
         ouverture d'une page) : un écouteur posé une fois sur le nœud du moment
         survivait sur un nœud détaché, et la progression restait figée jusqu'au
         prochain relevé. On écoute donc `bar` en **délégation** — l'événement
         `input` remonte, le nœud importé ou non — et on convertit avec la
         graduation **mesurée** : multiplier systématiquement par 1000 ancrail
         la position 1000 fois trop loin sur une page graduée en millisecondes
         (la barre partait à 100 % dès le premier relevé). */
      if (!Mirror.cursorBound) {
        Mirror.cursorBound = true;
        /* `document`, en capture : le conteneur lui-même peut être remplacé,
           l'événement `input` de la page y passe toujours. */
        document.addEventListener("input", Mirror.onCursor, true);
      }
      return true;
    },
    /** Le nœud écouté n'a pas d'importance : c'est l'événement qui parle. */
    onCursor: function (ev) {
      var node = ev && ev.target;
      var input = Spotify.progressInput();
      /* Un autre curseur de la page (volume, défilement) ne doit pas ancrer la
         position : on vérifie que c'est bien **celui de la lecture**. */
      if (!input || (node && node !== input && !(node.closest && node.closest('[data-testid="playback-progressbar"]')))) return;
      State.anchorPos = Spotify.ticksToMs(input.value);
      State.anchorAt = performance.now();
    },
  };

