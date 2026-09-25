/* SpotiDuck — interface d'origine (voir src/original/README.md). Copie de src/original/spotiduck-original.js ; ne pas modifier ici. */
/* ==========================================================================
   SpotiDuck — l'interface d'origine, **code d'origine**, repris tel quel.

   Ce fichier n'est pas une réécriture : c'est le script que l'application
   d'origine (« Spotifuck » 1.6.66, dont SpotiDuck est le dérivé) injecte dans
   la page Spotify sur `onPageFinished`, reconstruit depuis les chaînes
   déchiffrées de `p000/C1356q3.java` dans la source publique déobfusquée
   `lyssadev/Spotifuck_src` (`FILES/js_deobfuscated/`).

   Composition, dans l'ordre, sans une ligne réécrite :

     1. `_player_full_classic.js`  — le script complet, **réglages d'origine**
        (`settings: classic`, ceux de l'application telle qu'elle était livrée).
        C'est lui qui dessine l'affichage d'origine : barre de navigation en
        haut, raccourcis sur deux colonnes, mini-lecteur complet en bas, listes
        resserrées, thème sombre.
     2. `C1356q3__04` (début) — `window.updMedia`, le rapporteur d'état que
        l'application d'origine injectait à part, et qui alimente la
        notification de lecture. Sans lui, le script d'origine ne prévient pas
        Android du morceau en cours.
     3. Un adaptateur `window.SpotiDuckUI` (balisé « SpotiDuck », tout en bas) :
        les cinq lignes qui permettent au service de lecture Android d'appeler
        les fonctions d'origine au lieu du bouton de Spotify.

   Empreintes des deux blocs d'origine, pour vérifier qu'ils n'ont pas bougé :

     script complet   8ebbea13e0992a00  md5 3c0a7c9aac  (21159 caractères)
     rapporteur       d2994110fdb5e345  md5 5cc28d84f1  (585 caractères)

   Le fichier généré est vérifié par `tools/build-original.mjs`, qui refuse de
   livrer si l'un ou l'autre a changé.
   ========================================================================== */

(function() {let reqPause=false,firstPlay=true,ulFlag=false,ffDone=false,npOpen=false;featVer=`web-player_${new Date().toISOString().split('T')[0]}_${Date.now()}_${Math.floor(Math.random()*0xFFFFFFF).toString(16).padStart(7,'0')}`;lastState=null;lastPos=null;playing=false;pfint=null;afint=null;cssint=null;aaint=null;npbtim=null;npvSt=undefined;lCl='𝖫 &nbsp; Close Library';window.hasVid=function(){ return typeof playing!=='undefined'&&playing&&!!document.querySelector('.VideoPlayer__container video'); };window.mngFetch = async function (_0x3c694f, _0x4c6349 = {}) {
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
};const oriFetch=window.fetch;window.fetch=async function(...args) {  const [url,opts]=args;  if(typeof url!=='string') return oriFetch.apply(this,args);  const ts=new Date().toISOString().slice(11,23);  const method=opts?.method?.toUpperCase?.()||'GET';  const headers=opts?.headers||{};  if(method==='POST'&&url.includes('/track-playback/v1/devices')&&opts?.body){    const body=JSON.parse(opts.body);    const deviceId=body?.device?.device_id;    if(deviceId&&deviceId!==window.spotDevId){      window.spotDevId=deviceId;      typeof checkMediaLib==='function'&&checkMediaLib();    }  }  else if(method==='POST'&&url.includes('/pathfinder/v2/query')&&opts?.body){    const body=JSON.parse(opts.body);    if(body?.operationName==='isCurated'){      const currUri=body?.variables?.uris?.[0];      if(currUri&&currUri!==window.currUri){        window.currUri=currUri;      }    }  }  else {    let match=url.match(/\/connect-state\/v1\/player\/(?:command|transfer)\/from\/([^/]+)\/to\/([^/]+)/);    if(match?.[2]&&match[2]!==window.spotDevId) {      window.spotDevId=match[2];      typeof checkMediaLib==='function'&&checkMediaLib();    }  }  const cliToken=headers['Client-Token']||headers['client-token'];  if(cliToken&&cliToken!==window.spotCliToken) {    window.spotCliToken=cliToken;    typeof checkMediaLib==='function'&&checkMediaLib();  }  const authHead=headers.Authorization||headers.authorization;  if(authHead?.startsWith('Bearer ')&&authHead!==window.spotAuthToken) {    window.spotAuthToken=authHead;    typeof checkMediaLib==='function'&&checkMediaLib();  }  if(ffDone&&url.includes('/track-playback/')&&method==='PUT') {    const paused=opts?.body?JSON.parse(opts?.body)?.state_ref?.paused:undefined;    if(paused===true&&playing) { console.log('#Track-Playback: Pause'); manageAll(false); }    else if(paused===false&&!playing) { console.log('#Track-Playback: Play'); manageAll(true); }  }  try { let resp;    if(url.includes('connect-state')) {      console.log('#nFetch:'+url);      resp=await mngFetch(url,opts);    } else     resp=await oriFetch.apply(this,args);    if(resp.status===404&&url.includes('connect-state')&&url.includes('/command/from/')) {      AndBridge.deferMessage('reload');      console.log('Player Locked: reload');      location.reload();    }    return resp;  } catch(err) {    throw err;  }};window.playFromUri = function (_0x4aef97) {
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
window.updNpbState = function () {
  const _0x47baf1 = document.querySelector("aside.NowPlayingView");
  const _0x3b735e = !!_0x47baf1 && _0x47baf1.getBoundingClientRect().x === 0;
  if (_0x3b735e === npvSt) {
    return;
  }
  npvSt = _0x3b735e;
  clearTimeout(npbtim);
  npbtim = setTimeout(() => {
    if (typeof npBtn !== "undefined") {
      npBtn?.classList.toggle("active", npvSt);
    }
  }, 666);
};
window.firstFuck = function () {
  if (pfint) {
    clearInterval(pfint);
  }
  pfint = setInterval(() => {
    if (playing && document.visibilityState == "hidden" && !!document.querySelector(".VideoPlayer__container video")) {
      AndBridge.wakeUp();
    } else if (!AndBridge.isWoke() && document.visibilityState == "visible" && !document.querySelector(".VideoPlayer__container video")) {
      AndBridge.wakeOff();
    }
    if (typeof npBtn == "undefined") {
      let _0x52aa13 = document.querySelector("button[data-testid=lyrics-button]");
      if (_0x52aa13) {
        npBtn = document.createElement("button");
        npBtn.className = "npbtn";
        npBtn.onclick = clickNP;
        npBtn.innerHTML = "<svg viewBox=\"0 0 16 17\"><rect x=\"1\" y=\"0.75\" width=\"14\" height=\"15.5\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M 6 5 L 6 5.9160156 L 9.6933594 8.5 L 6 11.080078 L 6 12 L 11 8.5 L 6 5 z\" stroke=\"currentColor\" stroke-width=\"1.2\"/></svg>";
        _0x52aa13.parentNode.insertBefore(npBtn, _0x52aa13);
        if (!closeNowPlay()) {
          updNpbState();
        }
      }
    }
    let _0x23e543 = document.querySelector("button[data-testid=lyrics-button]:not(.fuckd)");
    if (_0x23e543) {
      _0x23e543.classList.add("fuckd");
      _0x23e543.addEventListener("click", closeNowPlay);
    }
    let _0x544f52 = document.querySelector("div.dpcMut");
    if (!_0x544f52 && (_0x544f52 = document.querySelector("#Desktop_PanelContainer_Id"))) {
      _0x544f52 = _0x544f52.parentNode.parentNode;
      _0x544f52.classList.add("dpcMut");
      new MutationObserver(updNpbState).observe(_0x544f52, {
        childList: true,
        subtree: true
      });
    }
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
    document.querySelectorAll("section[data-testid=home-page]>div>section:nth-child(n+7)").forEach(_0x4412bd => {
      _0x4412bd.replaceChildren();
    });
  }, 5000);
};
firstFuck();
window.manageWake = function (_0xf6371b) {
  if (_0xf6371b) {
    if (document.visibilityState == "hidden") {
      AndBridge.wakeUp();
    }
  } else if (!AndBridge.isWoke() && document.visibilityState == "visible") {
    AndBridge.wakeOff();
  }
};
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
window.clickNP = function () {
  let _0x544907 = document.querySelector("#Desktop_PanelContainer_Id")?.parentNode?.parentNode?.nextElementSibling?.querySelector("button");
  if (_0x544907) {
    npBtn.classList.toggle("active");
    _0x544907.click();
  }
};
window.closeNowPlay = function () {
  let _0x2c02aa = document.querySelector("#Desktop_PanelContainer_Id.NowPlayingView");
  if (_0x2c02aa?.parentNode?.parentNode?.ariaHidden === "false") {
    clickNP();
    npBtn?.classList.remove("active");
    return true;
  }
  return false;
};
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
};window.addAutoFeatures=function(){  console.log('Adding AutoFeatures');if(afint) clearInterval(afint);afint=setInterval(()=>{  /*console.log('af_tick');*/},5000);};window.addAndAuto=function(){};window.addCSSJSHack=function(){if (cssint) {
  clearInterval(cssint);
}
cssint = setInterval(function () {
  let _0x1e5918 = document.querySelector("#Desktop_LeftSidebar_Id header>div>div:first-child button:not(.fuckd)");
  if (_0x1e5918) {
    window.lBtn = _0x1e5918;
    _0x1e5918.classList.add("fuckd", "lbtn");
    _0x1e5918.addEventListener("click", function () {
      setTimeout(() => switchLs(), 0);
    });
    let _0x524a90 = document.querySelector("#Desktop_LeftSidebar_Id>nav>div>div:first-child").classList.length;
    if (_0x524a90 == 2) {
      _0x1e5918.click();
    } else {
      switchLs();
    }
    AndBridge.cssInjected();
  }
  let _0x509048 = document.querySelector("#Desktop_LeftSidebar_Id div[role=grid]:not(.fuckd)");
  if (_0x509048) {
    _0x509048.classList.add("fuckd");
    _0x509048.addEventListener("click", () => {
      setTimeout(() => {
        lBtn.click();
        closeNowPlay();
      }, 0);
    });
  }
  let _0x43a845 = document.querySelector("#global-nav-bar button[data-testid=home-button]:not(.fuckd)");
  if (_0x43a845) {
    _0x43a845.classList.add("fuckd");
    _0x43a845.addEventListener("click", () => {
      closeNowPlay();
    });
  }
  let _0x5a6845 = document.querySelector("input[data-testid=search-input]:not(.fuckd)");
  if (_0x5a6845) {
    _0x5a6845.classList.add("fuckd");
    _0x5a6845.addEventListener("focus", () => {
      let _0x47217d = document.querySelector("aside[data-testid=now-playing-bar]");
      if (_0x47217d) {
        _0x47217d.style.display = "none";
      }
      closeNowPlay();
    });
    _0x5a6845.addEventListener("blur", () => {
      let _0x215b8c = document.querySelector("aside[data-testid=now-playing-bar]");
      if (_0x215b8c) {
        _0x215b8c.style.display = "flex";
      }
    });
  }
  let _0x120e12 = document.querySelector("button[data-testid=user-widget-link]:not(.fuckd)");
  if (_0x120e12) {
    _0x120e12.classList.add("fuckd");
    _0x120e12.addEventListener("click", () => {
      closeNowPlay();
    });
  }
}, 5000);};window.switchLs = function () {
  let _0x17a51b = document.querySelector("#Desktop_LeftSidebar_Id");
  if (_0x17a51b) {
    let _0x5b9afb = _0x17a51b.querySelector("nav>div>div:first-child").classList.length;
    let _0x572262 = document.querySelector("#Desktop_LeftSidebar_Id button.fuckd");
    let _0x368eb7 = _0x17a51b.querySelector("header>div>div:first-child h1");
    let _0x5dbaae = _0x17a51b.querySelector(".YourLibraryX>div>header");
    if (_0x5b9afb == 2) {
      _0x17a51b.style.cssText = "position:fixed;width:100%;height:92%;left:0;z-index:20";
      _0x572262.style.cssText = "padding:10px;height:38px;background:#666;border-radius:10px";
      _0x5dbaae.style.padding = "8px 14px 0px";
      _0x368eb7.innerHTML = lCl;
    } else {
      _0x17a51b.style.cssText = "position:fixed;width:48px;height:48px;top:0;left:60px;z-index:1";
      _0x572262.style.cssText = "padding:0px;height:20px;background:#000;border-radius:0px";
      _0x5dbaae.style.padding = "14px";
      _0x368eb7.innerHTML = "";
    }
  }
};
let st = document.createElement("style");
st.textContent = "*{transition:none!important} body{min-width:100%!important;min-height:100%!important} .os-scrollbar{--os-size:6px!important} .contentSpacing{padding:0} div[data-testid=root]{--panel-gap:0!important} #main-view+div,#main-view+div>div{overflow:hidden!important;width:auto} #main-view+div>div>div>div:nth-child(2)>div{width:100vw!important} div[data-encore-id=banner],#global-nav-bar>div:first-of-type,#global-nav-bar a[href=\"/download\"],button[data-testid=fullscreen-mode-button],div.main-view-container__mh-footer-container{display:none!important} section[data-testid=artist-page]>div>div:first-child:not([data-encore-id]){height:25vh} div[data-testid=tracklist-row]{padding:0 10px 0 0;grid-gap:0} div[data-testid=tracklist-row] button:not([data-testid=add-to-playlist-button]){transform:scale(1.3)!important;opacity:0.6!important} div[data-testid=tracklist-row] button:{-webkit-margin-end:0!important} div[data-testid=tracklist-row] button:hover{color:#2d6!important} div[data-testid=tracklist-row]>div:first-child>div:first-child{height:40px;min-height:40px;min-width:40px;margin:0 4px!important;background-color:#6667;border-radius:50%} [aria-colcount=\"3\"] div[data-testid=tracklist-row]{grid-template-columns:[index] var(--tracklist-index-column-width,46px) [first] minmax(120px,var(--col1,4fr)) [last] minmax(82px,var(--col2,1fr))!important} [aria-colcount=\"4\"] div[data-testid=tracklist-row]{grid-template-columns:[index] var(--tracklist-index-column-width,46px) [first] minmax(120px,var(--col1,4fr)) [var1] minmax(120px,var(--col2,2fr)) [last] minmax(82px,var(--col3,1fr))!important} [aria-colcount=\"5\"] div[data-testid=tracklist-row]{grid-template-columns:[index] var(--tracklist-index-column-width,46px) [first] minmax(120px,var(--col1,6fr)) [var1] minmax(120px,var(--col2,4fr)) [var2] minmax(120px,var(--col3,3fr)) [last] minmax(82px,var(--col4,1fr))!important} section[data-testid=track-page]>div.contentSpacing>div:nth-child(2) [aria-colcount=\"2\"] div[data-testid=tracklist-row]{grid-template-columns:[first] minmax(120px,var(--col0,4fr)) [last] minmax(82px,var(--col1,1fr))!important} section[data-testid=track-page]>div.contentSpacing>div:nth-child(2) [aria-colcount=\"3\"] div[data-testid=tracklist-row]{grid-template-columns:[first] minmax(120px,var(--col0,4fr)) [var1] minmax(120px,var(--col1,2fr)) [last] minmax(82px,var(--col2,1fr))!important} .npbtn{cursor:pointer;color:#b3b3b3;background:transparent;border:none;width:32px;height:32px;padding:8px} .npbtn.active{color:#1db954} .npbtn.active:after{content:\"\";background-color:#1db954;border-radius:50%;width:4px;height:4px;position:absolute;bottom:0;left:50%;transform:translate(-50%);inline-size:4px!important} *{--content-spacing:10px} main>div:first-child>div:last-of-type{padding:0} section[data-testid=home-page]{padding:0} section[data-testid=home-page] .contentSpacing{padding:0 10px!important;overflow:hidden!important} div[data-testid=grid-container]{margin-inline:0!important;column-gap:0!important;overflow:hidden!important} div[data-testid=action-bar-row],div[data-testid=topbar-content]{padding:5px 10px} div[data-testid=track-list]>div:first-child,div[data-testid=playlist-tracklist]>div:first-child{margin:0!important;padding:0!important} main>section:not([data-testid=artist-page])>div:first-child{height:auto!important;min-height:auto!important;padding:10px} section[data-testid=track-page]>div>div.contentSpacing>div:last-child,section[data-testid=playlist-page]>div>div>div.contentSpacing>div:last-child{margin-inline:0} section[data-testid=artist-page]>div>div:first-child>div.contentSpacing{padding:10px} section[data-testid=artist-page] div[data-testid=grid-container] h2,section[data-testid=artist-page] section[data-testid=component-shelf]{padding:0 10px} main>section h1.encore-text-headline-large{font-size:22px!important} section[data-testid=artist-page] span.encore-text-headline-large{font-size:26px!important} section[data-testid=track-page] h1{font-size:20px!important} aside[data-testid=now-playing-bar]{min-width:100%!important;box-shadow:0 0 6px #440000;background:linear-gradient(to bottom,#770000,#330000)!important} aside[data-testid=now-playing-bar]>div:first-child{margin-top:2px;flex-direction:column!important;height:auto!important} aside[data-testid=now-playing-bar]>div>div{width:100%!important} aside[data-testid=now-playing-bar]>div>div:last-child>div{min-height:32px;margin:5px 10px} aside[data-testid=now-playing-bar]>div>div:last-child button{transform:scale(1.15);margin:0 5px} div[data-testid=general-controls]{margin:15px 0 25px} div[data-testid=general-controls] button{transform:scale(1.4)!important;margin:0 8px!important} div[data-testid=player-controls]{margin:5px 0} div[data-testid=now-playing-widget]{justify-content:center;overflow:hidden} form[role=search]{z-index:10;margin-left:48px;max-width:88%} div[data-testid=now-playing-widget]>div:last-child>button{transform:scale(1.3)} div[data-testid=now-playing-widget]>div:first-child{display:none!important} div[data-testid=now-playing-widget]>div:nth-child(2){display:flex!important;overflow:hidden!important} div[data-testid=now-playing-widget]>div:nth-child(2) span{font-size:13px!important;height:20px!important;margin:0!important} div[data-testid=now-playing-widget]>div:nth-child(2)>div{min-width:auto;max-width:66%} [data-tippy-root]{overflow:hidden!important} [data-tippy-root],[data-tippy-root] *{transition:none!important} [data-tippy-root] [data-tippy-root]{transform:none!important} div[data-testid=hover-or-focus-tooltip],#Desktop_LeftSidebar_Id header>div>div:last-child{display:none!important}#Desktop_LeftSidebar_Id>nav>div{min-height:48px;border-radius:25px} kbd,#Desktop_LeftSidebar_Id>nav>div>div>div>article{display:none} .YourLibraryX{overflow:hidden;background:var(--background-elevated-base)!important} section[data-testid=home-page]>div>section:nth-child(n+7){display:none} div[data-testid=now-playing-widget]>div:nth-child(2):has(>:nth-child(3)):not(:has(>:nth-child(4)))>:nth-child(2){display:none}";
document.head.appendChild(st);})();
/* --------------------------------------------------------------------------
   Rapporteur d'état de l'application d'origine (`C1356q3__04`) : il transmet
   à Android le morceau en cours, et alimente donc la notification.
   -------------------------------------------------------------------------- */
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


/* --------------------------------------------------------------------------
   SpotiDuck — seul ajout : l'adaptateur du service de lecture Android.
   L'interface reste celle d'origine ; `window.SpotiDuckUI` ne fait que
   relayer les fonctions d'origine existantes (contrepartie : `actSeek` compte
   en secondes, comme la barre de Spotify, le service envoie des millisecondes).
   -------------------------------------------------------------------------- */
(function () {
  if (window.SpotiDuckUI && window.SpotiDuckUI.version) return;
  var call = function (name, arg) {
    try {
      if (typeof window[name] !== "function") return false;
      if (arg === undefined) window[name]();
      else window[name](arg);
      return true;
    } catch (e) {
      return false;
    }
  };
  var label = function () {
    var b = document.querySelector("button[data-testid=control-button-playpause]");
    return (b && (b.getAttribute("aria-label") || b.getAttribute("title"))) || "";
  };
  window.SpotiDuckUI = {
    version: "original",
    mode: "original",
    play: function () {
      if (/pause/i.test(label())) return true; // déjà en lecture
      return call("actPlayPause");
    },
    pause: function () {
      if (/^(play|lecture|reprendre)/i.test(label().trim())) return true; // déjà en pause
      return call("actPlayPause");
    },
    playPause: function () {
      return call("actPlayPause");
    },
    next: function () {
      return call("actSkipForward");
    },
    previous: function () {
      return call("actSkipBack");
    },
    like: function () {
      return call("actAddToFav");
    },
    repeat: function () {
      return call("actRepeat");
    },
    seek: function (ms) {
      return call("actSeek", Math.max(0, Number(ms) || 0) / 1000);
    },
    sync: function () {
      return call("updMedia");
    },
    openQueue: function () {
      return call("clickNP");
    },
    close: function () {
      return call("closeNowPlay");
    },
    back: function () {
      if (window.history.length > 1) {
        window.history.back();
        return true;
      }
      return false;
    },
  };
})();
