#!/usr/bin/env node
/**
 * Sonde de la coque — la charge sur la **vraie** page de Spotify, dans un vrai
 * Chrome, et dit ce qu'elle devient.
 *
 *     node tools/probe-coop.mjs        (depuis la CI : le runner a Chrome)
 *
 * Pourquoi cette sonde existe : `npm run smoke` vérifie la coque sur une page
 * **factice** (`demo/mock/spotify.js`). Une page factice ne dit rien de la page
 * réelle — c'est exactement l'angle mort dans lequel l'utilisateur est tombé
 * deux fois de suite :
 *
 *   · « le bouton ne fait rien, je suis bloqué à la connexion » ;
 *   · « les boutons ne sont pas comme notre version, rien n'est relié à
 *     aucune action ».
 *
 * Ce que la sonde relève, dans l'ordre où l'application le fait :
 *
 *   1. l'identité (`src/original/spotiduck-identity.js`) au **début** du
 *      chargement, avant que la page ne lise quoi que ce soit ;
 *   2. la coque (`dist/spotiduck-ui.js`) à la **fin** du chargement (`onPageFinished`) ;
 *   3. puis, sur la page : la coque est-elle construite (`.sd-layer`, classe
 *      `sd-mobile`, onglets) ? ses styles sont-ils appliqués (position, taille
 *      réelle de la barre) ? **un appui sur un onglet produit-il une action** ?
 *      et **quelles erreurs** la page a-t-elle levées ?
 *
 * Ne lève jamais : tout part en annotations (quatre au maximum — GitHub
 * tronque au-delà) et dans /tmp/probe-coop/rapport.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

/** L'agent que `MainActivity.userAgentFor` donne à la coque depuis la 2.11.20
 *  (`MOBILE_UA`) : c'est lui qui fait servir à Spotify la page du **mobile**,
 *  celle pour laquelle la coque est dessinée. Mesurer la coque avec l'agent de
 *  bureau ne mesurait plus l'application — et laissait passer « la page est
 *  rognée des deux tiers » sous un verdict « tout atteignable ». */
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Mobile Safari/537.36";

const OUT = "/tmp/probe-coop";
mkdirSync(OUT, { recursive: true });

const report = { at: new Date().toISOString(), pages: [] };
/* Les règles dures, celles qui doivent faire échouer le run (voir GUARD). */
const fautes = [];

const clean = (text, max = 700) => String(text).replace(/\s+/g, " ").slice(0, max);
const note = (title, text) => {
  const line = clean(text, 1800);
  console.log(`::notice title=${title}::${line}`);
  console.log(`[Sonde coque] ${title} — ${line}`);
};
const warn = (title, text) => {
  const line = clean(text, 1800);
  console.log(`::warning title=${title}::${line}`);
  console.log(`[Sonde coque] ⚠ ${title} — ${line}`);
};
/* -------------------------------------------------------------------------- *
 * **Le garde-fou.** Ce qui suit n'est pas un relevé : ce sont des règles qui
 * font **échouer** la sonde. Trois versions de suite ont été publiées « tout
 * vert » alors que le téléphone ne répondait plus, parce que `npm run smoke`
 * interroge une page **factice** — et qu'ici, la coque se verrouillait
 * elle-même (boutons posés en `disabled`, donc incapables de recevoir un
 * appui) sans que personne ne le voie.
 *
 * Les règles sont choisies pour être décidables **sans session** : elles portent
 * sur ce que la coque se fait à elle-même, pas sur ce que Spotify veut bien
 * répondre. Une alarme à tort est un défaut — donc rien ici ne dépend du
 * contexte (page réelle, banc, connexion) ni de ce qui joue.
 * -------------------------------------------------------------------------- */
const GUARD = () => {
  const fautes = [];
  const root = document.documentElement;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const tous = [].slice.call(document.querySelectorAll(".sd-layer .sd-iconbtn"));
  const boites = new Map();
  tous.forEach((b) => boites.set(b, b.getBoundingClientRect()));
  const visibles = tous.filter((b) => {
    const r = boites.get(b);
    return r.width > 3 && r.height > 3;
  });
  const nom = (el) =>
    (String(el.className).split(" ").find((c) => /^sd-(mini|ctrl|tab|top)/.test(c)) ||
      el.tagName.toLowerCase()) + (el.className ? "." + String(el.className).split(" ")[0] : "");

  /* 1. Un bouton de la coque posé en `disabled` ne reçoit **aucun** événement :
        l'appui ne déclenche ni commande ni message. C'est « le lecteur ne fait
        rien », et c'est exactement ce que la coque se faisait à elle-même. */
  const verrouilles = visibles.filter((b) => b.disabled === true);
  if (verrouilles.length) {
    fautes.push(`${verrouilles.length} bouton(s) de la coque verrouillés en \`disabled\` : ${verrouilles.slice(0, 3).map(nom).join(", ")} — un appui y est perdu sans message`);
  }

  /* 2. Un bouton visible et non verrouillé doit **recevoir** l'appui posé en son
        centre. S'il est recouvert, l'utilisateur touche et il ne se passe rien. */
  const muets = [];
  visibles.forEach((b) => {
    if (b.disabled === true) return;
    const r = boites.get(b);
    if (r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1 || r.left < -1) return; // hors écran : pas un appui perdu
    let hit = null;
    try {
      hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    } catch (e) {
      hit = null;
    }
    if (!hit) return;
    if (hit === b || b.contains(hit)) return;
    muets.push(`${nom(b)} recouvert par ${hit.tagName.toLowerCase()}${hit.className ? "." + String(hit.className).split(" ")[0] : ""}`);
  });
  if (muets.length) fautes.push(`l'appui ne parvient pas au bouton : ${muets.slice(0, 3).join(" · ")}`);

  /* 3. « Aucun titre » alors que la page joue : la coque est aveugle à son propre
        lecteur, et c'est ce qui la faisait se verrouiller. */
  const quiJoue = [].slice.call(document.querySelectorAll("audio")).find((m) => !m.paused && Number(m.duration) > 0);
  if (quiJoue && root.classList.contains("sd-mini-empty")) {
    fautes.push("la page joue un titre et la coque se croit sans piste (`sd-mini-empty`) : elle redevient muette");
  }

  /* 4. La place réservée en bas doit être la hauteur **mesurée** du lecteur :
        fausse, la page est coupée ou laisse une bande morte. */
  const mini = document.querySelector(".sd-mini");
  if (mini && !root.classList.contains("sd-player-open") && !root.classList.contains("sd-login")) {
    const h = Math.ceil(mini.getBoundingClientRect().height || 0);
    const reserve = parseFloat(getComputedStyle(mini).getPropertyValue("--sd-mini-h-current")) || 0;
    if (h > 3 && Math.abs(reserve - h) > 6) {
      fautes.push(`place réservée ${Math.round(reserve)}px pour un lecteur réellement haut de ${h}px`);
    }
  }

  /* 5. Nos barres ne débordent pas de l'écran (la mise en page est forcée à la
        largeur du téléphone par la WebView : un débordement = rogné). */
  const depassent = [].slice
    .call(document.querySelectorAll(".sd-layer > *"))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 3 && (r.right > vw + 1 || r.left < -1);
    })
    .map((el) => `${String(el.className).split(" ")[0]} jusqu'à ${Math.round(el.getBoundingClientRect().right)} pour ${vw}`);
  if (depassent.length) fautes.push(`nos barres dépassent l'écran : ${depassent.slice(0, 3).join(" · ")}`);

  /* 6. **Une page de bureau dans un écran de téléphone.** C'est le défaut mère :
        la coque demandait l'agent de bureau (page pensée pour 1280 px et plus)
        tout en étant mise en page sur 412 px — la grille était rognée des deux
        tiers et les commandes de la barre tombaient hors écran. Un élément plus
        large que la fenêtre n'est pas une faute en soi (les carrousels débordent
        exprès) : ne sont comptés que ceux qu'**aucun** ancêtre ne rogne, parce
        que ceux-là sont réellement coupés à l'écran. */
  const principal = document.querySelector("#main-view") || document.querySelector("main") || document.body;
  const rogneurs = /auto|scroll|hidden|clip/;
  let coupes = 0;
  let exempleCoupe = "";
  [].slice.call(principal.querySelectorAll("*"), 0, 500).forEach((el) => {
    if (coupes > 3) return;
    const r = el.getBoundingClientRect();
    /* Seulement les débordements **manifestes** (un quart de plus que l'écran) :
       un carrousel de 430 px sur 412 est voulu, une grille de bureau de 1280 px
       ne l'est pas. Et un élément fixe n'est pas « dans » la page. */
    if (r.width <= Math.max(vw + 8, vw * 1.25)) return;
    if (!el.getClientRects().length) return;
    if (getComputedStyle(el).position === "fixed") return;
    for (let a = el.parentElement; a && a !== principal.parentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (rogneurs.test(s.overflowX) || rogneurs.test(s.overflow)) return;
    }
    coupes++;
    if (!exempleCoupe) {
      exempleCoupe = (el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "") + " " + Math.round(r.width) + "px pour " + vw);
    }
  });
  if (coupes) fautes.push(`mise en page trop large pour l'écran : ${coupes} élément(s) non rogné(s) débordent (${exempleCoupe}) — la page servie n'est pas celle du mobile`);

  return { fautes, boutons: tous.length, visibles: visibles.length, joue: quiJoue ? 1 : 0, largeur: vw };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Ce que la sonde va interroger sur chaque page. Renvoie un objet plat : tout
   ce qui peut expliquer « les boutons ne font rien ». */
const MEASURE = async () => {
  const out = {};
  const root = document.documentElement;
  out.url = location.href;
  out.classes = root.className;
  out.namespace = typeof window.SpotiDuckUI;
  out.layer = !!document.querySelector(".sd-layer");
  out.layerChildren = [...document.querySelectorAll(".sd-layer > *")].map((el) => el.className).slice(0, 12);
  out.tabs = [...document.querySelectorAll(".sd-tab")].map((el) => (el.textContent || "").trim().slice(0, 24));
  out.tabHrefs = [...document.querySelectorAll(".sd-tab")].map((el) => el.getAttribute("href") || el.dataset.route || "");
  out.styles = [...document.querySelectorAll("style")].length;
  out.cssBytes = [...document.querySelectorAll("style")].reduce((n, el) => n + (el.textContent || "").length, 0);

  /* Les styles sont-ils *appliqués* ? Une coque construite mais non stylée est
     exactement ce que décrit « les boutons ne sont pas comme notre version ». */
  const tabbar = document.querySelector(".sd-tabbar");
  if (tabbar) {
    const cs = getComputedStyle(tabbar);
    const rect = tabbar.getBoundingClientRect();
    out.tabbar = { position: cs.position, display: cs.display, bottom: cs.bottom, h: Math.round(rect.height), w: Math.round(rect.width), visible: rect.height > 0 && rect.width > 0 };
  } else {
    out.tabbar = null;
  }
  const mini = document.querySelector(".sd-mini");
  if (mini) {
    const cs = getComputedStyle(mini);
    const rect = mini.getBoundingClientRect();
    out.mini = { position: cs.position, display: cs.display, h: Math.round(rect.height), visible: rect.height > 0 };
  } else {
    out.mini = null;
  }

  /* Chaque contrôle de la coque : présent ? visible (vraie boîte) ? cliquable ?
     « Les boutons ne sont pas comme notre version » se mesure ici : un contrôle
     à 0×0 px ou sous `display:none` est un contrôle que l'utilisateur ne voit
     pas, et « rien n'est relié » commence toujours par là. */
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "absent";
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
    return `${visible ? "visible" : "MASQUÉ"} ${Math.round(rect.width)}×${Math.round(rect.height)} pos=${cs.position} z=${cs.zIndex}`;
  };
  out.controls = {
    "barre du haut (.sd-nav)": box(".sd-nav"),
    "onglet Bibliothèque (.sd-nav-item)": box('.sd-nav-item[data-tab="library"]'),
    "barre du bas (.sd-tabbar)": box(".sd-tabbar"),
    "mini-lecteur (.sd-mini)": box(".sd-mini"),
    "en-tête (.sd-topbar)": box(".sd-topbar"),
    "lecteur plein écran (.sd-player)": box(".sd-player"),
  };
  /* Ce qu'il reste du chrome de Spotify : s'il est encore là ET que le nôtre
     ne l'est pas, l'utilisateur voit des boutons de Spotify — « pas comme
     notre version ». */
  /* Marqueurs propres à l'interface d'origine : elle se reconnaît à ses
     fonctions globales et à ses propres nœuds. */
  out.originalUi = {
    firstFuck: typeof window.firstFuck,
    actPlayPause: typeof window.actPlayPause,
    switchLs: typeof window.switchLs,
    miniPlayer: !!document.querySelector(".npbtn, .np-btn, #npBtn"),
    topNav: !!document.querySelector(".sd-nav"),
    feuilleOrigine: [...document.querySelectorAll("style")].some((el) => (el.textContent || "").indexOf("now-playing-bar") >= 0),
  };

  out.spotifyChrome = {
    barreLaterale: box("#Desktop_LeftSidebar_Id"),
    barreHaute: box('[data-testid="topbar-content"]'),
    navGlobale: box("#global-nav-bar"),
    barreLecture: box('[data-testid="now-playing-bar"]'),
  };

  /* La page réelle : le lecteur est-il là (donc la session) ? */
  out.desktopLayout = {
    barreLaterale: !!document.querySelector("#Desktop_LeftSidebar_Id"),
    barreLecture: !!document.querySelector('[data-testid="now-playing-bar"]'),
    mainView: !!document.querySelector("#main-view"),
    accueil: !!document.querySelector('[data-testid="home-page"]'),
    connexion: !!document.querySelector('[data-testid="login-form"], #login-username'),
  };
  out.title = document.title.slice(0, 80);
  /* La mise en page **du téléphone** : c'est l'angle mort de toutes les
     versions précédentes. Le web player de Spotify ne déclare aucun
     `<meta name="viewport">` ; une WebView en `useWideViewPort` se donne alors
     une largeur de mise en page de **980 px** et dézoome pour la faire tenir à
     l'écran — tout paraît petit, rogné, « pas adapté à Android ». Mesurer
     `innerWidth` / `clientWidth` / le débordement, c'est mesurer ça. */
  var meta = document.querySelector("meta[name='viewport']");
  /* Qui déborde : un élément plus large que l'écran explique « c'est rogné, il
     faut faire glisser la page ». On les nomme — la coque n'est pas la page. */
  /* **Ce qui est rogné.** `debordement` se mesure avec `scrollWidth` — or notre
     feuille met `overflow-x: hidden`, donc ce qui dépasse est coupé *sans*
     augmenter `scrollWidth` : la sonde annonçait « débordement 0 » alors que
     l'utilisateur voyait « c'est encore coupé ». On mesure donc le rognage réel,
     élément par élément : ce qui sort de l'écran (rect.right) **et** ce qui est
     coupé par un parent en `overflow: hidden` (scrollWidth > clientWidth). */
  out.rognes = (function () {
    var w = root.clientWidth;
    var out = { sort: [], coupes: [] };
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest(".sd-layer")) continue;
      var r = el.getBoundingClientRect();
      if (r.height > 4 && r.width > 40 && r.right > w + 3 && out.sort.length < 8) {
        out.sort.push(
          (el.getAttribute("data-testid") || el.tagName.toLowerCase()) +
            " " + Math.round(r.width) + "px depasse=" + Math.round(r.right - w)
        );
      }
      var cs = window.getComputedStyle(el);
      var clipX = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.overflow === "hidden";
      if (clipX && el.scrollWidth > el.clientWidth + 4 && out.coupes.length < 8) {
        out.coupes.push(
          (el.getAttribute("data-testid") || el.tagName.toLowerCase()) +
            " " + el.clientWidth + "<" + el.scrollWidth +
            " (" + Math.round((el.scrollWidth / Math.max(1, el.clientWidth) - 1) * 100) + "%)"
        );
      }
    }
    /* Le verdict utile : les **conteneurs** de rangée tiennent-ils dans
       l'écran ? Une piste de carrousel plus longue que son conteneur est
       normale (elle défile) : elle est comptée à part, et seule sa présence
       dans un parent rogné signale un défaut. */
    var containers = [];
    var sels = [
      'section[data-testid=component-shelf]',
      '[data-testid=carousel-scroller]',
      'div[data-testid=grid-container]',
      '[data-testid=home-page]',
      '#main-view',
    ];
    for (var k = 0; k < sels.length; k++) {
      var list = document.querySelectorAll(sels[k]);
      for (var l = 0; l < list.length; l++) {
        var rr = list[l].getBoundingClientRect();
        if (rr.width > w + 3) {
          containers.push(sels[k] + " " + Math.round(rr.width) + "px (+" + Math.round(rr.width - w) + ")");
        }
      }
    }
    return (
      "conteneurs-trop-larges: " + (containers.join(" . ") || "aucun") +
      " || hors-ecran: " + (out.sort.join(" . ") || "aucun") +
      " || coupes-par-un-parent: " + (out.coupes.join(" . ") || "aucun")
    );
  })();

  out.debordants = (function () {
    var w = root.clientWidth;
    var found = [];
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && found.length < 30; i++) {
      var el = all[i];
      if (el.closest && el.closest(".sd-layer")) continue;
      var r = el.getBoundingClientRect();
      if (r.height <= 0 || r.width < 60 || r.right <= w + 4) continue;
      var tid = el.getAttribute && el.getAttribute("data-testid");
      var cls = (el.getAttribute && el.getAttribute("class")) || "";
      found.push(
        el.tagName.toLowerCase() +
          (tid ? "[" + tid + "]" : "") +
          (cls ? "." + String(cls).split(/\s+/).slice(0, 2).join(".") : "") +
          "=" + Math.round(r.width)
      );
    }
    return found.slice(0, 8).join(", ");
  })();
  /* « Adapté à l'appareil » se mesure aussi : un contrôle plus petit que 44 px
     n'est pas touchable au doigt (la cible Material minimale). */
  /* **La structure de la page, telle qu'elle est.** Nos regles masquent la
     barre du haut et la barre laterale de Spotify ; si l'une des deux est en
     realite l'ancetre du contenu, l'ecran devient noir - c'est exactement ce
     qu'une capture du telephone a montre. Ce releve nomme le coupable. */
  out.structure = (function () {
    var sels = [
      "#main",
      "#main-view",
      "#global-nav-bar",
      "#Desktop_LeftSidebar_Id",
      "#Desktop_PanelContainer_Id",
      "main",
      "[data-testid=home-page]",
    ];
    var rows = [];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el) {
        rows.push(sels[i] + "=absent");
        continue;
      }
      var cs = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      rows.push(
        sels[i] +
          "=" + Math.round(r.width) + "x" + Math.round(r.height) +
          " " + cs.display + "/" + cs.visibility +
          (el.querySelector("#main-view,[data-testid=home-page]") ? " CONTIENT-LE-CONTENU" : "") +
          (el.getAttribute("data-sd-unhidden") ? " REAFFICHE" : "")
      );
    }
    return rows.join(" . ");
  })();

  /* Le contenu du milieu de l'ecran est-il visible ? C'est la question posee
     par « on voit rien », et elle se mesure. */
  out.contentVisible = (function () {
    var anchor = document.querySelector('[data-testid=home-page], #main-view, main[data-testid], main');
    if (!anchor) return "contenu: absent";
    var r = anchor.getBoundingClientRect();
    var cs = window.getComputedStyle(anchor);
    var chain = [];
    var node = anchor;
    while (node && node.nodeType === 1 && node !== document.body) {
      var c = window.getComputedStyle(node);
      if (c.display === "none" || c.visibility === "hidden") {
        chain.push((node.id || node.tagName.toLowerCase()) + ":" + c.display + "/" + c.visibility);
      }
      node = node.parentNode;
    }
    return (
      "contenu=" + Math.round(r.width) + "x" + Math.round(r.height) +
      " " + cs.display +
      (chain.length ? " . CACHE-PAR: " + chain.join(" < ") : " . aucun ancetre masque")
    );
  })();

  /* **Ce qui pilote la taille du contenu.** « Ca rends pas tres beau » : sur le
     telephone, les pochettes de l'accueil mesurent ~59 px avec des gouttières de
     ~36 px. Il faut savoir QUI décide de ces tailles (la grille ? une variable
     CSS ? un style en ligne ?) avant d'écrire la moindre règle. */
  /* **Toutes les rangées, avec leurs tailles réelles.** La première version ne
     regardait que la première shelf — or l'accueil en mélange plusieurs types
     (carrousels, grilles à quatre colonnes). Pour chaque rangée : le conteneur
     qui décide (nommé), son mode d'affichage, le nombre de colonnes, les
     gouttières, la carte et la pochette. C'est ce relevé qui permet d'écrire la
     bonne règle — et de voir laquelle des rangées ressemble à la capture
     (« des pochettes de 59 px, quatre colonnes, 36 px de vide »). */
  out.shelves = (function () {
    var list = document.querySelectorAll('section[data-testid=component-shelf]');
    var rows = [];
    for (var i = 0; i < list.length && i < 8; i++) {
      var sh = list[i];
      var sr = sh.getBoundingClientRect();
      var img = sh.querySelector("img");
      var ir = img ? img.getBoundingClientRect() : null;
      /* Le conteneur des cartes : le premier descendant qui porte un
         `data-testid` connu, sinon le premier enfant de l'en-tête suivant. */
      var container =
        sh.querySelector('[data-testid=grid-container], [data-testid=carousel-scroller]') ||
        (sh.children.length > 1 ? sh.children[1] : sh);
      var cs = window.getComputedStyle(container);
      /* La carte : remonte depuis l'image jusqu'à l'enfant direct d'un
         conteneur qui en aligne plusieurs. */
      var card = img;
      var guard = 0;
      while (card && card.parentElement && card.parentElement !== container && guard++ < 8) {
        card = card.parentElement;
      }
      var cr = card ? card.getBoundingClientRect() : null;
      rows.push(
        "#" + (i + 1) +
          " " + Math.round(sr.width) + "x" + Math.round(sr.height) +
          " cont=" + (container.getAttribute("data-testid") || container.tagName.toLowerCase()) +
          " " + cs.display +
          (cs.gridTemplateColumns && cs.gridTemplateColumns !== "none"
            ? " cols=" + cs.gridTemplateColumns.split(" ").length
            : "") +
          " gap=" + cs.columnGap +
          (cr ? " carte=" + Math.round(cr.width) + "x" + Math.round(cr.height) : " carte=?") +
          (ir ? " image=" + Math.round(ir.width) + "x" + Math.round(ir.height) : " image=?")
      );
    }
    return rows.join(" . ") || "aucune shelf";
  })();

  /* **L'accueil maison.** Les données viennent de la page, la mise en page est
     la nôtre : on relève donc ce qu'il affiche vraiment (rangées, cartes,
     filtres, raccourcis) et s'il laisse les barres respirer. Sur la page du
     téléphone, l'accueil est masqué (session fermée côté CI) — c'est attendu, et
     il faut que ce soit écrit pour ne pas confondre « masqué exprès » et
     « cassé ». */
  out.home = (function () {
    var board = document.querySelector(".sd-home");
    if (!board) return "accueil maison absent";
    var r = board.getBoundingClientRect();
    var nav = document.querySelector(".sd-nav");
    var mini = document.querySelector(".sd-mini");
    var navR = nav ? nav.getBoundingClientRect() : null;
    var miniR = mini ? mini.getBoundingClientRect() : null;
    var chips = board.querySelectorAll(".sd-chip").length;
    var cards = board.querySelectorAll(".sd-home-card").length;
    var sections = board.querySelectorAll(".sd-home-section").length;
    var label = function (el) {
      var h = el ? el.querySelector(".sd-home-section-title") : null;
      return h ? (h.textContent || "").trim().slice(0, 18) : "?";
    };
    var first = board.querySelector(".sd-home-section");
    var cover = board.querySelector(".sd-home-cover");
    var coverR = cover ? cover.getBoundingClientRect() : null;
    return (
      (board.hidden ? "masqué (aucune donnée ou hors accueil)" : "affiché") +
      " zone=" + Math.round(r.width) + "x" + Math.round(r.height) +
      " top=" + Math.round(r.top) +
      (navR ? " nav-bas=" + Math.round(navR.bottom) : "") +
      (miniR ? " mini-haut=" + Math.round(miniR.top) : "") +
      " rangées=" + sections + " cartes=" + cards + " filtres=" + chips +
      " raccourcis=" + board.querySelectorAll(".sd-shortcut").length +
      (sections ? " 1re=" + JSON.stringify(label(first)) : "") +
      (coverR ? " pochette=" + Math.round(coverR.width) + "x" + Math.round(coverR.height) : "")
    );
  })();

  /* **Ce que notre coque conclut de cette page.** Le diagnostic du téléphone
     (« contenu 29x2756 ») et l'accueil maison qui ne s'affichait pas se lisent
     ici : quelle ancre est choisie, ce qu'elle contient *rendu*, si le chemin
     est reconnu comme l'accueil, et si l'écran d'accueil (session fermée) a de
     quoi se montrer. */
  out.verdict = (function () {
    var api = window.SpotiDuckUI;
    var out = { version: String(window.__SD_VERSION__ || "?"), api: !!api };
    if (!api) return out;
    try {
      out.state = api.content && api.content.state ? api.content.state().why : "?";
      out.ok = api.content && api.content.state ? api.content.state().ok : "?";
    } catch (e) {
      out.state = "erreur " + e.message;
    }
    try {
      out.homePath = api.home && api.home.isHomePath ? api.home.isHomePath() : "?";
    } catch (e) {
      out.homePath = "erreur";
    }
    /* Le contenu : l'ancre que *nous* choisissons, sa boîte et ce qu'elle rend. */
    var anchor = document.querySelector('[data-testid=home-page], #main-view, main[data-testid], main');
    if (anchor) {
      var r = anchor.getBoundingClientRect();
      var cs = window.getComputedStyle(anchor);
      var txt = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
      out.anchor = {
        tag: anchor.tagName.toLowerCase() + (anchor.id ? "#" + anchor.id : "") + (anchor.getAttribute("data-testid") ? "[data-testid=" + anchor.getAttribute("data-testid") + "]" : ""),
        box: Math.round(r.width) + "x" + Math.round(r.height),
        display: cs.display + "/" + cs.visibility,
        text: txt.length,
        elements: anchor.querySelectorAll("button,[role=button],a[href],img,input,iframe,svg,canvas").length,
        sample: txt.slice(0, 90),
      };
    } else {
      out.anchor = null;
    }
    /* La session : le lecteur est-il là, y a-t-il un formulaire, un lien de
       connexion (donc la page marketing) ? Et notre écran d'accueil ? */
    out.session = {
      mainView: !!document.querySelector("#main-view, [data-testid=home-page]"),
      barreLecture: !!document.querySelector('[data-testid="now-playing-bar"]'),
      formulaire: !!document.querySelector('[data-testid="login-form"], #login-username'),
      lienConnexion: !!document.querySelector('a[href^="/login"], a[href*="/login"], a[href*="accounts.spotify.com"]'),
      boutonConnexion: !!document.querySelector('button[data-testid*="login"], button[data-testid*="signup"]'),
      accueilMAison: document.documentElement.classList.contains("sd-welcome-on") ? "notre écran d'accueil" : "-",
    };
    return out;
  })();

  /* **La bibliothèque maison.** L'onglet bibliothèque affichait la barre
     latérale de Spotify ; notre page lit la bibliothèque du compte par l'API.
     Sur le banc, il n'y a pas de session : ce qui compte est donc l'état
     (masquée faute de jeton = la barre latérale reste) et l'absence de
     régression sur les lignes. */
  out.library = (function () {
    var panel = document.querySelector(".sd-lib");
    var api = window.SpotiDuckUI;
    var state = api && api.library && api.library.describe ? api.library.describe() : "?";
    if (!panel) return "bibliothèque maison absente · état=" + state;
    var r = panel.getBoundingClientRect();
    return (
      (panel.hidden ? "masquée" : "affichée") +
      " zone=" + Math.round(r.width) + "x" + Math.round(r.height) +
      " lignes=" + panel.querySelectorAll(".sd-lib-row").length +
      " filtres=" + panel.querySelectorAll(".sd-lib-chip").length +
      " état=" + state +
      " barre-laterale=" +
      (document.documentElement.classList.contains("sd-lib-on") ? "remplacee" : "laissee a Spotify")
    );
  })();

  /* **Le bas de l'écran.** La capture du 25/09 montrait la page coupée avec une
     bande noire en dessous : la place du mini-lecteur était réservée alors qu'il
     n'était pas affiché. On mesure donc ce qui est réservé, ce qui est
     réellement affiché, et la marge entre le contenu et le bas de l'écran. */
  out.bottom = (function () {
    var cs = window.getComputedStyle(document.documentElement);
    var reserved = cs.getPropertyValue("--sd-bottom").trim();
    var state = function (el) {
      if (!el) return "absent";
      var r = el.getBoundingClientRect();
      var c = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && c.display !== "none" ? "affiché" : "caché";
    };
    var mini = state(document.querySelector(".sd-mini"));
    var tabbar = state(document.querySelector(".sd-tabbar"));
    /* Le conteneur qui porte notre page (accueil ou bibliothèque), s'il est là. */
    var page = document.querySelector(".sd-home:not([hidden]), .sd-lib:not([hidden])");
    var margin = "";
    if (page) {
      var r = page.getBoundingClientRect();
      margin =
        " · page jusqu'à " + Math.round(r.bottom) + "/" + window.innerHeight +
        " (marge " + Math.round(window.innerHeight - r.bottom) + "px)";
    }
    return "réservé=" + reserved + " · mini=" + mini + " · barre-onglets=" + tabbar + margin;
  })();

  out.tapTargets = (function () {
    var els = document.querySelectorAll(".sd-layer .sd-nav-item, .sd-layer .sd-iconbtn, .sd-layer .sd-tab");
    var min = 999;
    var count = 0;
    var small = 0;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      count++;
      var s = Math.min(r.width, r.height);
      if (s < min) min = s;
      if (s < 44) small++;
    }
    return count ? Math.round(min) + "px (" + small + "/" + count + " sous 44)" : "aucun";
  })();
  out.unit = getComputedStyle(root).getPropertyValue("--sd-u").trim();

  out.layout = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    htmlClientWidth: root.clientWidth,
    visualViewport: window.visualViewport ? String(Math.round(window.visualViewport.width)) : "-",
    screen: String(screen.width) + "x" + String(screen.height),
    dpr: String(window.devicePixelRatio),
    meta: meta ? String(meta.getAttribute("content")).slice(0, 60) : "aucun",
    debordement: document.body ? Math.max(0, document.body.scrollWidth - root.clientWidth) : -1,
    contenu: (function () {
      var el = document.querySelector("#main-view, [data-testid='home-page'], main");
      if (!el) return "absent";
      var r = el.getBoundingClientRect();
      return Math.round(r.width) + "×" + Math.round(r.height) +
        " police=" + getComputedStyle(el).fontSize;
    })(),
  };
  return out;
};

/** L'état intérieur de la coque — ce que ses boutons sont censés changer. */
const SHELL_STATE = () => {
  const api = window.SpotiDuckUI;
  const sidebar = document.querySelector("#Desktop_LeftSidebar_Id");
  const cs = sidebar ? getComputedStyle(sidebar) : null;
  const rect = sidebar ? sidebar.getBoundingClientRect() : null;
  return {
    path: location.pathname,
    classes: document.documentElement.className.split(/\s+/).filter((c) => c.indexOf("sd-") === 0).join(" "),
    stateTab: api && api.state ? api.state.tab : null,
    route: api && api.state ? api.state.route : null,
    sidebarDisplay: cs ? cs.display : "absente",
    sidebarBox: rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : "-",
    recherche: !!document.querySelector('[data-testid="search-page"]'),
    accueil: !!document.querySelector('[data-testid="home-page"]'),
    dialogue: !!document.querySelector('[role="dialog"]'),
    erreurs: (window.__sdProbeErrors || []).slice(0, 4),
  };
};

/** Un appui réel sur un contrôle, et ce qu'il déclenche. */
/* **Ce que la page montre quand on ouvre l'onglet Bibliothèque.** Le 25/09 :
   « quand on clique sur l'onglet bibliothèque, la barre en haut disparaît et
   rien d'autre n'apparaît ; je reste bloqué sur l'écran d'accueil ». Le relevé
   général est pris avant tout appui et sa ligne a été coupée par la limite de
   1 800 caractères des annotations : cette mesure-ci est donc courte et part
   seule, pour dire en une ligne si la bibliothèque s'affiche, si l'accueil se
   retire et si la navigation reste là. */
const TABMEASURE = () => {
  const state = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "absent";
    const r = el.getBoundingClientRect();
    const c = window.getComputedStyle(el);
    const gone = el.hidden === true || c.display === "none" || c.visibility === "hidden" || r.width < 2 || r.height < 2;
    return (gone ? "caché" : "visible") + " " + Math.round(r.width) + "x" + Math.round(r.height);
  };
  const active = document.querySelector(".sd-nav-item.is-active, .sd-nav-item[aria-current]");
  const title = document.querySelector(".sd-lib-title");
  const api = window.SpotiDuckUI;
  const lib = document.querySelector(".sd-lib");
  return {
    chemin: location.pathname,
    ongletActif: active ? (active.textContent || "").trim().slice(0, 18) : "aucun",
    bibliotheque: state(".sd-lib"),
    titre: title ? `"${(title.textContent || "").trim().slice(0, 20)}"` : "absent",
    lignes: lib ? lib.querySelectorAll(".sd-lib-row").length : 0,
    etat: api && api.library && api.library.describe ? api.library.describe() : "?",
    accueilMaison: state(".sd-home"),
    ongletsVisibles: [...document.querySelectorAll(".sd-nav-item")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }).length,
    barreTitre: state(".sd-topbar"),
    barreSpotify: state("#global-nav-bar"),
    barreLaterale: state("#Desktop_LeftSidebar_Id"),
    /* Le lecteur, tel qu'il est à cet instant : c'est lui qui « disparaît ». */
    lecteur: state(".sd-mini"),
    lecteurOn: document.documentElement.classList.contains("sd-mini-on") ? "oui" : "non",
    /* **Qui est au-dessus du lecteur, à son centre ?** Un lecteur « disparu »
       peut simplement être recouvert : ce relevé le dit sans ambiguïté. */
    dessus: (function () {
      const mini = document.querySelector(".sd-mini");
      if (!mini) return "absent";
      const r = mini.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return "hors écran";
      try {
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el) return "rien";
        if (mini.contains(el)) return "le lecteur";
        const who = el.closest && el.closest(".sd-layer > *");
        return (who ? who.className.split(" ")[0] : el.tagName.toLowerCase()) + "";
      } catch (e) {
        return "non mesurable";
      }
    })(),
    /* Ce que la page dit — la raison, en clair (une capture doit suffire). */
    dire: ((document.querySelector(".sd-lib-note") || {}).textContent || "").trim().slice(0, 110),
    /* **Combien de lignes de Spotify sont dans la page** (barre latérale,
       panneau, rangées de l'accueil) : c'est la source de repli de la
       bibliothèque. Si ce compte est à 0 chez quelqu'un qui est connecté, la
       coque n'a rien à lire — et on le voit ici, sans capture. */
    lignesSpotify: document.querySelectorAll(
      "#Desktop_LeftSidebar_Id a[href^='/playlist/'], #Desktop_PanelContainer_Id a[href^='/playlist/'], #main-view a[href^='/playlist/']"
    ).length,
    /* Le détail par zone, pour savoir d'où vient (ou ne vient pas) la liste. */
    zones: (function () {
      const c = (sel) => document.querySelectorAll(sel).length;
      const lib = window.SpotiDuckUI && window.SpotiDuckUI.library;
      return (
        `barre ${c("#Desktop_LeftSidebar_Id a[href^='/playlist/']")}` +
        ` · panneau ${c("#Desktop_PanelContainer_Id a[href^='/playlist/']")}` +
        ` · page ${c("#main-view a[href^='/playlist/']")}` +
        ` · rangées-à-vous ${c("[data-sd-mine]")}` +
        ` · bibliothèque ${lib && typeof lib.scopes === "number" ? lib.scopes : "?"} conteneur(s)` +
        ` · lues ${lib ? (lib.scan || []).join("+") || 0 : "?"}`
      );
    })(),
    /* **Ce que la bibliothèque contient, par provenance.** La demande du 25/09 :
       « qu'il n'y ait que mes playlists et le truc avec mes titres likés ». Le
       relevé dit combien de lignes sont au compte, combien sont suivies, et
       combien de playlists recommandées ont été écartées. */
    contenu: (function () {
      const lib = window.SpotiDuckUI && window.SpotiDuckUI.library;
      if (!lib || !lib.items) return "?";
      const items = lib.items;
      const mine = items.filter((r) => r.sub === "Votre playlist").length;
      const suivies = items.filter((r) => /^Suivie · /.test(r.sub || "")).length;
      const likés = items.filter((r) => r.type === "liked").length;
      return `total ${items.length} · à-vous ${mine} · suivies ${suivies} · likés ${likés} · écartées ${lib.ignored || 0}`;
    })(),
    /* Les en-têtes que la coque a gardés de la page : sans `client-token`,
       Spotify refuse les appels d'API alors que le jeton est bon. */
    enTetes:
      window.SpotiDuckUI && window.SpotiDuckUI.net && window.SpotiDuckUI.net.requestHeaders
        ? Object.keys(window.SpotiDuckUI.net.requestHeaders(false)).join(",")
        : "?",
    journal: [].map
      .call(document.querySelectorAll(".sd-lib-log-list li"), (li) => (li.textContent || "").trim())
      .slice(0, 2)
      .join(" ; ")
      .slice(0, 110),
    textePage: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
    classes: document.documentElement.className,
  };
};

/* **Le lecteur au défilement.** Signalé le 25/09 : « le lecteur disparaît quand
   on scroll vers le bas ». On descend la page (le lecteur de Spotify quitte
   alors l'arbre par moments), on regarde le mini-lecteur, puis on revient en
   haut. */
const SCROLLPROBE = async () => {
  const size = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "absent";
    const r = el.getBoundingClientRect();
    const c = window.getComputedStyle(el);
    const gone = el.hidden === true || c.display === "none" || r.width < 2 || r.height < 2;
    return (gone ? "caché" : "visible") + " " + Math.round(r.width) + "x" + Math.round(r.height);
  };
  const coque = document.querySelector(".sd-layer") ? "coque posée" : "coque absente";
  const onTop = () => {
    const mini = document.querySelector(".sd-mini");
    if (!mini) return "absent";
    const r = mini.getBoundingClientRect();
    if (r.width < 2) return "hors écran";
    try {
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!el) return "rien";
      if (mini.contains(el)) return "le lecteur";
      const who = el.closest && el.closest(".sd-layer > *");
      return who ? who.className.split(" ")[0] : el.tagName.toLowerCase();
    } catch (e) {
      return "non mesurable";
    }
  };
  const before = size(".sd-mini");
  const beforeTop = onTop();
  const node = document.querySelector(".main-view-container__scroll-node, #main-view");
  const start = node ? node.scrollTop : window.scrollY;
  if (node) node.scrollTop = start + 900;
  window.scrollTo(0, window.scrollY + 900);
  await new Promise((r) => setTimeout(r, 700));
  const after = size(".sd-mini");
  /* Deuxième lecture, plus tard : le lecteur pouvait disparaître **après** le
     premier relevé (rendu différé de Spotify). */
  await new Promise((r) => setTimeout(r, 900));
  const after2 = size(".sd-mini");
  const afterTop = onTop();
  if (node) node.scrollTop = start;
  window.scrollTo(0, window.scrollY - 900);
  await new Promise((r) => setTimeout(r, 400));
  /* Deuxième manière de faire défiler : le **document** entier. Selon la page,
     c'est l'un ou l'autre qui bouge — et c'est justement là que le lecteur
     disparaissait. */
  window.scrollTo(0, 900);
  await new Promise((r) => setTimeout(r, 700));
  const docScroll = size(".sd-mini");
  window.scrollTo(0, 0);
  return {
    coque: coque,
    document: docScroll,
    before: before,
    beforeTop: beforeTop,
    afterTop: afterTop,
    after: after,
    after2: after2,
    lecteurPlein: document.documentElement.classList.contains("sd-player-open") ? "ouvert" : "fermé",
    transform: (document.querySelector(".sd-mini") || {}).style
      ? document.querySelector(".sd-mini").style.transform || "aucun"
      : "?",
    classe: document.documentElement.classList.contains("sd-mini-on") ? "sd-mini-on" : "sans sd-mini-on",
    bas: window.getComputedStyle(document.documentElement).getPropertyValue("--sd-mini-h-current").trim(),
  };
};

/* **Une playlist ouverte : ce qui recouvre l'écran.** Signalé le 25/09 :
   « quand on clique sur les playlists, y'a un écran noir » — et, dans le même
   message, « le lecteur qui disparaît ». On ouvre donc une playlist comme un
   doigt le ferait (la première ligne de la bibliothèque, sinon un lien de la
   page, sinon l'adresse d'une playlist connue) et on relève : le chemin, ce que
   le contenu mesure, **ce qui se trouve au-dessus** au centre et sous le
   lecteur, quels écrans à nous sont visibles, et l'état du lecteur. Une seule
   annotation doit suffire à savoir si l'écran est noir à cause de nous. */
const CHECKPLAYLIST = (sel) => {
  const found = Array.from(document.querySelectorAll(sel));
  return found.length;
};

const CLICKPLAYLIST = (sel) => {
  const found = Array.from(document.querySelectorAll(sel));
  const before = location.pathname;
  if (found.length) {
    found[0].click();
    return { via: "appui sur " + found[0].tagName.toLowerCase() + "." + String(found[0].className || "").split(" ")[0], before, apres: location.pathname };
  }
  return { via: "aucun lien", before, apres: before };
};

/* Où en est-on après un retour ? La bibliothèque doit être revenue, avec son
   onglet, et le lecteur toujours visible. */
const RETOUR_PROBE = () => {
  const visible = (el) => {
    if (!el || el.hidden === true) return false;
    const r = el.getBoundingClientRect();
    const c = window.getComputedStyle(el);
    return r.width > 2 && r.height > 2 && c.display !== "none" && c.visibility !== "hidden";
  };
  const lib = document.querySelector(".sd-layer .sd-lib");
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.width) + "x" + Math.round(r.height);
  };
  const onglet = document.querySelector(".sd-nav-item.is-active");
  const mini = document.querySelector(".sd-layer .sd-mini");
  return {
    chemin: location.pathname,
    onglet: onglet ? onglet.getAttribute("data-tab") || "" : "",
    bibliotheque: lib ? (visible(lib) ? "visible " + box(lib) : "masquée") + " lignes=" + lib.querySelectorAll(".sd-lib-row").length : "absente",
    lecteur: mini ? (visible(mini) ? "visible " + box(mini) : "caché") : "absent",
  };
};

const SUBPAGE_PROBE = () => {
  const visible = (el) => {
    if (!el) return false;
    if (el.hidden === true) return false;
    const r = el.getBoundingClientRect();
    const c = window.getComputedStyle(el);
    return r.width > 2 && r.height > 2 && c.display !== "none" && c.visibility !== "hidden" && Number(c.opacity || 1) > 0.05;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.width) + "x" + Math.round(r.height);
  };
  const content = document.querySelector('[data-testid="home-page"], #main-view, main[data-testid], .Root__main-view, main');
  const at = (fy) => {
    try {
      const el = document.elementFromPoint(Math.round(window.innerWidth * 0.5), Math.round(window.innerHeight * fy));
      if (!el) return "rien";
      const mine = el.closest && el.closest(".sd-layer");
      const cls = String(el.className || "").split(" ").filter(Boolean)[0] || "";
      return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (mine ? "[nous]" : "");
    } catch (e) {
      return "non mesurable";
    }
  };
  const calques = [".sd-home", ".sd-lib", ".sd-welcome", ".sd-content-alert", ".sd-sheet", ".sd-scrim", ".sd-player"]
    .map((sel) => {
      const el = document.querySelector(".sd-layer " + sel);
      return sel.replace(".sd-", "") + "=" + (visible(el) ? box(el) : "caché");
    })
    .join(" ");
  const mini = document.querySelector(".sd-mini");
  const lecteur = mini
    ? (visible(mini) ? "visible " + box(mini) : "caché") +
      " · dessus=" + at(0.93) +
      " · transform=" + (mini.style.transform || "aucun")
    : "absent";
  const text = content ? (content.textContent || "").trim().length : 0;
  const els = content ? content.querySelectorAll("*").length : 0;
  return {
    chemin: location.pathname,
    contenu: content ? box(content) + " " + els + " éléments " + text + " car." : "aucun élément de contenu",
    vide: !content || (text < 20 && els === 0),
    dessus: "centre=" + at(0.45) + " bas=" + at(0.75),
    calques: calques,
    lecteur: lecteur,
    classes: document.documentElement.className,
    /* Les dialogues de Spotify : combien sont **visibles**. Un dialogue fermé
       resté dans l'arbre ne doit plus éteindre nos barres (ni le lecteur). */
    dialogues: (() => {
      const all = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid="modal"]');
      let seen = 0;
      all.forEach((el) => {
        if (el.closest(".sd-layer")) return;
        if (el.hidden === true || el.getAttribute("aria-hidden") === "true") return;
        const r = el.getClientRects ? el.getClientRects() : null;
        if (r && r.length) seen++;
      });
      return `${seen} visibles/${all.length}`;
    })(),
    barreLaterale: (() => {
      const el = document.querySelector("#Desktop_LeftSidebar_Id");
      if (!el) return "absente";
      const c = window.getComputedStyle(el);
      return (visible(el) ? "visibile " + box(el) : "cachée") + " display=" + c.display;
    })(),
  };
};

/* **La bibliothèque, mesurée pendant qu'elle défile.** Signalé le 25/09 :
   « rends l'onglet bibliothèque plus propre » — les filtres étaient coupés en
   deux et l'en-tête écrasé, parce que le conteneur qui défile rétrécit ses
   enfants. En jsdom, aucune mise en page n'existe : c'est ici, dans Chrome,
   qu'on peut le voir. */
const LIBPROBE = async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const lib = document.querySelector(".sd-lib");
  if (!lib) return { etat: "absente" };
  if (lib.hidden) return { etat: "cachée" };
  const head = lib.querySelector(".sd-lib-head");
  const chips = lib.querySelector(".sd-lib-chips");
  if (!head || !chips) return { etat: "sans en-tête" };
  const enveloppe = lib.getBoundingClientRect();
  const avant = {
    headTop: Math.round(head.getBoundingClientRect().top),
    headH: Math.round(head.getBoundingClientRect().height),
    chipsH: Math.round(chips.getBoundingClientRect().height),
  };
  lib.scrollTop = Math.max(0, Math.min(240, lib.scrollHeight - lib.clientHeight));
  await pause(420);
  const apres = {
    headTop: Math.round(head.getBoundingClientRect().top),
    headH: Math.round(head.getBoundingClientRect().height),
    chipsTop: Math.round(chips.getBoundingClientRect().top),
    chipsH: Math.round(chips.getBoundingClientRect().height),
    scrollTop: Math.round(lib.scrollTop),
  };
  /* **Qu'y a-t-il juste sous le bord haut ?** Si une ligne y apparaît, c'est
     qu'une bande de la page passe au-dessus de l'en-tête au défilement. */
  let sousLeBord = "rien";
  try {
    const el = document.elementFromPoint(Math.round(enveloppe.left + enveloppe.width / 2), Math.round(enveloppe.top) + 3);
    if (el) {
      const cls = String(el.className || "").split(" ").filter(Boolean);
      sousLeBord = el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
    }
  } catch (e) {
    sousLeBord = "non mesurable";
  }
  /* **Une puce rognée** : sa hauteur réelle est plus petite que ce qu'elle
     demande. C'est exactement « les filtres sont coupés en deux ». */
  const chip = lib.querySelector(".sd-lib-chip");
  const puceRognee = chip ? Math.round(chip.getBoundingClientRect().height) + 1 < Math.round(chip.scrollHeight) : false;
  const badge = lib.querySelector(".sd-lib-count");
  const journal = lib.querySelector(".sd-lib-log");
  /* **Et la règle elle-même**, quand il n'y a rien à faire défiler (le banc
     n'a que deux lignes) : la position collante et le point d'accroche des
     filtres se lisent dans le style calculé, exactement. */
  const style = {
    head: getComputedStyle(head).position,
    chips: getComputedStyle(chips).position,
    accroche: getComputedStyle(chips).top,
  };
  lib.scrollTop = 0;
  return {
    collant: style.head + "/" + style.chips,
    accroche: style.accroche + " pour un en-tête de " + apres.headH + "px",
    colle: Math.abs(apres.headTop - avant.headTop) < 2 && Math.abs(apres.headTop - Math.round(enveloppe.top)) < 3 ? "oui" : "non",
    entete: apres.headH + "px (avant " + avant.headH + "px)",
    filtres: apres.chipsH + "px (avant " + avant.chipsH + "px)",
    sousLeBord,
    puceRognee: puceRognee ? "oui" : "non",
    lignes: lib.querySelectorAll(".sd-lib-row").length,
    compte: badge && !badge.hidden ? (badge.textContent || "").trim() : "(absent)",
    journal: journal ? (journal.open ? "ouvert" : "replié") + (journal.hidden ? " (caché)" : "") : "absent",
    defile: apres.scrollTop > 0 ? "oui" : "non",
  };
};

/* **Le lecteur : est-ce que nos appuis atteignent vraiment Spotify ?** Nos six
   commandes (lecture, suivant, précédent, aléatoire, répétition, j'aime)
   cliquent les boutons de la page. Si un sélecteur ne trouve rien sur la
   disposition réelle, la commande ne fait **rien** — « impossible de zapper la
   musique ». On relève donc, pour chacune, le bouton trouvé (sélecteur, état
   `disabled`), et on éprouve la chaîne complète là où c'est mesurable sans
   lecture : un appui sur notre « aléatoire » ou notre « j'aime » doit changer
   l'état du bouton de Spotify (`aria-checked`). */
const TRANSPORT_PROBE = () => {
  /* **Mêmes familles de repères que la coque** (`SEL`, src/inject/spotiduck-ui.js)
     — identifiants de test *et* libellés. Une famille qui ne trouve rien sur la
     disposition réelle, c'est une commande qui ne fait rien. */
  const FAMILLES = {
    playPause: [
      'aside button[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-play"]',
      'button[data-testid="control-button-pause"]',
      'button[aria-label="Lecture"]',
      'button[aria-label="Pause"]',
      'button[aria-label="Play"]',
    ],
    next: [
      'aside button[data-testid="control-button-skip-forward"]',
      'button[data-testid="control-button-skip-forward"]',
      'button[data-testid="control-button-next"]',
      'button[aria-label="Suivant"]',
      'button[aria-label="Next"]',
      'button[aria-label="Next track"]',
    ],
    prev: [
      'aside button[data-testid="control-button-skip-back"]',
      'button[data-testid="control-button-skip-back"]',
      'button[data-testid="control-button-previous"]',
      'button[aria-label="Précédent"]',
      'button[aria-label="Previous"]',
      'button[aria-label="Previous track"]',
    ],
    shuffle: [
      'aside button[data-testid="control-button-shuffle"]',
      'button[data-testid="control-button-shuffle"]',
      'button[aria-label^="Activer la lecture aléatoire"]',
      'button[aria-label^="Shuffle"]',
    ],
    repeat: [
      'aside button[data-testid="control-button-repeat"]',
      'button[data-testid="control-button-repeat"]',
      'button[aria-label^="Activer la répétition"]',
      'button[aria-label^="Repeat"]',
    ],
    like: [
      'aside button[data-testid="add-button"]',
      'button[data-testid="add-button"]',
      'button[data-testid="now-playing-widget-like-button"]',
      'button[aria-label^="Ajouter aux Titres likés"]',
      'button[aria-label^="Save to your Liked"]',
    ],
  };

  /* **Toutes les copies**, pas seulement la première : le lecteur garde parfois
     deux barres dans la page (bureau + téléphone), et l'appui partait sur celle
     qui est désactivée. C'est la mesure qui dit si la disposition du téléphone a
     un doublon — et lequel est utilisable. */
  const candidats = (nom) => {
    const vus = [];
    const out = [];
    (FAMILLES[nom] || []).forEach((sel) => {
      let list = [];
      try {
        list = document.querySelectorAll(sel);
      } catch (e) {
        list = [];
      }
      list.forEach((el) => {
        if (vus.indexOf(el) >= 0) return;
        vus.push(el);
        const r = el.getBoundingClientRect();
        out.push({
          sel,
          nous: !!(el.closest && el.closest(".sd-layer")),
          taille: Math.round(r.width) + "x" + Math.round(r.height),
          disabled: el.disabled === true,
        });
      });
    });
    return out;
  };
  /* Ce que la coque choisirait : un candidat **utilisable**, de préférence avec
     une boîte à l'écran. Le relevé doit dire si ce choix existe. */
  const choisirait = (liste) => {
    const vivants = liste.filter((c) => !c.disabled);
    const avecBoite = vivants.filter((c) => c.taille !== "0x0");
    if (avecBoite.length) return avecBoite[0];
    if (vivants.length) return vivants[0];
    return liste[0] || null;
  };
  const out = {};
  Object.keys(FAMILLES).forEach((nom) => {
    const tous = candidats(nom).filter((c) => !c.nous);
    if (!tous.length) {
      out[nom] = "AUCUN";
      return;
    }
    const choix = choisirait(tous);
    const detail = tous
      .map((c) => (c.sel.indexOf("aside") === 0 ? "bureau " : "page ") + c.taille + (c.disabled ? " DÉSACTIVÉ" : ""))
      .join(" + ");
    out[nom] =
      tous.length + " candidat(s)" +
      (tous.length > 1 ? " [" + detail + "]" : "") +
      " → choisi " + choix.taille + (choix.disabled ? " DÉSACTIVÉ" : " actif");
  });
  const etat = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute("aria-checked") : "?";
  };
  const titre = document.querySelector('[data-testid="context-item-link"], [data-testid="now-playing-widget"] a');
  const utilisable = Object.keys(FAMILLES).some((nom) => {
    const tous = candidats(nom).filter((c) => !c.nous);
    return tous.some((c) => !c.disabled);
  });
  return {
    cibles: out,
    /* De quoi lire le relevé sans se tromper : une page où **rien ne joue**
       laisse ses commandes désactivées, ce n'est pas une panne de la coque. */
    page: {
      shuffle: etat('button[data-testid="control-button-shuffle"]'),
      repeat: etat('button[data-testid="control-button-repeat"]'),
      like: etat('button[data-testid="add-button"]'),
      titre: titre ? (titre.textContent || "").trim().slice(0, 40) : "(aucun)",
      utilisable: utilisable ? "oui" : "non",
    },
    /* **Nos boutons, et ce qui se trouve réellement à leur place.** Un bouton
       couvert par autre chose ne reçoit aucun appui : c'est « le bouton ne fait
       rien », alors qu'il est bien là et bien branché. On demande donc à la page
       quel élément se trouve au centre de chacun. */
    nous: (() => {
      const sels = [
        ".sd-mini-play",
        ".sd-mini-next",
        ".sd-mini-prev",
        ".sd-mini-shuffle",
        ".sd-mini-repeat",
        ".sd-mini-like",
        ".sd-mini-lyrics",
        ".sd-mini-queue",
      ];
      const out = {};
      /* **Pourquoi « absent » n'est pas une panne** : sans piste, la barre prend
         sa variante vide (ou « session fermée ») — les commandes de transport
         existent quand même, mais un lecteur de poche sans session n'a rien à
         zapper. On le dit avant la liste, pour que le relevé ne fasse pas
         croire à un lecteur amputé. */
      const mini = document.querySelector(".sd-mini");
      out["mini"] = mini
        ? (String(document.documentElement.className).match(/sd-mini-[a-z-]+/g) || []).join(",") +
          " · " + mini.querySelectorAll(".sd-iconbtn").length + " commandes"
        : "absente";
      sels.forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = "absent";
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) {
          out[sel] = "sans taille";
          return;
        }
        let dessus = "hors écran";
        try {
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          if (hit) {
            if (hit === el || (el.contains && el.contains(hit))) dessus = "lui-même";
            else {
              const cls = String(hit.className || "").split(" ")[0];
              dessus = hit.tagName.toLowerCase() + (cls ? "." + cls : "");
            }
          }
        } catch (e) {
          dessus = "non mesurable";
        }
        out[sel] = Math.round(r.width) + "x" + Math.round(r.height) + " dessus=" + dessus;
      });
      return out;
    })(),
  };
};

/* L'appui **par nos boutons**, puis ce qu'est devenu le bouton de Spotify. */
const TRANSPORT_CANARY = async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  };
  const etat = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute("aria-checked") : "?";
  };
  const avant = { shuffle: etat('button[data-testid="control-button-shuffle"]'), like: etat('button[data-testid="add-button"]') };
  const appuyeShuffle = click(".sd-mini-shuffle");
  await pause(700);
  const apresShuffle = etat('button[data-testid="control-button-shuffle"]');
  const appuyeLike = click(".sd-mini-like");
  await pause(700);
  const apresLike = etat('button[data-testid="add-button"]');
  /* On remet comme avant (l'essai ne doit pas laisser d'état modifié). */
  if (appuyeShuffle && apresShuffle !== avant.shuffle) click(".sd-mini-shuffle");
  if (appuyeLike && apresLike !== avant.like) click(".sd-mini-like");
  await pause(300);
  return { avant, apresShuffle, apresLike, appuyeShuffle, appuyeLike };
};

/* **Le zap, mesuré pour de vrai — en navigateur, avec mise en page.** Sur le
   banc, la page joue : on appuie sur notre « suivant » et on regarde le titre du
   lecteur changer. C'est la seule mesure en Chrome de la chaîne complète
   (repère → appui → lecteur), là où jsdom ne peut pas dire si un bouton est
   recouvert, désactivé ou doublé. */
const TRANSPORT_ZAP = async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const titre = () => {
    const el = document.querySelector('[data-testid="context-item-link"], [data-testid="now-playing-widget"] a');
    return el ? (el.textContent || "").trim() : "";
  };
  /* **Faire jouer la page** (banc) : notre « lecture » sur le faux lecteur. Un
     échec n'est pas une faute — sur la vraie page il n'y a rien à lancer. */
  const play = document.querySelector(".sd-mini-play");
  if (play) play.click();
  await pause(900);
  const avant = titre();
  const bouton = document.querySelector(".sd-mini-next");
  if (!bouton) return { avant, erreur: "notre bouton « suivant » est absent" };
  if (!avant) return { avant, erreur: "rien ne joue : le zap n'est pas mesurable" };
  bouton.click();
  await pause(1100);
  const apres = titre();
  return { avant, apres, change: avant !== apres };
};

const CLICK = async (selector) => {
  const el = document.querySelector(selector);
  if (!el) return { clicked: false, reason: `${selector} absent` };
  const before = location.pathname;
  const disabled = el.disabled === true;
  el.click();
  /* 1 500 ms : la coque reprend la navigation elle-même au bout d'une seconde
     si le routeur de Spotify n'a pas bougé (voir son propre garde-fou). */
  await new Promise((r) => setTimeout(r, 1500));
  return {
    clicked: true,
    selector,
    label: (el.textContent || "").trim().slice(0, 24),
    disabled,
    pathBefore: before,
    pathAfter: location.pathname,
    tapRecorded: (window.__sdNavTap && (window.__sdNavTap.route || window.__sdNavTap.forced)) || null,
    changed: before !== location.pathname,
  };
};

async function main() {
  let puppeteer = null;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    warn("Chrome", "puppeteer-core absent — npm install --no-save puppeteer-core@23");
    return;
  }

  const { readFileSync } = await import("node:fs");
  const identity = readFileSync("src/original/spotiduck-identity.js", "utf8");
  const bundle = readFileSync("dist/spotiduck-ui.js", "utf8");
  /* Le mode d'origine : son empreinte (géométrie 1920×1080 comprise) et son
     script, tels que l'application les injecte. */
  const fingerprint = readFileSync("dist/original-fingerprint.js", "utf8");
  const original = readFileSync("dist/spotiduck-original.js", "utf8");
  console.log(`[Sonde coque] fichiers : identité ${(identity.length / 1024).toFixed(1)} Ko · coque ${(bundle.length / 1024).toFixed(1)} Ko`);

  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  let browser = null;
  const launchErrors = [];
  for (const executablePath of candidates) {
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--lang=fr-FR", "--window-size=412,915"],
      });
      console.log(`[Sonde coque] pilote Chrome : ${executablePath}`);
      break;
    } catch (error) {
      launchErrors.push(`${executablePath} : ${String((error && error.message) || error).slice(0, 160)}`);
    }
  }
  if (!browser) {
    warn("Chrome", `aucun navigateur pilotable — ${launchErrors.join(" · ")}`);
    return;
  }

  const pages = [
    { label: "accueil", url: "https://open.spotify.com/" },
    /* **Le chemin du téléphone.** La capture du 25/09 portait, dans le
       diagnostic de l'application, `page /intl-fr/` : c'est là que Spotify
       atterrit en France, et c'est cette page-là qu'il fallait mesurer — pas
       seulement la racine. On l'ajoute ici, dans les conditions de la WebView
       (`telephone`), parce que c'est la seule mesure qui voit ce que
       l'utilisateur voit quand il dit « la page n'a rien affiché ». */
    { label: "page-fr", url: "https://open.spotify.com/intl-fr/", mobile: true },
    { label: "connexion", url: "https://accounts.spotify.com/fr/login?allow_password=1" },
    /* L'interface d'origine : même page, mais l'empreinte de géométrie d'abord
       (écran 1920×1080) et son script ensuite — c'est la configuration que
       l'application d'origine utilise, et c'est celle que l'utilisateur
       connaît. */
    { label: "origine", url: "https://open.spotify.com/", mode: "original" },
    /* Notre interface, sur le banc de démonstration : le faux web player
       (`demo/player.html`) est le DOM pour lequel la coque est écrite — c'est
       l'affichage de référence, celui des captures du projet. Le serveur est
       lancé par le workflow. */
    /* **Le chemin compte** : `/player.html` (racine) n'existe pas — le banc est
       dans `demo/`. La première version de cette sonde mesurait donc une page
       *404* : tout y était « masqué », et la conclusion qu'on en avait tirée
       (« la coque n'habille pas la vraie page ») portait sur une page d'erreur.
       Mesurer le banc, c'est mesurer `/demo/player.html`. */
    { label: "notre", url: "http://127.0.0.1:5173/demo/player.html", mode: "notre" },
    /* **La page du téléphone.** Même page, mais dans les conditions réelles de
       la WebView : `useWideViewPort` (donc mise en page à 980 px tant qu'aucun
       `<meta name="viewport">` n'est posé), densité d'un vrai écran, écran
       tactile, et la chaîne d'injection de l'application (`onPageStarted` :
       identité + meta en attente de `document.head` ; `onPageFinished` : meta
       puis coque). C'est la seule mesure qui voit ce que l'utilisateur voit
       quand il dit « l'affichage n'est plus adapté à Android ». */
    { label: "telephone", url: "https://open.spotify.com/", mode: "telephone" },
    /* **Notre interface, dans les conditions de la WebView.** Le banc était
       toujours mesuré en mode bureau (Chrome desktop à 412 px, `isMobile:false`)
       — un environnement où la page se met en page sur la largeur qu'on lui
       donne. Ici : mêmes règles de mise en page que la WebView, même chaîne
       d'injection, pour voir (capture) et chiffrer ce que la coque rend sur un
       téléphone. */
    { label: "banc-tel", url: "http://127.0.0.1:5173/demo/player.html", mode: "notre", mobile: true },
    /* **La configuration de l'application, mesurée comme telle** : la vraie page
       de Spotify, l'agent Android que la WebView annonce, le meta viewport que
       l'application pose, et notre coque. C'est le seul contexte qui répond à
       « ce que le téléphone affiche » sans avoir besoin de la session de
       l'utilisateur : la mise en page, elle, se juge sans être connecté. */
    {
      label: "coque-mobile",
      url: "https://open.spotify.com/intl-fr/",
      mode: "notre",
      mobile: true,
    },
  ];

  /* **Mesurer une cible à la fois.** La sonde complète prend plusieurs minutes
     et interroge la vraie page ; pour vérifier un changement, on veut pouvoir
     la poser sur le banc seul : `PROBE_LABELS=banc-tel`. */
  const seules = (process.env.PROBE_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cibles = seules.length ? pages.filter((p) => seules.indexOf(p.label) >= 0) : pages;

  const lines = [];
  const shots = [];

  /* Toute mesure est tolérante : un appui peut **naviguer** (c'est même ce
     qu'on espère), et une page qui navigue détruit le contexte d'exécution.
     Sans ce garde-fou, la moindre navigation faisait tomber toute la sonde —
     ce qui est arrivé, et masquait justement le résultat intéressant. */
  const safely = async (fn, ...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const message = String((error && error.message) || error);
      return { erreur: message.slice(0, 140), navigation: /context was destroyed|Execution context/i.test(message) };
    }
  };

  for (const target of cibles) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error && error.message).slice(0, 240)));
    page.on("console", (message) => {
      if (message.type() === "error" && !/Google Analytics|sandboxed/i.test(message.text())) {
        errors.push(message.text().slice(0, 240));
      }
    });

    try {
      if (target.mode === "notre" && /127\.0\.0\.1/.test(target.url)) {
        /* Le banc monte lui-même le faux lecteur puis la coque : on ne pose ni
           identité ni meta viewport. */
      } else if (target.mode === "original") {
        /* L'empreinte d'abord : elle fait croire à un écran 1920×1080, ce que
           l'application d'origine obtient par `setUseWideViewPort(true)` +
           `setInitialScale(100)`. */
        await page.evaluateOnNewDocument(fingerprint);
        await page.evaluateOnNewDocument(() => {
          const put = () => {
            const root = document.head || document.documentElement;
            if (!root) return;
            let meta = document.querySelector("meta[name='viewport']");
            if (!meta) {
              meta = document.createElement("meta");
              meta.setAttribute("name", "viewport");
              root.appendChild(meta);
            }
            meta.setAttribute("content", "width=1920, user-scalable=yes");
          };
          put();
          document.addEventListener("DOMContentLoaded", put);
          setTimeout(put, 1200);
        });
      }
      if (target.mode === "original") await page.evaluateOnNewDocument(identity);
      if (target.mobile === true || target.mode === "telephone") {
        /* Exactement ce que fait `MainActivity` : la WebView est en
           `useWideViewPort`, aucun `<meta viewport>` n'existe au départ, et le
           script de l'application le pose dès que `document.head` apparaît —
           en réessayant dix fois, parce qu'au premier passage il n'y a pas
           encore de `<head>`. */
        await page.evaluateOnNewDocument(() => {
          window.__sdViewportMeta = true;
          var CONTENT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
          function ensure() {
            var root = document.head || document.documentElement;
            if (!root) return false;
            var metas = document.querySelectorAll("meta[name='viewport']");
            var meta = metas[0];
            if (!meta) {
              meta = document.createElement("meta");
              meta.setAttribute("name", "viewport");
              (document.head || document.documentElement).appendChild(meta);
            }
            for (var i = 1; i < metas.length; i++) {
              if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
            }
            if (meta.getAttribute("content") !== CONTENT) meta.setAttribute("content", CONTENT);
            return true;
          }
          ensure();
          var n = 0;
          var t = window.setInterval(function () {
            ensure();
            if (++n > 10) window.clearInterval(t);
          }, 200);
        });
      }
      await page.evaluateOnNewDocument(() => {
        const CONTENT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
        const put = () => {
          const root = document.head || document.documentElement;
          if (!root) return;
          let meta = document.querySelector("meta[name='viewport']");
          if (!meta) {
            meta = document.createElement("meta");
            meta.setAttribute("name", "viewport");
            root.appendChild(meta);
          }
          meta.setAttribute("content", CONTENT);
        };
        put();
        document.addEventListener("DOMContentLoaded", put);
        setTimeout(put, 1200);
      });

      /* L'interface d'origine sert la page de bureau (agent de bureau + son
         empreinte de géométrie) ; la coque, elle, est mesurée dans les
         conditions de l'application : agent Android, meta `device-width`. */
      await page.setUserAgent(target.mode === "original" ? DESKTOP_UA : MOBILE_UA);
      /* `isMobile: true` = les règles de mise en page de Chrome mobile, donc la
         même que la WebView : sans meta, largeur de mise en page de 980 px et
         dézoom pour tenir à l'écran. Les autres pages restent en mode bureau
         pour rester comparables aux versions précédentes. */
      await page.setViewport({
        width: 412,
        height: 915,
        deviceScaleFactor: target.mobile === true || target.mode === "telephone" ? 2.625 : 2,
        isMobile: target.mobile === true || target.mode === "telephone",
        hasTouch: true,
      });

      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(6000);

      const before = await safely(() => page.evaluate(MEASURE));

      /* Le script du mode choisi, à la fin du chargement (`onPageFinished`). */
      await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
      await sleep(3500);

      const after = await safely(() => page.evaluate(MEASURE));
      await safely(() =>
        page.evaluate(() => {
          window.__sdProbeErrors = [];
          window.addEventListener("error", (e) => window.__sdProbeErrors.push(String(e.message).slice(0, 200)));
        })
      );

      /* Une miniature téléchargeable depuis les annotations (les artefacts ne
         sont pas joignables ici) : l'écran réduit, JPEG qualité 35. */
      const miniature = async (name) => {
        try {
          await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 0.28, isMobile: false, hasTouch: true });
          await sleep(400);
          const buffer = await page.screenshot({ type: "jpeg", quality: 18 });
          shots.push(`SHOT:${target.label}-${name}:${buffer.toString("base64")}`);
          await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: false, hasTouch: true });
          await sleep(200);
        } catch (error) {
          shots.push(`SHOT:${target.label}-${name}:echec ${String((error && error.message) || error).slice(0, 60)}`);
        }
      };

      /* Une seule capture, sur la page choisie : les places d'annotation sont
         comptées (GitHub en garde une poignée), et l'image coûte à elle seule
         plusieurs morceaux. */
      if (["telephone"].includes(target.label)) await miniature(target.label);

      /* Les trois vues de la barre du haut : état intérieur + ce que la page
         affiche, avant et après un appui réel. (L'interface d'origine a sa
         propre barre : `.sd-nav` n'existe pas chez elle.) */
      const navEffects = [];
      const hasNav = await safely(() => page.evaluate(() => !!document.querySelector(".sd-nav-item")));
      for (const name of hasNav === true ? ["library", "search", "home"] : []) {
        const stateBefore = await safely(() => page.evaluate(SHELL_STATE));
        /* Le résultat de l'appui **et** l'état d'après : « rien ne se passe »
           et « ça navigue » se ressemblent dans l'état intérieur (une
           navigation détruit le contexte, donc `stateTab` disparaît). Le chemin
           est le seul témoin fiable. */
        const click = await safely(() => page.evaluate(CLICK, `.sd-nav-item[data-tab="${name}"]`));
        await sleep(600);
        const stateAfter = await safely(() => page.evaluate(SHELL_STATE));
        navEffects.push({ name, before: stateBefore, after: stateAfter, click });
        /* Un appui qui navigue emmène la page ailleurs : sans revenir au point
           de départ, l'appui suivant se mesure sur une page en cours de
           chargement (« bouton absent ») et ne dit plus rien de lui-même. */
        if (click && click.navigation) {
          try {
            await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
            await sleep(2500);
            await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
            await sleep(2500);
          } catch (e) {
            /* page irrécupérable : les appuis suivants le diront */
          }
        }
        /* (pas de capture à chaque vue : chaque image coûte des morceaux
           d'annotation, et GitHub n'en garde qu'une poignée) */
      }

      /* **La page du téléphone, résumée.** C'est la page sur laquelle la
         capture « la page n'a rien affiché » a été prise : on veut son verdict
         en une ligne, sinon il faut lire le rapport complet pour savoir si le
         défaut est reproduit. */
      if (target.label === "page-fr") {
        const v = (after && after.verdict) || {};
        const a = v.anchor || {};
        note(
          "Page /intl-fr/ (conditions du téléphone)",
          `coque=${v.version} · état=${v.ok} (${v.state}) · chemin d'accueil=${v.homePath} · ` +
            `ancre=${a.tag} ${a.box} ${a.display} texte=${a.text} car. éléments=${a.elements} ` +
            `· session : lecteur=${v.session ? v.session.barreLecture : "?"} lien=${v.session ? v.session.lienConnexion : "?"} ` +
            `bouton=${v.session ? v.session.boutonConnexion : "?"} · "${String(a.sample || "").slice(0, 70)}"`
        );
      }

      /* **L'appui sur l'onglet Bibliothèque, mesuré.** Signalé le 25/09 :
         « quand on clique sur l'onglet bibliothèque, la barre en haut disparaît
         et rien d'autre n'apparaît ; je reste bloqué sur l'écran d'accueil ».
         Le relevé ci-dessus est pris **avant** tout appui (`State.tab` vaut
         « accueil ») : il ne pouvait donc pas voir ce bug. On ouvre l'onglet,
         on mesure, puis on revient à l'accueil. */
      if (hasNav === true) {
        await safely(() => page.evaluate(CLICK, '.sd-nav-item[data-tab="library"]'));
        await sleep(900);
        const m = await safely(() => page.evaluate(TABMEASURE));
        if (m) {
          /* Et, tout de suite après, **la page pendant qu'elle défile**. */
          const libMesure = await safely(() => page.evaluate(LIBPROBE));
          if (libMesure && libMesure.etat === undefined) {
            const ligne =
              `en-tête collé=${libMesure.colle} · entête=${libMesure.entete} · filtres=${libMesure.filtres}` +
              ` · collant=${libMesure.collant} · accroche=${libMesure.accroche}` +
              ` · sous-le-bord=${libMesure.sousLeBord} · puce rognée=${libMesure.puceRognee} · lignes=${libMesure.lignes}` +
              ` · compte=${libMesure.compte} · journal=${libMesure.journal} · défilement=${libMesure.defile}`;
            /* Une puce coupée, ou une ligne qui passe au-dessus de l'en-tête,
               c'est la capture du 25/09 : on le dit en alerte. */
            const accrocheOk = /^(\d+)px pour un en-tête de \1px$/.test(libMesure.accroche);
            const abime =
              libMesure.puceRognee === "oui" ||
              libMesure.colle === "non" ||
              libMesure.collant !== "sticky/sticky" ||
              !accrocheOk ||
              !/^div\.sd-lib-head/.test(libMesure.sousLeBord);
            if (abime) warn(`Bibliothèque au défilement — ${target.label}`, ligne);
            else note(`Bibliothèque au défilement — ${target.label}`, ligne);
            report.pages.push({ label: `${target.label} (bibliothèque au défilement)`, lib: libMesure });
          }
          note(
            `Onglet Bibliothèque — ${target.label}`,
            `chemin=${m.chemin} · onglet-actif=${m.ongletActif} · bibliothèque=${m.bibliotheque} ` +
              `lignes=${m.lignes} état=${m.etat} titre=${m.titre} · accueil-maison=${m.accueilMaison} ` +
              `onglets-visibles=${m.ongletsVisibles} barre-titre=${m.barreTitre} barre-laterale=${m.barreLaterale} ` +
              `texte=${m.textePage} car. · classes="${m.classes}"` +
              ` · barre-spotify=${m.barreSpotify} · lecteur=${m.lecteur} (${m.lecteurOn})` +
              ` · lignes-spotify=${m.lignesSpotify} (${m.zones}) · contenu=${m.contenu} · en-têtes=${m.enTetes} · dessus-du-lecteur=${m.dessus}` +
              (m.dire ? ` · dit="${m.dire}"` : "") +
              (m.journal ? ` · journal="${m.journal}"` : "")
          );
          report.pages.push({ label: `${target.label} (onglet bibliothèque)`, tab: m });
        } else {
          warn(`Onglet Bibliothèque — ${target.label}`, "aucune mesure n'est remontée après l'appui sur l'onglet");
        }
        /* On revient à l'accueil : l'appui suivant se mesure sur la page de
           départ, et les captures aussi. */
        await safely(() => page.evaluate(CLICK, '.sd-nav-item[data-tab="home"]'));
        await sleep(600);

        /* **La coque doit être là** : l'appui « Accueil » juste au-dessus peut
           avoir navigué (notre repli `location.assign`), ce qui l'emporte. Sans
           elle, nos boutons seraient « absents » pour tout — un faux défaut. On
           la repose comme l'application le fait à chaque chargement. */
        const coqueAvant = await safely(() =>
          page.evaluate(() => {
            const l = document.querySelector(".sd-layer");
            return l ? l.getAttribute("data-sd-version") || "sans version" : "";
          })
        );
        let coqueReposee = false;
        if (coqueAvant === "") {
          await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
          await sleep(2200);
          coqueReposee = true;
        }
        const coque = coqueReposee
          ? await safely(() =>
              page.evaluate(() => {
                const l = document.querySelector(".sd-layer");
                return l ? l.getAttribute("data-sd-version") || "sans version" : "absente";
              })
            )
          : coqueAvant;

        /* **La lecture : nos appuis atteignent-ils Spotify ?** */
        const transport = await safely(() => page.evaluate(TRANSPORT_PROBE));
        const canary = await safely(() => page.evaluate(TRANSPORT_CANARY));
        if (transport) {
          const manquants = Object.keys(transport.cibles).filter((k) => transport.cibles[k] === "AUCUN");
          const line =
            `coque=${coque}${coqueReposee ? " (reposée après un chargement)" : ""}` +
            ` · cibles : ${Object.keys(transport.cibles).map((k) => k + "=" + transport.cibles[k]).join(" · ")}` +
            ` · page : shuffle=${transport.page.shuffle} repeat=${transport.page.repeat} like=${transport.page.like} titre="${transport.page.titre}" utilisable=${transport.page.utilisable}` +
            ` · nos boutons : ${Object.keys(transport.nous).map((k) => k.replace(".sd-mini-", "") + "=" + transport.nous[k]).join(" · ")}` +
            (canary
              ? ` · nos appuis : aléatoire ${canary.avant.shuffle}→${canary.apresShuffle}${canary.appuyeShuffle ? "" : " (bouton absent)"}` +
                `, j'aime ${canary.avant.like}→${canary.apresLike}${canary.appuyeLike ? "" : " (bouton absent)"}`
              : " · nos appuis : non mesurés");
          /* Un bouton introuvable, ou un appui qui ne change rien côté Spotify,
             est exactement « impossible de zapper la musique ». */
          const muet = canary && ((canary.appuyeShuffle && canary.avant.shuffle === canary.apresShuffle) || (canary.appuyeLike && canary.avant.like === canary.apresLike));
          /* **Rien ne joue sur cette page** : les commandes sont désactivées par
             Spotify, ce n'est pas un défaut de la coque. On le dit au lieu de
             faire une alerte — une alarme à tort est un défaut. */
          const rienNeJoue = transport.page.utilisable === "non";
          if (manquants.length || muet) {
            if (rienNeJoue && !manquants.length) note(`Lecture — ${target.label} (rien ne joue)`, line);
            else warn(`Lecture — ${target.label}`, line);
          }
          else note(`Lecture — ${target.label}`, line);
          /* **Et l'appui pour de vrai** : sur le banc, la piste doit changer. */
          const zap = await safely(() => page.evaluate(TRANSPORT_ZAP));
          if (zap) {
            report.pages.push({ label: `${target.label} (zap)`, zap });
            if (zap.erreur) note(`Zap — ${target.label}`, `${zap.erreur} (titre=${JSON.stringify(zap.avant || "")})`);
            else if (zap.change) note(`Zap — ${target.label}`, `« ${zap.avant} » → « ${zap.apres} » — la piste change vraiment`);
            else warn(`Zap — ${target.label}`, `« ${zap.avant} » reste affiché après l'appui sur « suivant » : le zap ne fait rien`);
          }
          report.pages.push({ label: `${target.label} (lecture)`, transport, canary });
        } else {
          warn(`Lecture — ${target.label}`, "aucune mesure n'est remontée du lecteur");
        }
        /* **Le garde-fou de la coque**, mesuré sur ce contexte : Chrome réel,
           CSS réel, appuis réels (hit-test), pas une page factice. */
        {
          const garde = await safely(() => page.evaluate(GUARD));
          if (garde && garde.fautes) {
            report.pages.push({ label: `${target.label} (garde-fou)`, garde });
            if (garde.fautes.length) {
              for (const f of garde.fautes) fautes.push(`${target.label} : ${f}`);
              warn(`Garde-fou — ${target.label}`, garde.fautes.join(" || "));
            } else {
              note(
                `Garde-fou — ${target.label}`,
                `${garde.boutons} boutons (${garde.visibles} visibles) tous atteignables · ${garde.joue ? "la page joue, la coque le voit" : "rien ne joue"} · place réservée conforme · écran ${garde.largeur}px`
              );
            }
          }
        }
      }

      /* **Une playlist ouverte : écran noir ? lecteur disparu ?** Le parcours
         de l'utilisateur — bibliothèque, puis une playlist — mesuré de bout en
         bout. Un **appui** garde la coque (navigation interne à Spotify) ; à
         défaut de lien (page sans session), on suit une adresse de playlist
         comme le ferait l'application : là, la page est **rechargée** et la
         coque doit être reposée comme le fait `injectAtDocumentEnd`. */
      if (hasNav === true) {
        const before = await safely(() => page.evaluate(SUBPAGE_PROBE));
        const PLAY_SEL =
          ".sd-lib-row[href*='/playlist/'], .sd-lib-row[href*='/collection/'], " +
          "#main-view a[href^='/playlist/'], #Desktop_LeftSidebar_Id a[href^='/playlist/']";
        const links = await safely(() => page.evaluate(CHECKPLAYLIST, PLAY_SEL));
        let opened = null;
        let reinjectee = false;
        let retour = null;
        /* L'état **avant** l'appui : c'est lui qui dit si l'on venait de la
           bibliothèque. Sans cette comparaison, un retour mesuré depuis une
           page où la bibliothèque n'était pas ouverte paraissait fautif — et
           une alarme à tort est un défaut. */
        const avantRetour = await safely(() => page.evaluate(RETOUR_PROBE));
        /* **Un rechargement se voit.** On pose une marque sur le document avant
           l'appui : si elle a disparu après, l'application a été rechargée —
           c'est exactement l'écran noir signalé le 25/09 (« quand on appuie sur
           une playlist »), et la mesure doit le dire, pas le laisser deviner. */
        if (links && links > 0) {
          await safely(() =>
            page.evaluate(() => {
              window.__sdNavMark = "pose";
            })
          );
          opened = await safely(() => page.evaluate(CLICKPLAYLIST, PLAY_SEL));
          await sleep(3500);
          const marque = await safely(() => page.evaluate(() => window.__sdNavMark === "pose"));
          if (opened) opened.recharge = marque === true ? "non" : "oui";
        } else {
          opened = { via: "adresse de playlist (aucun lien sur la page)", before: before && before.chemin, apres: "/playlist/…" };
          try {
            await page.goto("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
            await sleep(2500);
          } catch (e) {
            /* page irrécupérable : la mesure le dira */
          }
        }
        /* Une navigation complète emporte la coque : on la repose, sinon la
           mesure porterait sur une page de Spotify **sans coque** et ne dirait
           rien de « l'écran noir ». */
        const sansCoque = await safely(() => page.evaluate(() => !document.querySelector(".sd-layer")));
        if (sansCoque === true) {
          await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
          await sleep(2500);
          reinjectee = true;
        }
        const at = await safely(() => page.evaluate(SUBPAGE_PROBE));
        await sleep(2000);
        const after = await safely(() => page.evaluate(SUBPAGE_PROBE));
        if (at) {
          const lecture = (m) =>
            m
              ? `chemin=${m.chemin} contenu=${m.contenu} dessus=${m.dessus} calques=${m.calques} ` +
                `lecteur=${m.lecteur} barre-laterale=${m.barreLaterale} dialogues=${m.dialogues} classes="${m.classes}"`
              : "?";
          const line =
            `ouvert par ${opened ? opened.via : "?"} (${opened ? opened.before : "?"} → ${opened ? opened.apres : "?"})` +
            (opened && opened.recharge ? ` · application rechargée=${opened.recharge}` : "") +
            (reinjectee ? " · coque réinjectée après un chargement complet" : "") +
            ` · ${lecture(at)}` +
            ` · +2 s : chemin=${after ? after.chemin : "?"} contenu=${after ? after.contenu : "?"} ` +
            `dessus=${after ? after.dessus : "?"} lecteur=${after ? after.lecteur : "?"} calques=${after ? after.calques : "?"} ` +
            `classes="${after ? after.classes : "?"}"`;
          /* Un écran noir se reconnaît à trois signes : le contenu est vide, un
             de **nos** calques est posé dessus, ou le lecteur a disparu (il
             était visible avant l'appui). */
          const noir =
            at.vide === true ||
            /centre=[^ ]*\[nous\]/.test(at.dessus) ||
            (at.chemin.indexOf("/playlist") !== 0 && at.chemin.indexOf("/album") !== 0) ||
            (before && before.lecteur.indexOf("visible") === 0 && at.lecteur.indexOf("visible") !== 0);
          /* **Un appui qui recharge l'application est le défaut lui-même** :
             plusieurs secondes sans rien à peindre (l'écran noir), la coque
             reconstruite, et un retour qui n'a plus l'ouverture à défaire. */
          if (opened && opened.recharge === "oui") warn(`Sous-page playlist — ${target.label} (rechargement à l'appui)`, line);
          else if (noir) warn(`Sous-page playlist — ${target.label}`, line);
          else note(`Sous-page playlist — ${target.label}`, line);
          report.pages.push({ label: `${target.label} (playlist)`, sub: at, after });
        } else {
          warn(`Sous-page playlist — ${target.label}`, "aucune mesure n'est remontée après l'ouverture");
        }
        /* **Et le retour.** Signalé avec l'écran noir : « le retour en arrière
           doit fonctionner ». On l'appuie comme le ferait Android
           (`SpotiDuckUI.back()`) et on regarde où l'on atterrit : la
           bibliothèque doit revenir, son onglet avec, et le lecteur rester. */
        retour = await safely(() =>
          page.evaluate(() => {
            if (!window.SpotiDuckUI || !window.SpotiDuckUI.back) return null;
            const consomme = window.SpotiDuckUI.back();
            return { consomme, chemin: location.pathname };
          })
        );
        await sleep(2200);
        const apresRetour = await safely(() => page.evaluate(RETOUR_PROBE));
        if (retour && apresRetour) {
          const parLaBibliotheque =
            /sd-lib-row/.test((opened && opened.via) || "") ||
            !!(avantRetour && avantRetour.bibliotheque.indexOf("visible") === 0);
          const revenu = apresRetour.bibliotheque.indexOf("visible") === 0 || apresRetour.onglet === "library";
          const ligne =
            `chemin=${apresRetour.chemin} onglet=${apresRetour.onglet} bibliothèque=${apresRetour.bibliotheque} ` +
            `lecteur=${apresRetour.lecteur} · depuis la bibliothèque=${parLaBibliotheque ? "oui" : "non"}`;
          /* On ne juge le retour que si l'on venait **de la bibliothèque** :
             c'est là qu'il doit ramener (« le retour en arrière doit
             fonctionner »). Ailleurs, on relève le chemin sans rien juger. */
          if (parLaBibliotheque && !revenu) warn(`Retour depuis une playlist — ${target.label}`, ligne);
          else note(`Retour depuis une playlist — ${target.label}`, ligne);
          retour = Object.assign(retour, apresRetour);
        }

        /* Et on revient : les mesures suivantes (défilement, captures) ont
           besoin de la page de départ, pas d'une playlist ouverte. */
        try {
          await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await sleep(2500);
          await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
          await sleep(2000);
        } catch (e) {
          /* page irrécupérable : les mesures suivantes le diront */
        }
      }

      /* **Le lecteur pendant le défilement** : il ne doit pas s'effacer. */
      if (hasNav === true) {
        /* Une navigation a pu emporter la coque (l'appui sur « accueil » juste
           avant, ou une redirection de Spotify) : sans coque il n'y a pas de
           lecteur à mesurer, et la mesure ne dirait rien. On la repose, et si
           elle manque toujours, on le dit au lieu de publier un « absent ». */
        const missing = await safely(() => page.evaluate(() => !document.querySelector(".sd-mini")));
        if (missing === true) {
          await safely(() => page.evaluate(target.mode === "original" ? original : bundle));
          await sleep(2500);
        }
        const scroll = await safely(() => page.evaluate(SCROLLPROBE));
        if (scroll) {
          const line =
            `${scroll.coque} · haut=${scroll.before} · bas=${scroll.after} · bas+900ms=${scroll.after2} · ` +
            ` · document=${scroll.document} · ${scroll.classe} · dessus : ${scroll.beforeTop}→${scroll.afterTop}` +
            ` · place réservée=${scroll.bas || "—"}` +
            ` · plein-écran=${scroll.lecteurPlein} · transform=${scroll.transform}`;
          if (scroll.before === "absent" || scroll.after === "absent" || scroll.after2 === "absent") {
            warn(`Lecteur au défilement — ${target.label}`, line);
          } else {
            note(`Lecteur au défilement — ${target.label}`, line);
          }
          report.pages.push({ label: `${target.label} (défilement)`, scroll });
        }
      }

      /* Un résumé court par page : le détail complet va dans le rapport et
         dans la console, l'annotation ne portant que ce qui décide. */
      if (target.mode === "notre") {
        const box = (sel) => {
          const entry = after && after.controls ? after.controls[sel] : null;
          return entry ? entry.replace(/ pos=.*;? ?z=[^ ]*/, "") : "?";
        };
        note(
          "Notre interface (banc)",
          `haut=${box("barre du haut (.sd-nav)")} · bas=${box("barre du bas (.sd-tabbar)")} · mini=${box("mini-lecteur (.sd-mini)")} · ` +
            `en-tête=${box("en-tête (.sd-topbar)")} · classes="${after && after.classes ? after.classes : "?"}"`
        );
      }
      /* **Chaque appareil.** L'interface doit s'adapter toute seule : on la
         mesure donc sur cinq profils — téléphone étroit, référence, grand
         téléphone, paysage, tablette — et on relève l'unité calculée, les
         barres, le débordement et la taille des cibles tactiles. */
      const deviceRows = [];
      if (target.label === "banc-tel") {
        const profiles = [
          { name: "360×800", width: 360, height: 800, deviceScaleFactor: 2 },
          { name: "412×915", width: 412, height: 915, deviceScaleFactor: 2.625 },
          { name: "480×1040", width: 480, height: 1040, deviceScaleFactor: 2.5 },
          { name: "paysage", width: 915, height: 412, deviceScaleFactor: 2.625 },
          { name: "tablette", width: 800, height: 1280, deviceScaleFactor: 2 },
        ];
        for (const profile of profiles) {
          await safely(() =>
            page.setViewport({
              width: profile.width,
              height: profile.height,
              deviceScaleFactor: profile.deviceScaleFactor,
              isMobile: true,
              hasTouch: true,
            })
          );
          await sleep(900);
          const m = await safely(() => page.evaluate(MEASURE));
          const box = (sel) => {
            const entry = m && m.controls ? m.controls[sel] : null;
            if (!entry) return "?";
            const px = /(\d+)×(\d+)/.exec(entry);
            return px ? px[1] + "×" + px[2] : "?";
          };
          deviceRows.push(
            `${profile.name} u=${m && m.unit ? m.unit : "?"} nav=${box("barre du haut (.sd-nav)")} ` +
              `mini=${box("mini-lecteur (.sd-mini)")} déb=${m && m.layout ? m.layout.debordement : "?"} ` +
              `cibles=${m && m.tapTargets ? m.tapTargets : "?"}`
          );
        }
        note("Appareils — notre interface", deviceRows.join("  ||  "));
        /* Retour au profil de référence pour la suite (appuis, captures). */
        await safely(() =>
          page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true })
        );
        await sleep(500);
      }

      const visible = (sel) => {
        const entry = after && after.controls ? after.controls[sel] : null;
        return entry ? (entry.indexOf("visible") === 0 ? "visible" : "masqué") : "?";
      };
      const summary =
        `${target.label} → ` +
        (after && after.layout
          ? `mise en page=${after.layout.htmlClientWidth}px (interne ${after.layout.innerWidth}, meta ${after.layout.meta}) débordement=${after.layout.debordement} contenu=${after.layout.contenu}` +
            (after.layout.debordement > 0 && after.debordants ? ` débordants: ${after.debordants}` : "") +
            ` / `
          : "") +
        (target.mode === "original"
          ? `interface d'origine : firstFuck=${after && after.originalUi ? after.originalUi.firstFuck : "?"} ` +
            `actPlayPause=${after && after.originalUi ? after.originalUi.actPlayPause : "?"} ` +
            `mini-lecteur=${after && after.originalUi && after.originalUi.miniPlayer ? "posé" : "absent"} ` +
            `feuille=${after && after.originalUi && after.originalUi.feuilleOrigine ? "posée" : "absente"} ` +
            `styles=${after && after.cssBytes ? after.cssBytes : "?"} car.`
          : `coque=${after && after.layer ? "construite" : "ABSENTE"} / ` +
            `haut=${visible("barre du haut (.sd-nav)")} bas=${visible("barre du bas (.sd-tabbar)")} ` +
            `mini=${visible("mini-lecteur (.sd-mini)")} en-tête=${visible("en-tête (.sd-topbar)")} ` +
            `écran-accueil=${
              after && after.classes && after.classes.indexOf("sd-welcome-on") >= 0 ? "POSÉ (masque la coque)" : "retiré"
            } ` +
            `spotify-restant=${after && after.spotifyChrome
              ? Object.entries(after.spotifyChrome)
                  .filter(([, v]) => v.indexOf("visible") === 0)
                  .map(([k]) => k)
                  .join("+") || "rien"
              : "?"}`) +
        ` / appuis : ${navEffects
          .map((e) => {
            if (e.click && e.click.clicked === false) return `${e.name}→bouton absent`;
            /* `navigation` dit que le contexte d'exécution a été détruit : c'est
               la preuve que l'appui a changé de page. */
            if (e.click && e.click.navigation) return `${e.name}→navigue (page changée)`;
            if (e.click && e.click.changed) return `${e.name}→navigue ${e.click.pathAfter}`;
            if (e.after && e.after.navigation) return `${e.name}→navigue`;
            if (e.after && e.after.stateTab) return `${e.name}→${e.after.stateTab}`;
            return `${e.name}→RIEN (chemin ${e.click && e.click.pathAfter})`;
          })
          .join(", ")}`;
      /* Les mesures détaillées de **cette** page. Elles étaient jointes en une
         seule note pour toutes les pages, à la toute fin : une note longue peut
         être perdue (observé le 25/09 : « Accueil maison » et « Rognage »
         disparus des annotations alors que le run était vert), et on perdait
         alors la seule mesure qui compte — celle de l'accueil. Chaque page
         publie donc la sienne. */
      const pageLines = [];
      if (after && after.contentVisible) pageLines.push(`Contenu - ${target.label} : ${after.contentVisible}`);
      if (after && after.structure) pageLines.push(`Structure - ${target.label} : ${after.structure}`);
      if (after && after.shelves) pageLines.push(`Rangées - ${target.label} : ${after.shelves}`);
      if (after && after.content) pageLines.push(`Contenu-te tailles - ${target.label} : ${after.content}`);
      if (after && after.rognes) pageLines.push(`Rognage - ${target.label} : ${after.rognes}`);
      if (after && after.home) pageLines.push(`Accueil maison - ${target.label} : ${after.home}`);
      if (after && after.library) pageLines.push(`Bibliothèque - ${target.label} : ${after.library}`);
      if (after && after.bottom) pageLines.push(`Bas de page - ${target.label} : ${after.bottom}`);
      if (after && after.library && target.label === "page-fr") {
        /* La raison d'une bibliothèque muette doit tenir dans la ligne : c'est
           ce qu'une capture de l'utilisateur ne peut pas dire autrement. */
        const note = await safely(() =>
          page.evaluate(() => {
            const el = document.querySelector(".sd-lib-note");
            return el ? (el.textContent || "").trim().slice(0, 90) : "";
          })
        );
        pageLines.push(`Bibliothèque, ce qu'elle dit - ${target.label} : ${note || "(rien)"}`);
      }
      lines.push(summary, ...pageLines);
      console.log(`[Sonde coque] ${summary}`);
      note(`Mesure — ${target.label}`, summary);
      if (pageLines.length) {
        note(`Détail — ${target.label}`, pageLines.join("  ||  "));
      } else if (after && after.layout) {
        /* La mesure est un témoin : si l'état de la page est arrivé mais que
           rien n'en a été relevé, la sonde elle-même est en cause — il faut le
           dire, au lieu de laisser un rapport muet. */
        warn(`Mesure incomplète — ${target.label}`, "la page a été mesurée mais aucun relevé détaillé n'est remonté");
      }

      report.pages.push({ label: target.label, url: target.url, before, after, navEffects, errors });
      if (errors.length) warn(`Erreurs — ${target.label}`, errors.slice(0, 5).join("  ||  "));
    } catch (error) {
      lines.push(`${target.label} → ÉCHEC : ${String((error && error.message) || error).slice(0, 200)}`);
      report.pages.push({ label: target.label, url: target.url, failure: String((error && error.message) || error) });
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (lines.length) note("La coque sur la vraie page", lines.join("  ||  "));

  /* Les miniatures : encodées dans les annotations, parce que les artefacts ne
     sont pas joignables depuis tous les environnements. Une annotation est
     coupée net à 1 800 caractères (mesuré), donc chaque image part en morceaux :
     `SHOT:<nom>:<morceau>/<total>:<base64>`. */
  const CHUNK = 1700;
  for (const shot of shots) {
    const [, name, payload] = shot.split(":");
    if (payload.startsWith("echec")) {
      warn(`Capture — ${name}`, payload);
      continue;
    }
    const total = Math.ceil(payload.length / CHUNK);
    console.log(`[Sonde coque] capture ${name} : ${payload.length} caractères en ${total} morceau(x)`);
    for (let i = 0; i < total; i++) {
      const part = payload.slice(i * CHUNK, (i + 1) * CHUNK);
      note(`Capture ${name} ${i + 1}/${total}`, `SHOT:${name}:${i + 1}/${total}:${part}`);
    }
  }

  const allErrors = report.pages.flatMap((p) => (p.errors || []).map((e) => `${p.label}: ${e}`));
  if (allErrors.length) warn("Erreurs de la page", allErrors.slice(0, 5).join("  ||  "));
  else note("Erreurs de la page", "aucune");

  if (fautes.length) {
    console.log(`::error title=La coque est cassée::${clean(fautes.join(" || "), 1500)}`);
    console.log(`[Sonde coque] ECHEC — ${fautes.length} règle(s) dure(s) enfreinte(s)`);
    try {
      writeFileSync(`${OUT}/ECHEC`, fautes.join("\n"));
    } catch (e) {
      /* le dossier peut manquer : le verdict est déjà dans la sortie */
    }
    process.exitCode = 1;
  } else {
    console.log("::notice title=La coque tient::aucun bouton verrouillé, aucun appui perdu, place réservée mesurée conforme");
  }

  await browser.close().catch(() => {});
  writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  console.log(`[Sonde coque] rapport écrit dans ${OUT}/rapport.json`);
}

main().catch((error) => {
  warn("Sonde coque", `interrompue : ${String((error && error.stack) || error)}`);
  try {
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  } catch {
    /* rien de plus à faire */
  }
});
