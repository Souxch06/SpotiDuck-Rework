  /* ------------------------------------------------------------------ *
   * 11. Toast (tiny, replaces nothing but keeps feedback possible)
   * ------------------------------------------------------------------ */
  var Toast = {
    el: null,
    timer: 0,
    show: function (text, ms) {
      /* **Un message qui n'existe pas ne s'affiche pas.** Un libellé oublié
         dans la liste des textes envoyait `undefined` à l'écran — la bulle
         affichait littéralement « undefined », ce qui a fait croire à une panne
         du réseau (« ça écrit undefined quand je lance une musique »). Mieux
         vaut se taire que mentir ; le banc, lui, le voit (aucun texte, aucun
         appel). */
      if (text === undefined || text === null || text === "") return false;
      if (typeof text !== "string") text = String(text);
      /* Pas de coque, pas de bulle : `Toast` est appelé par des chemins qui
         peuvent précéder `UI.build` (une alarme de session, un réglage). */
      if (!UI.layer) return false;
      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "sd-toast";
        this.el.setAttribute("role", "status");
        UI.layer.appendChild(this.el);
      }
      this.el.textContent = text;
      this.el.classList.add("is-visible");
      clearTimeout(this.timer);
      var self = this;
      this.timer = setTimeout(function () {
        self.el.classList.remove("is-visible");
      }, ms || 1800);
      return true;
    },
  };

