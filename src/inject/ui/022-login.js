  /* ------------------------------------------------------------------ *
   * 11e. Login — mobile login page + "logged in" hand-off to Android
   * ------------------------------------------------------------------ */
  var Login = {
    done: false,
    apply: function () {
      var html = document.documentElement;
      var onLogin = !!pick(SEL.loginPage) || /\/login/.test(location.pathname);
      html.classList.toggle("sd-login", onLogin);
      /* Écran d'accueil : décidé à chaque passage, y compris quand on n'est
         ni sur la page de connexion ni dans l'application (page marketing). */
      Welcome.apply();
      /* Et l'état de session part vers Android au même rythme : c'est lui qui
         confirme la session à la connexion (et la range), et qui distingue une
         déconnexion volontaire d'un lancement sans session. */
      LoginState.report();
      if (!onLogin) {
        html.classList.remove("sd-login-classic", "sd-need-password");
        return;
      }
      /* The WebView's OAuth pop-ups are unreliable; offer the classic form
         (`?allow_password=1`) the way the native app does — but as a button
         inside OUR layer, never as a node inside Spotify's React tree. */
      var classic = !!$('form[data-testid="login-form"], #login-username');
      html.classList.toggle("sd-login-classic", classic);
      html.classList.toggle("sd-need-password", !classic && !/allow_password=1/.test(location.search));
      var wpl = pick(SEL.webPlayerLink);
      if (wpl && !this.done) {
        this.done = true;
        Bridge.call("loginDetected");
        html.classList.add("sd-login-done");
        try {
          wpl.click();
        } catch (e) {}
      }
    },
  };

