  /* ------------------------------------------------------------------ *
   * 14. Router — tab bar ↔ web player pages
   * ------------------------------------------------------------------ */
  var Router = {
    tab: function (name) {
      if (name === State.tab && name !== "library") {
        if (name === "search") Spotify.focusSearch();
        return;
      }
      /* **L'onglet « Bibliothèque » doit ramener l'application quelque part.**
         Notre page est plein écran et se range dès qu'une sous-page s'ouvre (une
         playlist, un album) pour ne pas la recouvrir : depuis une playlist,
         l'appui allumait donc l'onglet… et ne montrait rien du tout — « l'onglet
         bibliothèque ne marche pas ». On repart de l'accueil, là où notre page a
         sa place. (Au passage : `tabbar.classList.remove("is-library")`
         n'était jamais accompagné d'un `add` — un reste d'une classe qui n'existe
         nulle part.) */
      var toHome = name === "library" && !Library.isLibraryPath();
      emit({ tab: name }, "route");
      var before = location.pathname + "|" + Spotify.route();
      if (name === "home" || toHome) {
        Spotify.goHome();
      } else if (name === "search") {
        Spotify.goSearch();
        setTimeout(function () {
          Spotify.focusSearch();
        }, 350);
      }
      /* Le clic sur un bouton de Spotify ne suffit pas toujours (bouton absent,
         désactivé ou remplacé d'une version à l'autre) : un appui qui ne produit
         **rien** est exactement ce que l'utilisateur appelle « rien n'est relié ».
         On vérifie donc, et à défaut l'application navigue elle-même — c'est ce
         que fait déjà le mode mobile (`native-mode.js`). */
      if (name === "home" || name === "search" || toHome) {
        setTimeout(function () {
          if (location.pathname + "|" + Spotify.route() === before) {
            try {
              location.assign(name === "search" ? "/search" : "/");
            } catch (e) {
              /* navigation refusée : on ne fait pas pire */
            }
          }
        }, 900);
      }
      /* Sur l'accueil et la recherche, aucun déplacement n'est nécessaire : la
         barre latérale de Spotify est déjà là, et notre page la remplace
         plein écran (§3 des feuilles). C'est en dehors de ces deux vues que
         `toHome` ci-dessus remet les choses à leur place. */
      Queue.close();
      buzz(8);
    },
    /** Called when the web player navigates on its own (link taps…). */
    sync: function () {
      var route = Spotify.route();
      /* Le DOM ne dit pas toujours qu'on est sur une sous-page (le contenu d'une
         playlist arrive après la barre de titre) : l'adresse, elle, le dit tout
         de suite. `route` commande la place de nos barres **et** le bouton
         retour — le deviner au DOM, c'est l'écran noir signalé. */
      if (route === "other" && Spotify.isSubPagePath()) route = "page";
      /* La page ouverte est arrivée : le voile d'ouverture (module `Open`) a
         fait son travail. */
      if (Open.busy && route === "page") Open.done();
      var patch = { route: route };
      if (route === "home" && State.tab !== "library" && State.tab !== "search") patch.tab = "home";
      /* **Le choix de l'utilisateur prime sur la route.** « Bibliothèque » n'est
         pas une page de Spotify : c'est notre vue posée sur l'accueil **ou** sur
         la recherche. La réécrire dès que l'adresse est celle de la recherche,
         c'est un onglet qui ne répond pas (mesuré au banc : appui
         « Bibliothèque » depuis la recherche → l'onglet revenait à « Recherche »
         au relevé suivant, et la page ne s'affichait jamais). */
      if (route === "search" && State.tab !== "library") patch.tab = "search";
      emit(patch, "route-sync");
    },
  };

  /** Count internal navigations so `goBack()` never leaves the app. */
  var History = {
    depth: 0,
    install: function () {
      if (this.installed) return;
      this.installed = true;
      ["pushState", "replaceState"].forEach(function (m) {
        var orig = history[m];
        history[m] = function (state) {
          /* **Les seules entrées qui ne comptent pas** sont celles des
             panneaux (`{sd:'panel'}`, posées par `Back`) : sans cela,
             `goBack()` rouvrirait la feuille qu'il doit fermer. Celles de
             l'ouverture d'une page (`{sd:'open'}`, module `Open`) sont de
             vraies navigations : le retour doit les défaire. */
          if (m === "pushState" && !(state && state.sd === "panel")) History.depth++;
          return orig.apply(this, arguments);
        };
      });
      window.addEventListener("popstate", function () {
        /* L'événement que nous émettons pour ouvrir une page ne doit pas
           décrémenter l'historique : ce n'est pas un retour. */
        if (Open.synthetic) return;
        if (History.depth > 0) History.depth--;
      });
    },
  };

