  /* ------------------------------------------------------------------ *
   * 1. Settings (persisted in the WebView, restored on next launch)
   * ------------------------------------------------------------------ */
  var Settings = {
    /* Appearance */
    theme: "auto", // auto | dark | light
    accentFromArt: true, // colour the player with the cover art
    reduceMotion: false, // kill our animations (battery / low-end devices)
    /* Playback */
    takeControl: true, // click Spotify's "Écouter sur cet appareil" prompt
    resume: false, // resume playback when something else pauses it
    /* Interface */
    /* Barre d'onglets en BAS : désactivée par défaut depuis la v2.6.4 — la
       navigation est celle de l'application d'origine, en HAUT (`.sd-nav`).
       Le réglage reste disponible pour ceux qui préfèrent les onglets. */
    tabbar: false,
    /* Statistiques d'écoute : locales au téléphone, activées par défaut. */
    stats: true,
    haptics: true,
    /* Accueil maison : notre page d'accueil (données de la page, mise en page
       de l'application) au lieu de l'accueil du web player, dont la mise en page
       de bureau ne tient pas sur un téléphone. Un interrupteur la remplace par
       l'accueil de Spotify. */
    homeBoard: true,
    /* Bibliothèque maison : notre page (playlists, titres likés, albums,
       artistes suivis, podcasts du compte) au lieu de la barre latérale de
       Spotify, qui peut se retrouver vide sans qu'on puisse la réparer. */
    libraryBoard: true,
    /* Densité d'affichage : le seul réglage qui change la taille de TOUTE
       l'interface (voir `applyDensity`) — compact | normal | large. */
    density: "normal",
    labels: {
      app: "SpotiDuck",
      home: "Accueil",
      search: "Rechercher",
      library: "Bibliothèque",
      back: "Retour",
      queue: "File d'attente",
      devices: "Appareils",
      share: "Partager",
      lyrics: "Paroles",
      like: "Ajouter aux Titres likés",
      unlike: "Retirer des Titres likés",
      play: "Lecture",
      pause: "Pause",
      next: "Suivant",
      prev: "Précédent",
      notifications: "Notifications",
      friends: "Activité des amis",
      profile: "Profil",
      notAvailable: "Indisponible ici — Spotify ne propose pas cet écran sur cette page",
      /* Les commandes de lecture passent par les boutons de Spotify ; quand
         cette version de la page ne les expose pas (disposition téléphone,
         repères renommés), on le dit au lieu de laisser un bouton muet. */
      transportMissing: "Ces commandes ne répondent pas sur cette page : le lecteur de Spotify ne les expose pas ici",
      /* Quand rien ne joue, les commandes de Spotify sont **désactivées** :
         appuyer ne peut rien faire, et c'est la vraie raison. */
      transportNoTrack: "Rien ne joue en ce moment — lancez une musique d'abord",
      progress: "Position de lecture",
      shuffle: "Lecture aléatoire",
      repeat: "Répéter",
      nowPlaying: "Lecture en cours",
      noTrack: "Aucun titre en lecture",
      miniSignedOut: "Non connecté",
      miniSignedOutHint: "Appuyez pour vous connecter",
      volume: "Volume",
      karaoke: "Karaoké",
      /* Accueil maison */
      homeMorning: "Bonjour",
      homeEvening: "Bonsoir",
      homeSub: "Votre musique, vos podcasts",
      homeAll: "Tout",
      homeMusic: "Musique",
      homePodcasts: "Podcasts",
      homeMore: "Tout afficher",
      homeEmptyCategory: "Rien dans cette catégorie pour l\'instant",
      homeBoard: "Accueil SpotiDuck",
      /* Bibliothèque maison */
      libraryBoard: "Bibliothèque SpotiDuck",
      libraryAll: "Tout",
      libraryPlaylists: "Playlists",
      libraryAlbums: "Albums",
      libraryArtists: "Artistes",
      libraryShows: "Podcasts",
      libraryLiked: "Titres likés",
      libraryTracks: "%s titres",
      librarySummary: "Votre bibliothèque",
      libraryLoading: "Chargement de votre bibliothèque…",
      libraryLoadingProgress: "Chargement de votre bibliothèque… (%s/%s)",
      libraryTimeout: "Votre bibliothèque n'a pas répondu à temps.",
      libraryEmpty: "Aucune playlist, aucun album ni artiste enregistré pour ce compte.",
      libraryNoToken: "Connectez-vous à Spotify pour retrouver votre bibliothèque.",
      libraryError: "Votre bibliothèque n'a pas répondu pour l'instant.",
      libraryWhy: "Raison : %s.",
      libraryGuest: "Le lecteur n'est pas connecté à Spotify : connecte-toi, puis appuie sur Réessayer.",
      libraryUnknown: "Je n'ai pas pu vérifier à quel compte appartient le lecteur.",
      libraryAccount: "Compte %s",
      librarySignIn: "Se connecter à Spotify",
      libraryFromSpotify: "%s playlists lues dans Spotify",
      libraryHeaders: "En-têtes de la page : %s",
      libraryScan: "Lignes trouvées — %s",
      libraryRefreshing: "Actualisation en cours…",
      libraryMine: "Votre playlist",
      libraryFollowed: "Suivie · %s",
      libraryInYours: "Dans votre bibliothèque",
      libraryLikedHint: "Vos titres likés",
      libraryIgnored: "%s playlists recommandées ignorées (elles ne sont pas au compte)",
      libraryIgnoredOne: "1 playlist recommandée ignorée (elle n'est pas au compte)",
      librarySidebar: "Lus dans la liste de Spotify (%s éléments) — l'API du lecteur n'a pas répondu.",
      libraryLog: "Détails des essais",
      libraryLogHint: "Pourquoi l'API n'a pas répondu",
      libraryCountOne: "%s élément",
      libraryCountMany: "%s éléments",
      opening: "Ouverture…",
      openingOf: "Ouverture de « %s »…",
      libraryTokenAge: "Jeton capté %s · /me → %s",
      libraryTokenRefresh: "Jeton redemandé à la page : %s",
      libraryRetry: "Réessayer",
      libraryHint: "Vous pouvez aussi retrouver celle de Spotify : Réglages → Bibliothèque SpotiDuck.",
      /* Statistiques d'écoute */
      stats: "Statistiques d'écoute",
      statsTitle: "Vos statistiques",
      statsListened: "Temps d'écoute",
      statsWeek: "Cette semaine",
      statsToday: "Aujourd'hui",
      statsTracks: "Titres différents",
      statsArtists: "Artistes",
      statsTopArtists: "Vos artistes du moment",
      statsTopTracks: "Vos titres les plus écoutés",
      statsDays: "Ces sept derniers jours",
      statsBands: "Quand vous écoutez",
      statsDiscovery: "Découvertes de la semaine",
      statsStreak: "Jours d'affilée",
      statsFavBand: "Moment préféré",
      statsFavDay: "Jour préféré",
      /* La page refaite : durées d'abord, nombres expliqués. */
      statsTimeSection: "Temps écouté",
      statsNumbersSection: "Ce que vous écoutez",
      statsTotal: "Depuis le début",
      statsPlayed: "Titres écoutés",
      statsHintListen: "%s écoutées",
      statsHintOneListen: "1 écoute",
      statsHintTrack: "titres passés, reprises comprises",
      statsHintDifferent: "au moins un titre chacun",
      statsHintArtist: "au moins un titre écouté",
      statsHintStreak: "jours de suite avec une écoute",
      statsSince: "Depuis le %s",
      statsLead: "Temps écouté : %s · %s",
      statsNoteMeasure:
        "Le temps est mesuré pendant l'écoute dans SpotiDuck, seconde par seconde ; un titre survolé moins de dix secondes ne compte pas.",
      statsNoteEstimate:
        "Dont %s venant de l'historique Spotify : la durée annoncée des titres, pas le temps réellement écouté.",
      statsMinute: "%s min",
      statsBandShare: "%s · %s %",
      statsAt: "à %s",
      statsEmpty: "Écoutez un titre : vos statistiques commenceront ici",
      statsClear: "Effacer mes statistiques",
      statsCleared: "Statistiques effacées",
      bandNight: "La nuit",
      bandMorning: "Le matin",
      bandAfternoon: "L'après-midi",
      bandEvening: "Le soir",
      weekdays: ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"],
      weekdaysShort: ["D", "L", "M", "M", "J", "V", "S"],
      likedSongs: "Titres likés",
      stuckTitle: "Le lecteur ne répond pas",
      stuckText:
        "Trois commandes n'ont rien déplacé sur la page. Le texte ci-dessous dit " +
        "exactement ce que la page nous renvoie — copie-le et envoie-le tel quel, " +
        "il se lit mieux qu'une description.",
      blankTitle: "La page n'a rien affiché",
      blankText:
        "Spotify a bien répondu, mais son contenu est resté vide (%s). C'est presque toujours un chargement qui n'a pas abouti : rechargez. Si ça recommence, copiez le diagnostic et envoyez-le.",
      reload: "Recharger",
      reloading: "Rechargement…",
      copyDiagnostic: "Copier le diagnostic",
      diagnosticCopied: "Diagnostic copié",
      close: "Fermer",
      queueEmpty: "La file d'attente est vide",
      /* sheets */
      options: "Options",
      settings: "Paramètres",
      groupLook: "Apparence",
      groupPlay: "Lecture",
      groupUi: "Interface",
      groupAbout: "À propos",
      groupUiNative: "Interface",
      nativeUi: "Utiliser l'interface Spotify",
      nativeUiHint: "Ouvre le choix : interface Spotify native ou couche SpotiDuck",
      playProtect: "Vérification Play Protect",
      playProtectHint: "Ouvre le réglage qui bloque les installations d'applications venues d'ailleurs : dans le Play Store, décoche « Analyser les applis avec Play Protect ».",
      playProtectManual: "Play Store → Play Protect → ⚙️ → décocher « Analyser les applis »",
      display: "Affichage",
      displayHint: "Appuie pour copier les infos d'affichage",
      theme: "Thème",
      themeAuto: "Auto",
      themeDark: "Sombre",
      themeLight: "Clair",
      accent: "Couleur de la pochette",
      reduceMotion: "Réduire les animations",
      takeControl: "Prendre la main sur la lecture",
      resume: "Relancer la lecture automatiquement",
      showTabbar: "Barre de navigation",
      haptics: "Retour haptique",
      viewArtist: "Voir l'artiste",
      viewAlbum: "Voir l'album",
      /* `reload` est lu à deux endroits qui ne demandent pas la même phrase :
         le bouton de l'alerte (« la page n'a rien affiché ») dit simplement
         « Recharger », la ligne des réglages dit ce qu'elle recharge. Une seule
         clé pour les deux écrasait l'une par l'autre — la deuxième écriture
         gagnait, et l'alerte proposait « Recharger le lecteur » pour une page
         qui n'a justement pas de lecteur. */
      reloadPlayerAction: "Recharger le lecteur",
      reset: "Réinitialiser les réglages",
      version: "Version de l'interface",
      takeover: "Lecture transférée sur cet appareil",
      unlock: "Déblocage du lecteur…",
      reloadPlayer: "Session expirée — rechargement du lecteur…",
      /* Deux phrases qui manquaient à l'appel : sans elles, le message était
         `undefined` — un message qui affiche « undefined » est plus trompeur
         qu'un silence (vu sur le téléphone, après une session fermée). */
      sessionLost: "Session perdue — reconnecte-toi pour reprendre la lecture.",
      lyricsUnavailable: "Pas de paroles pour ce titre sur cette page",
      resetDone: "Réglages réinitialisés",
      copied: "Lien copié",
      classicLogin: "Se connecter avec e-mail et mot de passe",
      offline: "Hors connexion — lecture indisponible",
      /* écran d'accueil (session déconnectée) */
      density: "Taille de l'interface",
      densityCompact: "Compacte",
      densityNormal: "Normale",
      densityLarge: "Grande",
      welcomeTitle: "SpotiDuck",
      welcomeText: "Connecte-toi à ton compte Spotify pour retrouver ta musique.",
      welcomeCta: "Se connecter",
      welcomeNote: "Connexion par e-mail et mot de passe disponible",
      /* haptic patterns, in milliseconds */
      buzzTap: 8,
      buzzAction: 10,
    },
  };

  /**
   * **Ce qui est gardé d'un lancement à l'autre.**
   *
   * La liste était écrite à la main, en deux endroits (la lecture et
   * l'écriture), et trois réglages n'y figuraient pas : « Statistiques »,
   * « Accueil SpotiDuck » et « Bibliothèque SpotiDuck ». L'utilisateur les
   * changeait, l'application obéissait — puis le moindre redémarrage les
   * remettait en place (« mes réglages ne sont pas gardés »). Une seule liste,
   * lue et écrite au même endroit : un réglage ajouté est persisté par
   * construction, il ne peut plus être oublié à moitié.
   */
  var PERSIST = [
    "theme",
    "density",
    "haptics",
    "accentFromArt",
    "tabbar",
    "takeControl",
    "resume",
    "reduceMotion",
    "stats",
    "homeBoard",
    "libraryBoard",
  ];

  function loadSettings() {
    try {
      var raw = localStorage.getItem("sd.ui.settings");
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return;
      PERSIST.forEach(function (k) {
        var kind = typeof Settings[k];
        if (kind === "boolean") {
          if (typeof o[k] === "boolean") Settings[k] = o[k];
        } else if (kind === "string" && typeof o[k] === "string" && o[k]) {
          Settings[k] = o[k];
        }
      });
      /* Deux valeurs ne sont pas acceptées n'importe comment : un thème et une
         densité inconnus laisseraient la feuille sans règle (ni sombre, ni
         clair) plutôt que de retomber sur le réglage par défaut. */
      if (!/^(auto|dark|light)$/.test(Settings.theme)) Settings.theme = "auto";
      if (!/^(compact|normal|large)$/.test(Settings.density)) Settings.density = "normal";
    } catch (e) {
      /* private mode / quota — defaults are fine */
    }
  }
  function saveSettings() {
    try {
      var out = {};
      for (var i = 0; i < PERSIST.length; i++) {
        var k = PERSIST[i];
        if (k in Settings) out[k] = Settings[k];
      }
      localStorage.setItem("sd.ui.settings", JSON.stringify(out));
    } catch (e) {
      /* ignore */
    }
  }

