  /* ------------------------------------------------------------------ *
   * 11e-bis. Welcome — écran d'accueil maison.
   *
   * Quand la session est déconnectée, open.spotify.com sert sa page
   * marketing desktop : sur un téléphone c'est illisible et ça ne ressemble
   * pas à une application. On affiche à la place un écran SpotiDuck sobre
   * (logo, texte, bouton) par-dessus, avec l'accès à la connexion classique
   * par e-mail/mot de passe.
   * ------------------------------------------------------------------ */
  /* Un lien de connexion **de Spotify**, pas le nôtre.
     Le calcul naïf (`a[href*="/login"]`) comptait aussi les liens de notre
     propre coque — son écran d'accueil en contient deux, et la barre du haut un
     troisième. Résultat : sur toute page sans lecteur, la coque se « prouvait »
     à elle-même que la page était la page marketing de Spotify, son écran
     d'accueil se rendait vrai tout seul… et il ne se retirait plus, masquant la
     coque entière (mesuré sur le banc : `haut/bas/mini/en-tête = MASQUÉ 0×0`,
     classe `sd-welcome-on`, alors que la coque était construite). C'est le
     « c'est le bordel » reproduit au laboratoire.
     Même piège pour l'état de session : compter notre propre lien faisait
     rapporter « déconnecté » à l'application pendant un chargement, donc une
     session valable pouvait être jetée. */
  function spotifyLoginLink() {
    /* Liens **et boutons** : la page d'atterrissage de Spotify
       (`open.spotify.com/intl-fr/`) sert parfois sa connexion par un bouton
       piloté en JavaScript, sans `href` — et l'écran d'accueil maison ne
       s'affichait alors pas là où il est le plus utile (session fermée). */
    var links = document.querySelectorAll(
      'a[href^="/login"], a[href*="/login"], a[href*="accounts.spotify.com"],' +
        ' button[data-testid*="login"], button[data-testid*="signup"]'
    );
    for (var i = 0; i < links.length; i++) {
      var node = links[i];
      var ours = false;
      while (node && node.nodeType === 1) {
        if (node.classList && node.classList.contains("sd-layer")) {
          ours = true;
          break;
        }
        node = node.parentNode;
      }
      if (!ours) return links[i];
    }
    return null;
  }

  var Welcome = {
    /** Ranger l'écran d'accueil — une seule façon de le faire. */
    hide: function () {
      document.documentElement.classList.remove("sd-welcome-on");
      if (UI.el.welcome) UI.el.welcome.setAttribute("aria-hidden", "true");
      return false;
    },
    apply: function () {
      var html = document.documentElement;
      var login = html.classList.contains("sd-login");
      var app = !!(pick(SEL.mainView) || pick(SEL.npBar));
      var marketing = !!spotifyLoginLink();
      /* **Jamais** sur la page de connexion. C'était le défaut : la coque
         s'installe aussi sur `accounts.spotify.com`, y reconnaît une page de
         connexion (`sd-login`) et posait l'écran d'accueil **par-dessus le
         formulaire** ; son bouton menait à la page déjà affichée, donc « le
         bouton ne fait rien » et l'utilisateur restait bloqué là. L'écran
         d'accueil n'a de sens que sur la page marketing du lecteur, quand
         personne n'est connecté et qu'il n'y a rien à remplir. */
      var show = !app && !login && !LoginState.isLoginPage() && marketing;
      if (!show) return this.hide();
      html.classList.add("sd-welcome-on");
      if (UI.el.welcome) UI.el.welcome.setAttribute("aria-hidden", "false");
      return show;
    },
  };


