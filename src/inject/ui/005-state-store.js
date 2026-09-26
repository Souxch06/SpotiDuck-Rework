  /* ------------------------------------------------------------------ *
   * 4. State store
   * ------------------------------------------------------------------ */
  var State = {
    title: "",
    artist: "",
    cover: "",
    playing: false,
    position: 0,
    duration: 0,
    liked: false,
    repeat: "off",
    shuffle: false,
    hasTrack: false,
    route: "other",
    tab: "home",
    /* local interpolation between two DOM reads, for a smooth progress bar */
    anchorPos: 0,
    anchorAt: 0,
    seeking: false,
    seekPreview: 0,
  };

  var listeners = [];
  function onState(fn) {
    listeners.push(fn);
  }
  function emit(patch, reason) {
    var before = JSON.stringify(State);
    for (var k in patch) if (patch[k] !== undefined && patch[k] !== null) State[k] = patch[k];
    if (before === JSON.stringify(State)) return;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](State, reason);
      } catch (e) {
        /* one broken listener must not break the UI */
      }
    }
  }

  /** The position to display right now (extrapolated while playing). */
  function livePosition() {
    if (State.seeking) return State.seekPreview;
    if (!State.playing) return State.anchorPos;
    var dt = performance.now() - State.anchorAt;
    return clamp(State.anchorPos + dt, 0, State.duration || Infinity);
  }

  /**
   * La durée de la piste, en millisecondes — **avec un repli mesuré**.
   *
   * `State.duration` vaut 0 tant que la page n'a rien annoncé : tout ce qui est
   * proportionnel à la durée (aperçu du geste, temps affiché) tombait alors à 0,
   * et poser le doigt sur la barre de progression ramenait au début du morceau.
   * La course du curseur de Spotify, elle, est connue dès que le curseur existe:
   * c'est son `max`.
   */
  function trackDurationMs() {
    var known = Number(State.duration) || 0;
    if (known > 0) return known;
    var input = Spotify.progressInput();
    var max = input ? parseFloat(input.getAttribute("max")) : 0;
    return isFinite(max) && max > 0 ? Spotify.ticksToMs(max) : 0;
  }

