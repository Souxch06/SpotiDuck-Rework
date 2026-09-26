  /* ------------------------------------------------------------------ *
   * 11e-ter. Session — l'état de connexion, rapporté à Android.
   *
   * Le mode mobile rapportait `in` / `out` / `login` ; la coque, non (elle se
   * contentait de `loginDetected`). Tant que le défaut était la page mobile,
   * ça passait inaperçu ; depuis que la coque est livrée par défaut,
   * l'application ne recevait plus « connecté » : la session n'était donc ni
   * confirmée ni rangée à la connexion, et une déconnexion volontaire n'était
   * plus distinguée d'un lancement sans session.
   *
   * On tient ici **exactement** le contrat du mode mobile : mêmes trois états,
   * même silence quand on ne sait pas — le pont ignore ce qu'il ne comprend
   * pas, et un « je ne sais pas » ne doit pas faire jeter une session valable.
   * ------------------------------------------------------------------ */
  var LoginState = {
    sent: null,
    count: 0,
    isLoginPage: function () {
      return (
        document.documentElement.classList.contains("sd-login") ||
        /(^|\.)accounts\.spotify\.com$/.test(location.hostname) ||
        !!pick(SEL.loginPage)
      );
    },
    signedIn: function () {
      return !!(pick(SEL.mainView) || pick(SEL.npBar));
    },
    signedOut: function () {
      return !this.signedIn() && !!spotifyLoginLink();
    },
    /** « login » (page de connexion), « in », « out », ou « ? » (pas d'avis). */
    state: function () {
      return this.isLoginPage() ? "login" : this.signedIn() ? "in" : this.signedOut() ? "out" : "?";
    },
    report: function () {
      var state = this.state();
      if (state === "?") state = null;
      /* Inconnu : on ne dit rien. (Le pont écarte de toute façon ce qu'il ne
         comprend pas ; autant ne pas l'appeler pour rien.) */
      if (!state) return null;
      /* Le même constat part trois fois — l'application peut s'attacher après
         le premier passage — puis seulement quand il change. */
      if (state === this.sent && this.count > 2) return state;
      this.sent = state;
      this.count++;
      Bridge.call("loginState", state);
      return state;
    },
  };

