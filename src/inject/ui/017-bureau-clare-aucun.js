  /* ------------------------------------------------------------------ *
   * 10-bis. Viewport
   *
   * Le web player est un site « bureau » : il ne déclare aucun
   * `<meta name="viewport">`. Une WebView qui n'en trouve pas se donne une
   * largeur de mise en page de **980 px** — les media queries, les unités `vw`
   * et toutes les tailles de police de la couche visent alors un écran deux à
   * trois fois plus large que le téléphone : l'interface paraît énorme, coupée
   * sur la droite, et il faut la faire glisser pour atteindre les boutons.
   *
   * `document.documentElement.clientWidth` *est* cette largeur de mise en page
   * (pas `window.innerWidth`, que le mode bêta redéfinit). On pose donc le meta
   * nous-mêmes, et on le signale dans le diagnostic « Affichage » : si la
   * largeur de mise en page ne correspond pas à celle de l'écran, la ligne
   * l'écrit noir sur blanc.
   * ------------------------------------------------------------------ */
  var VIEWPORT_CONTENT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

  var Viewport = {
    /** Pose (ou corrige) le meta viewport. Idempotent, appelable à tout moment. */
    ensure: function () {
      var head = document.head || document.documentElement;
      if (!head) return false;
      var metas = $$('meta[name="viewport"]');
      var meta = metas[0];
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "viewport");
        head.appendChild(meta);
      }
      for (var i = 1; i < metas.length; i++) {
        if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
      }
      if (meta.getAttribute("content") !== VIEWPORT_CONTENT) {
        meta.setAttribute("content", VIEWPORT_CONTENT);
      }
      return true;
    },

    /** Largeur de mise en page réelle, et largeur de l'écran en pixels CSS. */
    measure: function () {
      var layout = document.documentElement.clientWidth || 0;
      var screenW = Math.round((window.screen && window.screen.width) || 0);
      var dpr = window.devicePixelRatio || 1;
      /* `screen.width` est en **pixels CSS** sur les WebView récentes (385 sur
         le téléphone) et en pixels **physiques** sur d'anciennes (1080). On ne
         devine pas : on ne divise par la densité que si la valeur est
         manifestement physique. Le téléphone annonçait « écran 137 » à côté de
         « vue 384 » — parce que 385 était déjà en pixels CSS — et le
         avertissement « mise en page 384px pour un écran de 137px » se
         déclenchait donc pour rien. */
      var device = screenW ? (screenW > 1000 && dpr > 1 ? Math.round(screenW / dpr) : screenW) : 0;
      return {
        layout: layout,
        screen: screenW,
        device: device, // pixels CSS : c'est ce que devrait valoir `layout`
        ok: !device || (layout >= device * 0.8 && layout <= device * 1.25),
      };
    },
  };

  /**
   * Ce que la WebView voit réellement : c'est la seule façon de savoir
   * pourquoi un rendu diffère d'un appareil à l'autre (le réglage de taille
   * du système Android n'est pas transmis au CSS, donc on mesure).
   */
  function describeDisplay(withUA) {
    var d = document.documentElement;
    var cs = window.getComputedStyle(d);
    var u = parseFloat(cs.getPropertyValue("--sd-u")) || 1;
    var vp = Viewport.measure();
    var txt =
      d.clientWidth +
      "×" +
      d.clientHeight +
      " · " +
      (window.devicePixelRatio || 1).toFixed(2) +
      "× · " +
      Math.round(u * 100) +
      " %";
    if (!vp.ok) {
      txt += " · ⚠ mise en page " + vp.layout + "px pour un écran de " + vp.device + "px";
    }
    if (withUA) {
      txt +=
        " · innerWidth " +
        window.innerWidth +
        " · " +
        (navigator.userAgent || "").replace(/^Mozilla\/5\.0 /, "");
    }
    return txt;
  }

