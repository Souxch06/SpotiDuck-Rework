  /* ------------------------------------------------------------------ *
   * 2. Spotify adapter — the only place that touches the web player's DOM
   * ------------------------------------------------------------------ */
  /**
   * **Les repères par libellé, toujours dans le lecteur.**
   *
   * « Suivant » et « Précédent » sont aussi les libellés des boutons d'avance et
   * de retour de la **navigation** de Spotify ; « Lecture » est celui de nos
   * propres boutons et le début de « Activer la lecture aléatoire ». Un repère
   * global par libellé appuie donc sur la mauvaise commande (relevé au banc :
   * un « lecture/pause » qui ne changeait rien, et une commande « suivant » qui
   * ne changeait pas de piste). On ne cherche ces libellés que dans les
   * conteneurs du lecteur.
   */
  var PLAYER_SCOPE = [
    "aside ",
    '[data-testid="player-controls"] ',
    '[data-testid="now-playing-bar"] ',
    '[data-testid="now-playing-widget"] ',
  ];
  function inPlayer(labels) {
    var list = [];
    PLAYER_SCOPE.forEach(function (scope) {
      labels.forEach(function (label) {
        list.push(scope + "button[" + label + "]");
      });
    });
    return list;
  }

  var SEL = {
    mainView: ["#main-view", "main", ".main-view-container__scroll-node"],
    sidebar: ["#Desktop_LeftSidebar_Id"],
    panel: ["#Desktop_PanelContainer_Id"],
    navBar: ["#global-nav-bar"],
    homeBtn: ['#global-nav-bar button[data-testid="home-button"]', 'button[data-testid="home-button"]'],
    searchBtn: [
      '#global-nav-bar a[href="/search"]',
      '#global-nav-bar button[data-testid="search-button"]',
      'a[href="/search"]',
      'button[data-testid="search-button"]',
    ],
    searchInput: ['input[data-testid="search-input"]', 'form[role="search"] input'],
    /* Le second candidat de cette liste était un reste de brouillon
       (`…now-playing-bar"] root`) : `pick` essaie les repères dans l'ordre, il
       ne servait donc jamais — mais il faisait croire à une variante prévue.
       Les seules formes connues du lecteur sont `aside` et `footer`. */
    npBar: [
      'aside[data-testid="now-playing-bar"]',
      'footer[data-testid="now-playing-bar"]',
      'div[data-testid="now-playing-bar"]',
    ],
    widget: ['div[data-testid="now-playing-widget"]'],
    cover: [
      'div[data-testid="now-playing-widget"] img[data-testid="cover-art-image"]',
      'aside[data-testid="now-playing-bar"] img[data-testid="cover-art-image"]',
      'img[data-testid="cover-art-image"]',
    ],
    title: ['a[data-testid="context-item-link"]', '[data-testid="context-item-link"]'],
    artist: [
      'a[data-testid="context-item-info-artist"]',
      'a[data-testid="context-item-info-show"]',
      '[data-testid="context-item-info-artist"]',
    ],
    like: [
      'div[data-testid="now-playing-widget"] > div:last-child > button',
      'button[data-testid="add-button"]',
      'button[data-testid="now-playing-widget-like-button"]',
    ].concat(
      inPlayer([
        'aria-label^="Retirer des Titres likés"',
        'aria-label^="Ajouter aux Titres likés"',
        'aria-label^="Enregistrer dans vos Titres"',
        'aria-label^="Retirer des Titres"',
        'aria-label^="Remove from Liked"',
        'aria-label^="Save to your Liked"',
        'aria-label^="Add to Liked"',
      ])
    ),
    play: [
      'aside button[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-play"]',
      'button[data-testid="control-button-pause"]',
    ].concat(
      /* Les libellés **commencent** par ces mots : `*=` attrapait « Activer la
         lecture aléatoire » (le bouton du mode aléatoire). */
      inPlayer([
        'aria-label="Lecture"',
        'aria-label^="Reprendre la lecture"',
        'aria-label="Pause"',
        'aria-label^="Mettre en pause"',
        'aria-label="Play"',
        'aria-label="Resume"',
      ])
    ),
    next: [
      'aside button[data-testid="control-button-skip-forward"]',
      'button[data-testid="control-button-skip-forward"]',
      'button[data-testid="control-button-next"]',
    ].concat(
      inPlayer([
        'aria-label="Suivant"',
        'aria-label^="Passer à la piste suivante"',
        'aria-label="Next"',
        'aria-label="Next track"',
      ])
    ),
    prev: [
      'aside button[data-testid="control-button-skip-back"]',
      'button[data-testid="control-button-skip-back"]',
      'button[data-testid="control-button-previous"]',
    ].concat(
      inPlayer([
        'aria-label="Précédent"',
        'aria-label^="Passer à la piste précédente"',
        'aria-label="Previous"',
        'aria-label="Previous track"',
      ])
    ),
    shuffle: [
      'aside button[data-testid="control-button-shuffle"]',
      'button[data-testid="control-button-shuffle"]',
    ].concat(
      inPlayer([
        'aria-label^="Activer la lecture aléatoire"',
        'aria-label^="Désactiver la lecture aléatoire"',
        'aria-label^="Shuffle"',
      ])
    ),
    repeat: [
      'aside button[data-testid="control-button-repeat"]',
      'button[data-testid="control-button-repeat"]',
    ].concat(
      inPlayer([
        'aria-label^="Activer la répétition"',
        'aria-label^="Désactiver la répétition"',
        'aria-label^="Répéter"',
        'aria-label^="Repeat"',
        'aria-label^="Enable repeat"',
      ])
    ),
    progress: [
      'div[data-testid="playback-progressbar"] input[type="range"]',
      'aside input[type="range"][max]',
    ],
    lyrics: ['button[data-testid="lyrics-button"]'],
    /* Le micro « karaoké » et le curseur de volume : Spotify les expose dans
       sa propre barre. On ne les invente pas — s'ils sont absents, le bouton
       correspondant n'apparaît pas (plutôt qu'un bouton mort). */
    karaoke: ['button[data-testid="karaoke-button"]', 'button[data-testid="mic-button"]'],
    volume: [
      'div[data-testid="volume-bar"] input[type="range"]',
      '[data-testid="volume-bar"] input[type="range"]',
    ],
    /* --- session extras (take control, links, login) --- */
    trackLink: ['a[data-testid="context-item-link"]', '[data-testid="context-item-link"]'],
    albumLink: [
      'div[data-testid="now-playing-widget"] a[href*="/album/"]',
      'aside[data-testid="now-playing-bar"] a[href*="/album/"]',
      'div[data-testid="now-playing-widget"] img[data-testid="cover-art-image"]',
    ],
    /* Spotify's "this device is not playing" call-to-action. The native app
       auto-clicks it (the old layer did it from a 5 s interval); we look for
       it with an explicit selector first and a label regex as a fallback. */
    takeover: [
      'button[data-testid="takeover-button"]',
      'div[data-testid="now-playing-bar"] div.encore-bright-accent-set button',
      'aside[data-testid="now-playing-bar"] div.encore-bright-accent-set button',
      'aside[data-testid="now-playing-bar"] button[aria-label]',
    ],
    takeoverRows: ['aside[data-testid="now-playing-bar"] ul[role="list"] li[role="listitem"] div[role="button"]'],
    loginPage: ['div[data-testid="login-page"]', 'form[data-testid="login-form"]', '#login-username'],
    webPlayerLink: ['button[data-testid="web-player-link"]', 'a[data-testid="web-player-link"]'],
    pageH1: ['main h1', '#main-view h1'],
    pageSection: ["main section[data-testid]", "#main-view section[data-testid]"],
  };

