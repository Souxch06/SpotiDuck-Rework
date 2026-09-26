  /* ------------------------------------------------------------------ *
   * 0. Tiny helpers
   * ------------------------------------------------------------------ */
  function $(sel, root) {
    return (root || document).querySelector(sel) || null;
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  /** First element matching any selector of the list (ordered by priority). */
  /**
   * **Un candidat sur lequel un appui ne peut rien faire.**
   *
   * Le seul signal fiable est `disabled` : sur un bouton désactivé, le
   * navigateur ne déclenche aucun gestionnaire — l'appui est perdu, et c'est
   * très exactement « impossible de zapper ». Un bouton **caché**, lui, reste
   * branché : notre propre feuille masque la barre de la disposition bureau, et
   * un appui dessus agit quand même. Le refuser serait se priver d'un chemin
   * qui marche (relevé au banc : c'est ce qui a fait tomber deux contrôles
   * valides). On ne juge donc que sur `disabled`, à quoi s'ajoute, pour le
   * classement seulement, la présence d'une boîte à l'écran.
   */
  function dead(el) {
    return !el || el.disabled === true;
  }

  /**
   * **Un élément de notre propre couche, jamais une commande de Spotify.**
   *
   * Nos boutons portent les mêmes libellés que ceux du lecteur (« Lecture »,
   * « Pause », « Suivant ») : les repères par libellé ajoutés au pass 50 les
   * attrapaient donc eux-mêmes. L'appui partait sur notre bouton, qui rappelait
   * la même commande — deux bascules qui s'annulent, et « le bouton ne fait
   * rien ». Le reste du code écarte déjà notre couche (`never ours`) ; les
   * repères le font maintenant aussi.
   */
  function ours(el) {
    try {
      return !!(el && el.closest && el.closest(".sd-layer"));
    } catch (e) {
      return false;
    }
  }

  /** Les candidats, **les utilisables d'abord** — et parmi eux, ceux qui ont
   *  vraiment une boîte à l'écran (c'est celui-là que l'utilisateur voit). */
  function ranked(list) {
    var alive = [];
    var seen = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      seen++;
      if (!dead(list[i])) alive.push(list[i]);
    }
    /* Tout est mort : on rend la liste telle quelle, l'appelant décide (refuser,
       se rabattre sur le clavier, le dire). Ne jamais rendre *moins* qu'avant. */
    if (!alive.length) return list.slice();
    var onscreen = [];
    var other = [];
    for (var j = 0; j < alive.length; j++) {
      var box = null;
      try {
        box = alive[j].getBoundingClientRect();
      } catch (e) {
        box = null;
      }
      if (box && (box.width > 1 || box.height > 1)) onscreen.push(alive[j]);
      else other.push(alive[j]);
    }
    return onscreen.concat(other);
  }

  /**
   * **Le bon élément parmi les candidats.**
   *
   * `pick` rendait le **premier** trouvé ; sur une page qui contient deux copies
   * de la barre de lecture (bureau + téléphone), c'était celle du bureau, cachée
   * ou désactivée. Il rend maintenant le premier candidat *utilisable*, et à
   * défaut — aucun candidat utilisable, ou environnement sans mise en page —
   * le premier trouvé, exactement comme avant.
   */
  function pick(selectors) {
    var all = [];
    var list = typeof selectors === "string" ? [selectors] : selectors || [];
    for (var i = 0; i < list.length; i++) {
      var found;
      try {
        found = document.querySelectorAll(list[i]);
      } catch (e) {
        found = [];
      }
      for (var j = 0; j < found.length; j++) if (!ours(found[j])) all.push(found[j]);
    }
    if (!all.length) return null;
    return ranked(all)[0];
  }
  function viewW() {
    return document.documentElement.clientWidth || 360;
  }
  function viewH() {
    return document.documentElement.clientHeight || 640;
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function buzz(ms) {
    try {
      if (Settings.haptics && navigator.vibrate) navigator.vibrate(ms || 8);
    } catch (e) {
      /* not supported — ignore */
    }
  }

