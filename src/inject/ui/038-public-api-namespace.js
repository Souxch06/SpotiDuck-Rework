  /* ------------------------------------------------------------------ *
   * 18. Public API (namespace handle the app / debug console can use)
   * ------------------------------------------------------------------ */
  var lastPlaying = null;
  onState(function (s, reason) {
    /* Playback can also change from outside the UI (notification, widget,
     * Android Auto): keep the native wake/sleep state in sync with it. */
    if (s.playing !== lastPlaying) {
      var wasPlaying = lastPlaying;
      lastPlaying = s.playing;
      Actions.syncLocks();
      /* Optional (settings → "Relancer la lecture automatiquement"): the old
         layer's "permanent autoplay". Only for pauses we did not ask for. */
      if (!s.playing && wasPlaying && reason !== "optimistic") Auto.maybeResume();
    }
    UI.paint(s, reason);
    if (reason === "route" || reason === "route-sync") Login.apply();
  });

  window.SpotiDuckUI = {
    /* La voie des appels d'API, exposée pour le diagnostic (« pont » ou
       « navigateur », et la raison du dernier échec). */
    net: Net,
    version: VERSION,
    state: State,
    settings: Settings,
    /** Le garde-fou de contenu : ce que la feuille a dû rétablir pour que la
     *  page ne reste pas noire sous notre coque (voir `Content.apply`). */
    content: Content,
    /** L'accueil maison : ses données (`home.data`), ses filtres, son état. */
    home: Home,
    /** Votre bibliothèque : `load()`, ses éléments, son état. */
    library: Library,
    /** Vos statistiques d'écoute : `summary()`, `record()`, `clear()`. */
    stats: Stats,
    /** Change one setting (`theme`, `haptics`, `accentFromArt`, `tabbar`,
     *  `takeControl`, `resume`, `reduceMotion`) and persist it. */
    set: function (key, value) {
      return applySetting(key, value);
    },
    openPlayer: function () {
      Player.openSheet();
    },
    /* ---- playback API for the native side (notification, widget, Android
       Auto, assistant). All of them are idempotent: calling `play()` while
       already playing does nothing instead of toggling (a toggle racing with
       the notification is how you get "the pause button plays music"). */
    play: function () {
      if (!State.playing) Actions.playPause();
    },
    pause: function () {
      if (State.playing) Actions.playPause();
    },
    playPause: function () {
      Actions.playPause();
    },
    /** L'auto-test des commandes (voir `Engine.selfTest`) : une ligne à coller
     *  dans le diagnostic quand « les touches ne font rien ». */
    selfTest: function () {
      return Engine.selfTest();
    },
    next: function () {
      Actions.next();
    },
    previous: function () {
      Actions.prev();
    },
    like: function () {
      Actions.like();
    },
    seek: function (ms) {
      Actions.seek(Math.max(0, Number(ms) || 0));
    },
    closePlayer: function () {
      Player.closeSheet();
    },
    openQueue: function () {
      Queue.openSheet();
    },
    openMenu: function () {
      Sheets.open("menu");
    },
    /** Barre de navigation supérieure : notifications, amis, profil. */
    spotifyButton: function (which) {
      return Actions.spotifyButton(which);
    },
    openSettings: function () {
      Sheets.open("settings");
    },
    close: function () {
      Sheets.close();
    },
    /**
     * Hardware back button. Call this from `onBackPressed` (via
     * `evaluateJavascript`) — returns `true` when the UI consumed the press
     * (a panel was closed), `false` when the app should handle it itself.
     */
    back: function () {
      /* **Une ouverture en cours se défait.** Sans cela, un retour pendant
         qu'une playlist s'ouvre atterrissait sur l'onglet Accueil : la route
         n'avait pas encore changé, donc le retour croyait être sur l'accueil.
         On annule ce qu'on a poussé, et on reste où on était. */
      if (Open.busy) {
        Open.cancel();
        return true;
      }
      if (Back.top()) {
        Back.handle();
        return true;
      }
      if (State.route === "page") {
        Spotify.goBack();
        return true;
      }
      if (State.tab !== "home") {
        Router.tab("home");
        return true;
      }
      return false;
    },
    /** "Impossible de lancer la lecture ?" escape hatch (settings → reload). */
    reload: function () {
      Api.repair(true);
    },
    sync: function () {
      syncFromDom("manual");
    },
    /* exposed for tests / the demo harness */
    _internals: {
      Spotify: Spotify,
      Bridge: Bridge,
      Actions: Actions,
      UI: UI,
      Router: Router,
      Sheets: Sheets,
      Player: Player,
      Queue: Queue,
      Auto: Auto,
      Api: Api,
      Login: Login,
      LoginState: LoginState,
      Offline: Offline,
      Polish: Polish,
      Back: Back,
      Viewport: Viewport,
      Device: Device,
      Volume: Volume,
      Content: Content,
      Home: Home,
      Toast: Toast,
      Settings: Settings,
      Mirror: Mirror,
      Gestures: Gestures,
      Stats: Stats,
      Icons: ICONS,
    },
  };

  loadSettings();
  applyDensity(Settings.density);
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });