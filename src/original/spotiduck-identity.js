/* ==========================================================================
   SpotiDuck — identité de navigateur (bureau) pour la coque maison.

   Valeurs reprises **telles quelles** du script d'origine
   (`src/original/spotiduck-fingerprint.js`, lui-même reconstruit depuis les
   chaînes déchiffrées de `p000/C1356q3.onPageStarted`), à une exception près,
   volontaire : **la géométrie n'est pas touchée ici**.

   Pourquoi deux scripts plutôt qu'un seul :

   · l'interface d'origine (`spotiduck-fingerprint.js`) a besoin de la
     géométrie — écran 1920×1080, fenêtre 1920×978 — parce que c'est elle qui
     fait calculer à Spotify la mise en page **bureau** que cette interface
     habille ;
   · la coque maison met la page en page sur la **largeur réelle du téléphone**
     (son CSS lit `document.documentElement.clientWidth`, jamais
     `window.innerWidth`) : lui imposer une fenêtre de 1920 px casserait
     l'affichage validé par l'utilisateur. Ce fichier ne pose donc ni `screen`,
     ni `innerWidth`, ni `innerHeight`, ni `devicePixelRatio`.

   Ce qui reste — et qui est le point de ce fichier — c'est l'**identité** :
   l'agent annoncé par la WebView est déjà celui de Chrome Windows, mais
   `navigator` continuait de répondre « Android » (plateforme, client hints,
   greffons, GPU), et c'est précisément ce mélange que Spotify décrit par
   « votre navigateur n'est pas compatible » dans le message de lecture
   désactivée.

   Injecté au début du chargement (`onPageStarted`), avant que la page ne lise
   quoi que ce soit.
   ========================================================================== */
(function () {
  var UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

  var def = function (target, prop, value) {
    try {
      target.__defineGetter__(prop, function () {
        return value;
      });
    } catch (e) {
      /* propriété non redéfinissable : on n'insiste pas, le reste s'applique */
    }
  };

  var nav = window.navigator;
  def(nav, "userAgent", UA);
  def(nav, "vendor", "Google Inc.");
  def(nav, "productSub", "20030107");
  def(nav, "platform", "Win32");
  def(nav, "oscpu", undefined);
  def(nav, "hardwareConcurrency", 4);
  def(nav, "deviceMemory", 8);
  def(nav, "maxTouchPoints", 0);

  /* Client hints : le même objet que celui du script d'origine — mêmes marques,
     `mobile: false`, `platform: "Windows"`, et les mêmes valeurs fines
     (x86, 64 bits, Windows 10.0.0, liste de versions complètes). */
  var HIGH_ENTROPY = {
    architecture: "x86",
    bitness: "64",
    wow64: false,
    model: "",
    formFactors: ["Desktop"],
    platformVersion: "10.0.0",
    uaFullVersion: "150.0.7871.187",
    fullVersionList: [
      { brand: "Not;A=Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: "150.0.7871.187" },
      { brand: "Google Chrome", version: "150.0.7871.187" },
    ],
  };
  def(nav, "userAgentData", {
    brands: [
      { brand: "Not;A=Brand", version: "8" },
      { brand: "Chromium", version: "150" },
      { brand: "Google Chrome", version: "150" },
    ],
    mobile: false,
    platform: "Windows",
    async getHighEntropyValues(hints) {
      var out = {
        brands: this.brands,
        mobile: this.mobile,
        platform: this.platform,
      };
      for (var i = 0; i < hints.length; i++) {
        var hint = hints[i];
        if (Object.prototype.hasOwnProperty.call(HIGH_ENTROPY, hint)) {
          out[hint] = HIGH_ENTROPY[hint];
        }
      }
      return out;
    },
  });

  /* Greffons et types MIME : les mêmes que le script d'origine (Chrome de
     bureau en déclare cinq, un navigateur de téléphone aucun). */
  def(nav, "plugins", (function () {
    var plugins = [];
    plugins[0] = plugins["PDF Viewer"] = {
      name: "PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
    };
    plugins[1] = plugins["Chrome PDF Viewer"] = {
      name: "Chrome PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
    };
    plugins[2] = plugins["Chromium PDF Viewer"] = {
      name: "Chromium PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
    };
    plugins[3] = plugins["Microsoft Edge PDF Viewer"] = {
      name: "Microsoft Edge PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
    };
    plugins[4] = plugins["WebKit built-in PDF"] = {
      name: "WebKit built-in PDF",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format",
    };
    plugins.length = 5;
    return plugins;
  })());

  def(nav, "mimeTypes", (function () {
    var mimeTypes = [];
    mimeTypes[0] = mimeTypes["application/pdf"] = {
      type: "application/pdf",
      suffixes: "pdf",
      description: "Portable Document Format",
    };
    mimeTypes[1] = mimeTypes["text/pdf"] = {
      type: "text/pdf",
      suffixes: "pdf",
      description: "Portable Document Format",
    };
    mimeTypes.length = 2;
    return mimeTypes;
  })());

  /* GPU : les deux mêmes chaînes que le script d'origine. Isolé dans son propre
     bloc, pour qu'une WebView sans WebGL2 ne fasse pas tomber tout le reste. */
  try {
    var original = WebGLRenderingContext.prototype.getParameter;
    var GPU = {
      37445: "Google Inc. (Intel)",
      37446: "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
    var spoof = function (id) {
      return Object.prototype.hasOwnProperty.call(GPU, id) ? GPU[id] : original.call(this, id);
    };
    WebGLRenderingContext.prototype.getParameter = spoof;
    if (typeof WebGL2RenderingContext !== "undefined") {
      WebGL2RenderingContext.prototype.getParameter = spoof;
    }
  } catch (e) {
    /* pas de WebGL : l'identité ci-dessus suffit */
  }
})();
