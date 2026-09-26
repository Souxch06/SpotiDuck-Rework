/* ==========================================================================
   SpotiDuck — le moteur de lecture de l'application d'origine, **repris tel
   quel**. Généré par `tools/build-logic.mjs` : ne pas éditer ici.

   Huit blocs de `src/original/spotiduck-original.js`, recopiés octet pour
   octet (longueurs et md5 vérifiés à chaque `npm run build`) : capteur de
   jetons sur le trafic de la page, `mngFetch` (requêtes hors WebView par le
   pont Android), `playFromUri` (démarrer une piste par l'API Connect),
   `manageWake`, `trigUnlock`, les six commandes `act*`, `manageAll` (la
   machine d'état : notification, veille, minuteries), `updMedia` (le rapport
   à Android).

   Ce fichier **ne dessine rien**. Ce que l'original y mêlait d'affichage (sa
   barre du haut, son mini-lecteur, son `npBtn), ses hacks CSS et ses
   coupures de rangées d'accueil est resté dehors : la coque
   (`src/inject/spotiduck-ui.js`) est seule à dessiner, et lui fournit l'état.

   Interface vers la coque : `window.SpotiDuckLogic` (méthodes en bas du
   fichier). Les variables d'état que les blocs se partagent sont **fournies par
   la coque** — c'est le seul code qui soit d'ici, et il ne fait que transférer.
   ========================================================================= */

(function () {
  /* **Pas de « use strict »** : les blocs recopiés assignent des variables sans
     les déclarer (`playing`, `featVer`, `window.pBtn`) et se relisent
     ensuite par ce nom — c'est ainsi que l'original fonctionne, et que
     « `pBtn` in window » répond vrai quand la coque lui passe le bouton. */
  var AndBridge = window.AndBridge || {
    /* Sans pont (banc de démonstration, jsdom) : tout se tait et le moteur
       reste inoffensif — c'est ce qui permet de le tester sans Android. */
    nFetch: function () { return Promise.resolve(JSON.stringify({ status: 0, body: "no bridge" })); },
    deferMessage: function () {},
    wakeUp: function () {}, wakeOff: function () {}, isWoke: function () { return false; },
    manageTShut: function () {}, manageTSleep: function () {},
    recMediaStatus: function () {}, recMediaPosition: function () {},
    playLoaded: function () {},
  };
  var cbs = { state: [], track: [] };
  var sawBtn = false;
  /* La vraie fonction de la page, gardée **avant** que le capteur ne la
     recouvre : c'est elle qui répond si le capteur lève. */
  var originalFetch = window.fetch;
  var captureErrors = 0;
  var installeErrors = 0;
  var emit = function (kind, value) {
    var list = cbs[kind] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](value); } catch (e) {} }
  };
  /* Ce que les blocs citent et que la coque ne lui doit pas (c'était de
     l'affichage dans l'original : sa barre du haut, son bouton de paroles, ses
     rangées d'accueil). Elles sont là pour que l'appel ne lève pas — et
     préviennent, au lieu de dessiner. */
  function firstFuck() { emit("state", { tick: true }); }
  function updNpbState() {}
  function clickNP() {}
  function closeNowPlay() { return false; }
  /* L'original s'en sert pour redemander sa bibliothèque média à Spotify quand
     un jeton change : la coque a la même attente, sous une autre forme. */
  function checkMediaLib() { emit("track", { captured: true }); }
  /* Les trois « ajouts automatiques » d'origine : l'un est vide, les deux
     autres insèrent CSS et bouton de « J'aime ». Rien n'est repris ici. */
  function addAutoFeatures() {}
  function addAndAuto() {}
  function addCSSJSHack() {}

  /* ---- bloc « état » — les variables de closure que les blocs partagent (drapeaux d'intervalle, `featVer`) ---- */
let reqPause=false,firstPlay=true,ulFlag=false,ffDone=false,npOpen=false;featVer=`web-player_${new Date().toISOString().split('T')[0]}_${Date.now()}_${Math.floor(Math.random()*0xFFFFFFF).toString(16).padStart(7,'0')}`;lastState=null;lastPos=null;playing=false;pfint=null;afint=null;cssint=null;aaint=null;npbtim=null;npvSt=undefined;lCl='𝖫 &nbsp; Close Library';

  /* ---- bloc « capteur » — lit dans le trafic de la page `spotDevId`, `spotCliToken`, `spotAuthToken`, `currUri`, et l'état de lecture posé par la page elle-même ---- */
window.hasVid=function(){ return typeof playing!=='undefined'&&playing&&!!document.querySelector('.VideoPlayer__container video'); };window.mngFetch = async function (_0x3c694f, _0x4c6349 = {}) {
  const _0x3423f2 = await AndBridge.nFetch(_0x3c694f, JSON.stringify(_0x4c6349));
  let _0x3e6366;
  try {
    _0x3e6366 = JSON.parse(_0x3423f2);
  } catch (_0x4b2c04) {
    throw new Error("fetch: invalid response from bridge: " + _0x3423f2);
  }
  if (_0x3e6366.status === 0) {
    throw new Error("fetch: network error: " + _0x3e6366.body);
  }
  return {
    status: _0x3e6366.status,
    ok: _0x3e6366.status >= 200 && _0x3e6366.status < 300,
    headers: new Headers(_0x3e6366.headers || {}),
    json: async () => JSON.parse(_0x3e6366.body),
    text: async () => _0x3e6366.body,
    clone: function () {
      return this;
    }
  };
};const oriFetch=window.fetch;window.fetch=async function(...args) {  const [url,opts]=args;  if(typeof url!=='string') return oriFetch.apply(this,args);  const ts=new Date().toISOString().slice(11,23);  const method=opts?.method?.toUpperCase?.()||'GET';  const headers=opts?.headers||{};  if(method==='POST'&&url.includes('/track-playback/v1/devices')&&opts?.body){    const body=JSON.parse(opts.body);    const deviceId=body?.device?.device_id;    if(deviceId&&deviceId!==window.spotDevId){      window.spotDevId=deviceId;      typeof checkMediaLib==='function'&&checkMediaLib();    }  }  else if(method==='POST'&&url.includes('/pathfinder/v2/query')&&opts?.body){    const body=JSON.parse(opts.body);    if(body?.operationName==='isCurated'){      const currUri=body?.variables?.uris?.[0];      if(currUri&&currUri!==window.currUri){        window.currUri=currUri;      }    }  }  else {    let match=url.match(/\/connect-state\/v1\/player\/(?:command|transfer)\/from\/([^/]+)\/to\/([^/]+)/);    if(match?.[2]&&match[2]!==window.spotDevId) {      window.spotDevId=match[2];      typeof checkMediaLib==='function'&&checkMediaLib();    }  }  const cliToken=headers['Client-Token']||headers['client-token'];  if(cliToken&&cliToken!==window.spotCliToken) {    window.spotCliToken=cliToken;    typeof checkMediaLib==='function'&&checkMediaLib();  }  const authHead=headers.Authorization||headers.authorization;  if(authHead?.startsWith('Bearer ')&&authHead!==window.spotAuthToken) {    window.spotAuthToken=authHead;    typeof checkMediaLib==='function'&&checkMediaLib();  }  if(ffDone&&url.includes('/track-playback/')&&method==='PUT') {    const paused=opts?.body?JSON.parse(opts?.body)?.state_ref?.paused:undefined;    if(paused===true&&playing) { console.log('#Track-Playback: Pause'); manageAll(false); }    else if(paused===false&&!playing) { console.log('#Track-Playback: Play'); manageAll(true); }  }
/* Coque : la page garde son trafic. `mngFetch` reste utilisé par
     `playFromUri` (bloc suivant), qui est une commande de la coque. */
  return oriFetch.apply(this, args);
};

  /* ---- bloc « playFromUri » — lancer une piste par l'API Connect (commande `play`, `license: "tft"`), pas par un clic ---- */
window.playFromUri = function (_0x4aef97) {
  let _0x463143 = _0x4aef97.match(/^spotify:([^:]+)/)?.[1];
  if (_0x463143 == "user") {
    _0x463143 = "your_library";
  }
  mngFetch("https://gew4-spclient.spotify.com/connect-state/v1/player/command/from/" + window.spotDevId + "/to/" + window.spotDevId, {
    method: "POST",
    headers: {
      Authorization: window.spotAuthToken,
      "Client-Token": window.spotCliToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      command: {
        context: {
          uri: _0x4aef97,
          url: "context://" + _0x4aef97,
          metadata: {}
        },
        play_origin: {
          feature_identifier: _0x463143,
          feature_version: featVer,
          referrer_identifier: "your_library"
        },
        options: {
          license: "tft",
          skip_to: {},
          player_options_override: {}
        },
        endpoint: "play"
      }
    })
  });
};

  /* ---- bloc « veille » — la branche de l'intervalle d'origine qui décide de l'écran : verrouillé seulement si la lecture tourne en arrière-plan, et jamais pendant une vidéo ---- */
  function runVeille() {
if (playing && document.visibilityState == "hidden" && !!document.querySelector(".VideoPlayer__container video")) {
      AndBridge.wakeUp();
    } else if (!AndBridge.isWoke() && document.visibilityState == "visible" && !document.querySelector(".VideoPlayer__container video")) {
      AndBridge.wakeOff();
    }
  }


  /* ---- bloc « installation » — LE réparateur de lecture : il revendique le bouton lecture/pause de la page (pBtn, marqué .fuckd), prévient Android que le lecteur est vivant, et — si dix secondes après une demande de lecture rien ne joue — annonce « unlock » au pont, presse suivant (c'est ce qui force Spotify à élire un appareil de lecture) et arme trigUnlock. Il pose aussi ffDone, condition de la resynchronisation d'état par le trafic de la page. Sans lui, le capteur lit sans jamais décider et la coque reste seule à cliquer. ---- */
  function runInstallation() {
let _0x48ace8 = document.querySelector("aside button[data-testid=control-button-playpause]:not(.fuckd)");
    if (_0x48ace8) {
      AndBridge.playLoaded();
      _0x48ace8.classList.add("fuckd");
      window.pBtn = _0x48ace8;
      pBtn.addEventListener("click", () => {
        if (pBtn.querySelector("svg").innerHTML.length > 130) {
          reqPause = true;
          ulFlag = false;
          manageWake(false);
        } else if (!ulFlag) {
          reqPause = false;
          manageWake(true);
          ulFlag = true;
          setTimeout(() => {
            if (ulFlag && pBtn.querySelector("svg").innerHTML.length < 130) {
              AndBridge.deferMessage("unlock");
              actSkipForward();
              trigUnlock();
            } else {
              ulFlag &&= false;
            }
          }, 10000);
        }
      });
      if (!ffDone) {
        ffDone = true;
        AndBridge.manageTShut(true);
        AndBridge.manageTSleep(false);
        addAutoFeatures();
        addCSSJSHack();
        addAndAuto();
        setTimeout(() => {
          manageAll(playing);
        }, 10000);
      }
    }
  }


  /* ---- bloc « manageWake » — l'écran : verrouillé seulement si la lecture tourne en arrière-plan ---- */
window.manageWake = function (_0xf6371b) {
  if (_0xf6371b) {
    if (document.visibilityState == "hidden") {
      AndBridge.wakeUp();
    }
  } else if (!AndBridge.isWoke() && document.visibilityState == "visible") {
    AndBridge.wakeOff();
  }
};

  /* ---- bloc « trigUnlock » — le secours du lecteur verrouillé : bouton toujours `disabled` → rechargement annoncé au pont ---- */
window.trigUnlock = function () {
  let _0x1ee12d = setInterval(() => {
    if (pBtn.disabled) {
      AndBridge.deferMessage("reload");
      window.location.reload();
    } else if (pBtn.querySelector("svg").innerHTML.length > 130) {
      clearInterval(_0x1ee12d);
      ulFlag = false;
    }
  }, 3000);
};

  /* ---- bloc « act » — les commandes : lecture/pause (jugée sur l'icône de Spotify), sauts, répétition, favori, position ---- */
window.actPlayPause = function (_0x2c5cd9) {
  if ("pBtn" in window) {
    if (pBtn.querySelector("svg").innerHTML.length < 130) {
      if (_0x2c5cd9) {
        pBtn.click();
      }
    } else if (!_0x2c5cd9) {
      pBtn.click();
    }
  }
};
window.actSkipBack = function () {
  let _0x1e7773 = document.querySelector("button[data-testid=control-button-skip-back]");
  if (_0x1e7773) {
    manageWake(true);
    _0x1e7773.click();
  }
};
window.actSkipForward = function () {
  let _0x3b710b = document.querySelector("button[data-testid=control-button-skip-forward]");
  if (_0x3b710b) {
    manageWake(true);
    _0x3b710b.click();
  }
};
window.actRepeat = function () {
  let _0x3f0074 = document.querySelector("button[data-testid=control-button-repeat]");
  if (_0x3f0074) {
    if (repmode == "false") {
      repmode = "true";
    } else if (repmode == "true") {
      repmode = "mixed";
    } else {
      repmode = "false";
    }
    updMedia();
    _0x3f0074.click();
  }
};
window.actAddToFav = function () {
  let _0xa7cafd = document.querySelector("div[data-testid=now-playing-widget]>div:last-child>button");
  if (_0xa7cafd) {
    if (_0xa7cafd.getAttribute("aria-checked") === "false") {
      _0xa7cafd.click();
      isfav = true;
      updMedia();
    } else {
      manageWake(true);
      _0xa7cafd.click();
      let _0x113d31 = setInterval(() => {
        manageWake(true);
        let _0x2470e5 = document.querySelector("#context-menu button[role=menuitemcheckbox][aria-checked=true]");
        if (_0x2470e5) {
          clearInterval(_0x113d31);
          _0x2470e5.click();
          setTimeout(() => {
            let _0x4f5e69 = document.querySelector("#context-menu button[type=submit]");
            if (_0x4f5e69) {
              _0x4f5e69.click();
              isfav = false;
              updMedia();
            }
            manageWake(false);
          }, 500);
        }
      }, 1000);
    }
  }
};
window.actSeek = function (_0x50469e) {
  let _0xf80f7e = document.querySelector("div[data-testid=playback-progressbar] input[type=range]");
  _0xf80f7e.value = _0x50469e + 1;
  _0xf80f7e.dispatchEvent(new Event("change", {
    bubbles: true
  }));
};

  /* ---- bloc « manageAll » — la machine d'état : `playing` → notification, mise en veille, minuteries d'arrêt, redémarrage des surveillances ---- */
window.manageAll = function (_0x336cb0) {
  playing = _0x336cb0;
  if (typeof updMedia === "function") {
    updMedia();
  }
  AndBridge.manageTShut(!_0x336cb0);
  AndBridge.manageTSleep(_0x336cb0);
  if (_0x336cb0) {
    firstFuck();
    addAutoFeatures();
    addCSSJSHack();
    addAndAuto();
  } else {
    if (pfint) {
      clearInterval(pfint);
    }
    if (afint) {
      clearInterval(afint);
    }
    if (cssint) {
      clearInterval(cssint);
    }
    if (aaint) {
      clearInterval(aaint);
    }
  }
};

  /* ---- bloc « updMedia » — le rapport à Android : état complet au changement, position seulement au-delà de 4 s ---- */
window.updMedia = function () {
  const _0x30c831 = track + "|" + artist + "|" + playing + "|" + repmode + "|" + isfav;
  if (_0x30c831 !== lastState) {
    lastState = _0x30c831;
    const _0x3e5da7 = {
      artist: artist,
      track: track,
      playing: playing,
      repeat: repmode,
      fav: isfav,
      duration: duration,
      position: position,
      cover: cover
    };
    AndBridge.recMediaStatus(JSON.stringify(_0x3e5da7));
  } else {
    if (Math.abs(position - lastPos) > 4000) {
      AndBridge.recMediaPosition(position);
    }
    lastPos = position;
  }
};

  /* ------------------------------------------------------------------ *
   * L'interface vers la coque : du transfert, rien d'original.
   * ------------------------------------------------------------------ */
  window.SpotiDuckLogic = {
    version: "1",
    /* L'état que la coque mesure, et que les blocs d'origine rapportent à
       Android. Des affectations : les noms deviennent globaux, comme dans
       l'original, et les blocs les lisent tels quels. */
    feed: function (s) {
      if (!s) return false;
      if (typeof s.track === "string") track = s.track;
      if (typeof s.artist === "string") artist = s.artist;
      if (typeof s.duration === "number") duration = s.duration;
      if (typeof s.position === "number") position = s.position;
      if (typeof s.cover === "string") cover = s.cover;
      if (typeof s.repeat === "string") repmode = s.repeat;
      if (typeof s.liked === "boolean") isfav = s.liked;
      if ("pBtn" in s) {
        pBtn = s.pBtn;
        /* L'original signalait « playLoaded » en posant la main sur le bouton
           de Spotify (dans firstFuck, qui est de l'affichage) : le pont attend
           ce signal pour savoir que le lecteur est vivant. Le voici, une seule
           fois, depuis la seule nourriture qui corresponde. */
        if (pBtn && !sawBtn) { sawBtn = true; try { AndBridge.playLoaded(); } catch (e) {} }
      }
      if ("lBtn" in s) lBtn = s.lBtn;
      return true;
    },
    /* La coque a décidé si la page joue : c'est manageAll qui propage
       (notification, veille, minuteries d'arrêt), comme dans l'application
       d'origine — pas une réécriture de sa décision. */
    setPlaying: function (on) {
      try { window.manageAll(!!on); return true; } catch (e) { return false; }
    },
    call: function (name, arg) {
      try {
        if (typeof window[name] !== "function") return false;
        if (arg === undefined) window[name](); else window[name](arg);
        return true;
      } catch (e) {
        return false;
      }
    },
    has: function (name) { return typeof window[name] === "function"; },
    /* Démarrer une piste par l'API Connect — le chemin de l'original, qui ne
       dépend pas qu'un bouton de React soit présent ce mois-ci. */
    playUri: function (uri) {
      if (!uri) return false;
      try { window.playFromUri(uri); return true; } catch (e) { return false; }
    },
    /* Ce que le capteur a trouvé — pour la coque, et pour le diagnostic. */
    tokens: function () {
      var clip = function (v, n) { return v ? String(v).slice(0, n) + "…" : null; };
      return {
        device: window.spotDevId || null,
        client: clip(window.spotCliToken, 8),
        auth: window.spotAuthToken ? "Bearer …" + String(window.spotAuthToken).slice(-6) : null,
        uri: window.currUri || null,
      };
    },
    on: function (kind, fn) {
      if (!cbs[kind]) return function () {};
      cbs[kind].push(fn);
      return function () {
        var list = cbs[kind];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    playing: function () { return !!window.playing; },
    /* Ce que le capteur a manqué — et donc ce que la coque a gardé pour elle.
       Un compteur qui monte = la page et le capteur ne sont pas d'accord. */
    captureErrors: function () { return captureErrors; },
    /* Le bouton de lecture est ce que l'original surveille pour savoir si la
       page peut répondre : la coque le lui signale (playLoaded, comme lui). */
    sawButton: function (el) {
      pBtn = el;
      if (el) { try { AndBridge.playLoaded(); } catch (e) {} }
      return !!el;
    },
  };
  /* **L'observateur ne casse pas l'observé.** Le capteur d'origine relit le
     corps de certaines requêtes (« JSON.parse(opts.body) ») et ne s'enveloppe
     d'aucun garde-fou : une requête au body inattendu ferait **rejeter le
     « fetch » de la page** — et Spotify cesse alors de piloter son lecteur, ce qui
     ressemble trait pour trait à « les touches du bas ne font rien ». On
     referme donc le capteur sur lui-même : ce qu'il avait à lire est lu, et si
     sa lecture lève, la requête de la page part quand même, telle quelle. */
  var capte = window.fetch;
  if (capte && capte !== originalFetch) {
    window.fetch = function () {
      var args = arguments;
      var self = this;
      try {
        var r = capte.apply(self, args);
        if (r && typeof r.catch === "function") {
          return r.catch(function () {
            captureErrors++;
            try { return originalFetch.apply(self, args); } catch (e2) { return Promise.reject(e2); }
          });
        }
        return r;
      } catch (err) {
        captureErrors++;
        return originalFetch.apply(self, args);
      }
    };
  }

  /* ------------------------------------------------------------ *
   * L'installateur (coque). Les deux blocs « veille » et « installation » sont
   * le corps de l'intervalle d'origine, qui tournait toutes les 5 secondes :
   * trop lent pour un premier appui — le temps que l'intervalle se réveille, la
   * coque a déjà déclaré la commande manquée. On les rejoue donc sur les
   * mutations de la page, et l'intervalle d'origine reste comme filet.
   *
   * Rien n'est réécrit : le geste est celui de l'application d'origine
   * (revendication .fuckd, playLoaded, danse de déverrouillage à 10 s), seule
   * la cadence vient de nous. Le classList.add("fuckd") est une écriture dans
   * un nœud de la page — exception assumée au repos « on n'écrit pas dans
   * l'arbre de React », parce que c'est un marqueur inerte qui empêche
   * l'origine de revendiquer deux fois le même bouton.
   * ------------------------------------------------------------ */
  var installe = function () {
    try {
      runVeille();
      runInstallation();
    } catch (e) {
      installeErrors++;
    }
  };
  var observer = null;
  var watchBodies = function () {
    try {
      if (!document.body || observer) return;
      observer = new MutationObserver(function () {
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(installe);
        } else {
          installe();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  };
  /* Le filet d'origine : la cadence de son intervalle, à l'identique. */
  setInterval(installe, 5000);
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", watchBodies);
    } else {
      watchBodies();
    }
    installe();
  }
  /* Le moteur est là : la coque peut cesser de compter sur le seul markup. */
  emit("state", { ready: true });
})();
