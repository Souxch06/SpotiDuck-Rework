  /* ------------------------------------------------------------------ *
   * 11b. Bottom sheets — the player's "…" menu and the settings screen
   *      Both are ours (the queue reuses Spotify's own panel), so they share
   *      one animation, one drag-to-dismiss and one back-button contract with
   *      the full player sheet.
   * ------------------------------------------------------------------ */
  var MENU = {
    queue: { icon: ICONS.queueLine, label: Settings.labels.queue, run: function () { Queue.openSheet(); } },
    /* Remise à zéro des statistiques : elles sont locales et à nous, mais elles
       restent les siennes — un appui doit suffire à les effacer. */
    "stats-clear": {
      icon: ICONS.refreshLine,
      label: Settings.labels.statsClear,
      run: function () {
        Stats.clear();
        Toast.show(Settings.labels.statsCleared, 1800);
      },
    },
    lyrics: {
      icon: ICONS.lyricsLine,
      label: Settings.labels.lyrics,
      need: function () {
        return !!Spotify.lyricsButton();
      },
      run: function () {
        var b = Spotify.lyricsButton();
        if (b) b.click();
        else Toast.show(Settings.labels.lyricsUnavailable || Settings.labels.lyrics);
      },
    },
    devices: {
      icon: ICONS.deviceLine,
      label: Settings.labels.devices,
      need: function () {
        return !!Spotify.devicesButton();
      },
      run: function () {
        var b = Spotify.devicesButton();
        if (b) b.click();
      },
    },
    artist: {
      icon: ICONS.personLine,
      label: Settings.labels.viewArtist,
      need: function () {
        return !!pick(SEL.artist);
      },
      run: function () {
        Actions.openArtist();
      },
    },
    album: {
      icon: ICONS.discLine,
      label: Settings.labels.viewAlbum,
      need: function () {
        return !!Spotify.albumLink();
      },
      run: function () {
        Actions.openAlbum();
      },
    },
    share: { icon: ICONS.shareLine, label: Settings.labels.share, run: function () { Actions.share(); } },
    settings: { icon: ICONS.gearLine, label: Settings.labels.settings, run: function () { Sheets.open("settings"); } },
  };

  /* Factory defaults, used by the "reset" row. */
  var DEFAULTS = {
    theme: "auto",
    accentFromArt: true,
    reduceMotion: false,
    takeControl: true,
    resume: false,
    /* **La barre d'onglets du bas est éteinte par défaut**, comme dans
       `Settings` (la navigation est celle de l'application d'origine, en haut).
       Elle était notée `true` ici : « Réinitialiser les réglages » la
       rallumait, et l'utilisateur se retrouvait avec deux barres de navigation —
       l'une en haut, l'autre en bas, et une bande de 64 px réservée en trop. */
    tabbar: false,
    stats: true,
    haptics: true,
    homeBoard: true,
    libraryBoard: true,
    /* Densité d'affichage : les télémétries Android et la WebView ne rendent
       pas la même chose sur tous les appareils — c'est le seul réglage qui
       touche à la taille de toute l'interface. */
    density: "normal",
  };

