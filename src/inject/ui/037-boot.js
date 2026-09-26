  /* ------------------------------------------------------------------ *
   * 17. Boot
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = typeof SD_CSS_SOURCES !== "undefined" ? SD_CSS_SOURCES : "";
    if (!css) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function markBody() {
    var html = document.documentElement;
    html.classList.add(BODY_CLASS);
    html.classList.add("sd-tab-home");
    html.classList.toggle("sd-reduce-motion", !!Settings.reduceMotion);
    /* `sd-root` marks Spotify's own markup (everything in <body> that is not
       our layer): the hardening stylesheet scopes its native-DOM rules on it,
       so they can never leak into the injected UI. */
    document.body.classList.add("sd-root");
    Theme.apply();
  }

  var bootTries = 0;
  /* **Le branchement ne se fait qu'une fois.** `boot` se rejoue jusqu'à soixante
     fois en attendant que le web player soit prêt (page lente, session fermée) :
     chaque passage ajoutait ses écouteurs et ses minuteurs — sur un téléphone
     qui met dix secondes à démarrer, trois écouteurs de statistiques posés vingt
     fois, soit soixante rappel à chaque changement de visibilité, et un
     rechargement de la bibliothèque programmé soixante fois. Le lecteur
     saccadait, et la page travaillait pour rien. */
  var wired = false;
  function boot() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    /* Le meta viewport AVANT les styles et la coque : toutes les tailles de la
       feuille sont calculées à partir de la largeur de mise en page. */
    Viewport.ensure();
    injectStyles();
    Device.apply();
    markBody();

    /* La coque d'abord, toujours : barre d'onglets, mini-lecteur, feuilles,
       écran d'accueil. C'est ce qui fait qu'un premier lancement ressemble à
       une application Android et non à la page web desktop de Spotify — la
       version précédente attendait le lecteur pour construire quoi que ce
       soit, donc l'écran de connexion restait une page web. */
    startShell();

    if (wired) {
      /* Un simple contrôle de cohérence à chaque réessai : notre feuille ne doit
         jamais laisser la page effacée. */
      if (bootTries % 4 === 0) Content.apply();
      if (Spotify.ready()) {
        startPlayer();
      } else if (bootTries++ < 60) {
        setTimeout(boot, Math.min(1500, 250 + bootTries * 150));
      }
      return;
    }
    wired = true;

    /* Notre feuille ne doit pas effacer la page : on vérifie tout de suite,
       puis à trois reprises — le contenu de Spotify arrive après la coque, et
       il est reconstruit à chaque navigation. */
    Content.apply();
    [600, 2000, 5000].forEach(function (ms) {
      window.setTimeout(function () {
        Content.apply();
        Home.refresh("contenu");
        Library.enter();
      }, ms);
    });
    /* L'écoute en cours est fermée quand l'application passe en arrière-plan ou
       se termine : sans ça, le temps mesuré depuis le dernier passage resterait
       dans la session et ne rejoindrait jamais les statistiques. */
    ["pagehide", "beforeunload"].forEach(function (name) {
      window.addEventListener(name, function () {
        Stats.flush();
      });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") Stats.flush();
    });

    /* L'accueil lit la page : il se rafraîchit quand le contenu arrive, quand on
       change d'onglet, et sur redimensionnement — jamais en boucle serrée. */
    Home.refresh("boot");
    /* La bibliothèque se construit ** même sans lecteur** : `paintChrome` n'est
       appelé qu'une fois la barre de lecture prête, et une page sans session
       (ou dont le lecteur n'a pas démarré) n'aurait alors jamais de page de
       bibliothèque — mesuré en CI : « bibliothèque maison absente » sur toutes
       les pages. La construire ici la rend visible par la sonde et le
       diagnostic, et prête dès le premier appui sur l'onglet. */
    Library.enter();
    /* L'historique récent de Spotify, quand le jeton de la page le permet : les
       statistiques ne commencent pas à zéro. Silencieux sinon. */
    window.setTimeout(function () {
      Stats.syncFromApi();
    }, 4000);
    /* …et à neuf secondes, si l'écran est toujours vide, on le dit (le contenu
       d'une page Spotify met quelques secondes à apparaître sur un téléphone,
       mais pas neuf). */
    window.setTimeout(function () {
      Content.alertIfBlank();
    }, 9000);

    if (Spotify.ready()) {
      startPlayer();
      return;
    }
    // Le web player démarre encore (splash, connexion…). On réessaie avec un
    // délai progressif, plafonné, au lieu d'une boucle toutes les 500 ms.
    if (bootTries++ < 60) {
      setTimeout(boot, Math.min(1500, 250 + bootTries * 150));
    }
  }

  /* Coque : tout ce qui ne dépend pas de la lecture. */
  var shellReady = false;
  function startShell() {
    if (shellReady) return;
    shellReady = true;

    UI.build();
    History.install();
    /* Nos liens ouvrent les pages **dans** le lecteur (module `Open`). */
    Open.bind();
    Api.watch();
    /* Les réponses du pont réseau arrivent ici (`window.__sdNet`). */
    Net.install();
    Polish.start();
    Login.apply();
    Offline.check();
    Sheets.paint();
    Router.sync();
    UI.paintChrome(State);

    /* Spotify is a single-page app: watch the main view for page changes and
       re-sync the route + chrome. One observer, no polling. */
    var main = pick(SEL.mainView);
    if (main && window.MutationObserver) {
      var pageObs = new MutationObserver(debounce(function () {
        Router.sync();
        syncFromDom("page");
        UI.paintChrome(State);
        Login.apply(); // the login page is rendered by the same container
        /* Une vue qui change, c'est le moment où une de nos règles peut se
           retrouver posée sur la mauvaise page : on range, et si la page
           n'affiche rien, on le dit (avec de quoi recharger). */
        UI.reassertSurfaces();
        Content.alertSoon(1500);
        /* La barre de lecture a pu être remplacée au passage : le guetteur du
           relais « Écouter sur cet appareil » se rebranche ici, pas ailleurs —
           c'est le seul endroit de la coque qui sache qu'une page a changé. */
        Auto.watch();
      }, 250));
      pageObs.observe(main, { childList: true, subtree: false });
    }

    /* L'écran marketing / la page de connexion n'ont pas de #main-view : on
       surveille la **page entière** pour l'écran d'accueil maison. Le body seul
       ne suffisait pas : quand Spotify (ou le banc de démonstration) remplit un
       conteneur déjà en place, aucune mutation n'atteint <body>, l'écran
       d'accueil n'était donc **jamais retiré** et restait posé par-dessus le
       lecteur — « c'est le bordel ». `apply()` ne fait que quelques
       `querySelector`, le débounce suffit à le rendre inoffensif. */
    if (window.MutationObserver) {
      var welcomeObs = new MutationObserver(
        debounce(function () {
          Welcome.apply();
        }, 300)
      );
      welcomeObs.observe(document.documentElement, { childList: true, subtree: true });
    }
    /* Filet de sécurité, **borné** : si aucune mutation n'est observée (page
       servie d'un bloc), on réévalue dix fois sur les vingt premières secondes,
       en chaîne de `setTimeout` — jamais un intervalle qui tourne sans fin (le
       banc refuse les boucles de sondage, et il a raison : elles vidaient la
       batterie dans les versions précédentes). */
    var welcomeTries = 0;
    (function welcomeWatch() {
      var shown = Welcome.apply();
      if (++welcomeTries >= 10 || (Spotify.ready() && !shown)) return;
      window.setTimeout(welcomeWatch, 2000);
    })();

    /* Re-apply the theme + repaint after a rotation or a keyboard resize.
       (Everything else adapts through CSS: the shell is sized in `vh`/`%` so
       no JS measurement is needed.) */
    window.addEventListener(
      "resize",
      debounce(function () {
        Device.apply();
        Theme.apply();
        UI.paintProgress();
        Welcome.apply();
        Content.apply();
        Home.refresh("resize");
        Library.apply();
      }, 200)
    );

    Bridge.uiReady();
    Actions.syncLocks();
  }

  /* Lecteur : ce qui n'a de sens qu'une fois la barre de lecture présente. */
  var playerReady = false;
  function startPlayer() {
    if (playerReady) return;
    playerReady = true;

    Mirror.start();
    Ticker.start();
    Home.refresh("lecteur");
    Auto.start();
    syncFromDom("boot");
    UI.paintChrome(State);

    Bridge.playLoaded();
    Bridge.mediaStatus(State);
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

