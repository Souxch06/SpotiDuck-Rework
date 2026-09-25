/* SpotiDuck — interface d'origine (voir src/original/README.md). Copie de src/original/spotiduck-original.js ; ne pas modifier ici. */
/* ==========================================================================
   SpotiDuck — empreinte de navigateur de l'application d'origine.

   Code d'origine, repris tel quel (aucune réécriture) : c'est le script que
   l'application injecte **au début du chargement** de la page, avant que
   Spotify ne lise quoi que ce soit. Il fait passer la WebView pour un Chrome
   de bureau sur un écran 1920×1080 (écran, fenêtre, densité, agent, client
   hints, greffons, WebGL), et c'est **lui qui décide de la mise en page** que
   Spotify calcule : sans lui, la page se croit sur un téléphone et l'affichage
   d'origine ne peut pas se recomposer.

   Reconstruit depuis les chaînes déchiffrées de `p000/C1356q3.onPageStarted`
   (source publique déobfusquée `lyssadev/Spotifuck_src`).

   sha256 du corps d'origine : 98eb5a9dd125f8daf3f261c1908bb7a6b1869813adee3f90c5afed55d899e35f
   ========================================================================== */
(function () {
  window.screen.__defineGetter__("width", function () {
    return 1920;
  });
  window.screen.__defineGetter__("height", function () {
    return 1080;
  });
  window.screen.__defineGetter__("availWidth", function () {
    return 1920;
  });
  window.screen.__defineGetter__("availHeight", function () {
    return 1040;
  });
  window.__defineGetter__("innerWidth", function () {
    return 1920;
  });
  window.__defineGetter__("innerHeight", function () {
    return 978;
  });
  window.__defineGetter__("devicePixelRatio", function () {
    return 1;
  });
  window.navigator.__defineGetter__("userAgent", function () {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  });
  window.navigator.__defineGetter__("vendor", function () {
    return "Google Inc.";
  });
  window.navigator.__defineGetter__("productSub", function () {
    return "20030107";
  });
  window.navigator.__defineGetter__("platform", function () {
    return "Win32";
  });
  window.navigator.__defineGetter__("oscpu", function () {
    return undefined;
  });
  window.navigator.__defineGetter__("hardwareConcurrency", function () {
    return 4;
  });
  window.navigator.__defineGetter__("deviceMemory", function () {
    return 8;
  });
  window.navigator.__defineGetter__("maxTouchPoints", function () {
    return 0;
  });
  const _0x3360a4 = {
    brands: [{
      brand: "Not;A=Brand",
      version: "8"
    }, {
      brand: "Chromium",
      version: "150"
    }, {
      brand: "Google Chrome",
      version: "150"
    }],
    mobile: false,
    platform: "Windows",
    async getHighEntropyValues(_0x2a4ad5) {
      const _0x206901 = {
        architecture: "x86",
        bitness: "64",
        wow64: false,
        model: "",
        formFactors: ["Desktop"],
        platformVersion: "10.0.0",
        uaFullVersion: "150.0.7871.187",
        fullVersionList: [{
          brand: "Not;A=Brand",
          version: "8.0.0.0"
        }, {
          brand: "Chromium",
          version: "150.0.7871.187"
        }, {
          brand: "Google Chrome",
          version: "150.0.7871.187"
        }]
      };
      const _0x1255b5 = {
        brands: this.brands,
        mobile: this.mobile,
        platform: this.platform
      };
      for (const _0x54958a of _0x2a4ad5) {
        if (_0x54958a in _0x206901) {
          _0x1255b5[_0x54958a] = _0x206901[_0x54958a];
        }
      }
      return _0x1255b5;
    }
  };
  window.navigator.__defineGetter__("userAgentData", function () {
    return _0x3360a4;
  });
  window.navigator.__defineGetter__("plugins", function () {
    let _0x4ff8eb = [];
    _0x4ff8eb[0] = _0x4ff8eb["PDF Viewer"] = {
      name: "PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format"
    };
    _0x4ff8eb[1] = _0x4ff8eb["Chrome PDF Viewer"] = {
      name: "Chrome PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format"
    };
    _0x4ff8eb[2] = _0x4ff8eb["Chromium PDF Viewer"] = {
      name: "Chromium PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format"
    };
    _0x4ff8eb[3] = _0x4ff8eb["Microsoft Edge PDF Viewer"] = {
      name: "Microsoft Edge PDF Viewer",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format"
    };
    _0x4ff8eb[4] = _0x4ff8eb["WebKit built-in PDF"] = {
      name: "WebKit built-in PDF",
      filename: "internal-pdf-viewer",
      description: "Portable Document Format"
    };
    _0x4ff8eb.length = 5;
    return _0x4ff8eb;
  });
  window.navigator.__defineGetter__("mimeTypes", function () {
    let _0x2dce1c = [];
    _0x2dce1c[0] = _0x2dce1c["application/pdf"] = {
      type: "application/pdf",
      suffixes: "pdf",
      description: "Portable Document Format"
    };
    _0x2dce1c[1] = _0x2dce1c["text/pdf"] = {
      type: "text/pdf",
      suffixes: "pdf",
      description: "Portable Document Format"
    };
    _0x2dce1c.length = 2;
    return _0x2dce1c;
  });
  let _0x5a1745 = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (_0x1fe9e2) {
    return {
      37445: "Google Inc. (Intel)",
      37446: "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    }[_0x1fe9e2] ?? _0x5a1745.call(this, _0x1fe9e2);
  };
  WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
})();