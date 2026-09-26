#!/usr/bin/env node
/**
 * Le **moteur** de l'application d'origine, repris tel quel.
 *
 *     node tools/build-logic.mjs        (npm run build:logic)
 *
 * `docs/UI-REWORK.md` §55 fermait la phase « affichage » sur un constat : la
 * coque relit Spotify dans son markup et clique ses boutons. L'application
 * d'origine, elle, **ne fait pas ça** : elle écoute le trafic de la page (jeton
 * `Client-Token`, `Authorization`, identifiant d'appareil, URI en cours), parle
 * à Spotify par l'API Connect **via le pont Android** (hors WebView), et
 * s'occupe elle-même de l'écran, de la mise en veille et du « player vérouillé
 * » qui ne se débloque qu'avec un rechargement. C'est de la logique, pas de
 * l'affichage — et c'est elle que ce fichier livre.
 *
 * ## Pourquoi une extraction et pas le script entier
 *
 * `src/original/spotiduck-original.js` est un seul IIFE où l'affichage et la
 * logique partagent les mêmes variables de closure (`playing`, `track`,
 * `position`, `pBtn`…). Y injecter le fichier en entier redonnerait
 * l'interface d'origine par-dessus la nôtre. Les blocs ci-dessous sont donc
 * découpés **aux marqueurs**, recopiés octet pour octet, et replacés dans un
 * wrapper qui ne fait que **les nourrir** : les variables d'état viennent de la
 * coque, et les fonctions non portées (`firstFuck`, `updNpbState`,
 * `checkMediaLib`, `add*`) sont fournies vides ou minces — jamais réécrites.
 *
 * ## Ce qui est vérifié, et pourquoi ça refuse d'écrire
 *
 * Chaque bloc a sa longueur et son md5 dans `LOCKS`. Un bloc qui bouge n'est
 * plus « le code d'origine » : la lecture continue de fonctionner sur le banc
 * et se casse sur le téléphone, sans message. De même le fichier refuse
 * d'écrire si une méthode du pont citée par un bloc manque dans
 * `android/app/src/main/java/com/spotiduck/app/Bridge.kt` (`nFetch` absent =
 * `playFromUri` qui avale l'erreur en silence), ou si le `meta viewport` est
 * posé **après** le moteur dans `MainActivity` (le capteur d'URI doit précéder
 * le premier `fetch` de la page).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const md5 = (s) => createHash("md5").update(s).digest("hex").slice(0, 10);

const SOURCE = "src/original/spotiduck-original.js";
const BRIDGE = "android/app/src/main/java/com/spotiduck/app/Bridge.kt";
const OUT = "dist/spotiduck-logic.js";

/* --------------------------------------------------------------------------
   Les blocs, dans l'ordre où l'original les définit. `from` est inclus, `to`
   exclus : un marqueur est une chaîne **unique** dans le fichier source, et
   l'outil échoue si elle ne l'est pas — un découpage qui se décale d'un
   caractère produit un fichier qui se parse encore et qui ne fait plus la
   même chose.
   -------------------------------------------------------------------------- */
const SLICES = [
  {
    name: "état",
    why: "les variables de closure que les blocs partagent (drapeaux d'intervalle, `featVer`)",
    from: "let reqPause=false,",
    to: "window.hasVid=function(){",
  },
  {
    name: "capteur",
    why: "lit dans le trafic de la page `spotDevId`, `spotCliToken`, `spotAuthToken`, `currUri`, et l'état de lecture posé par la page elle-même",
    from: "window.hasVid=function(){",
    /* **Arrêté là où l'original commençait à détourner.** Le bloc d'origine
       renvoyait ensuite toute URL contenant `connect-state` vers `mngFetch` —
       donc le flux d'état du lecteur de Spotify passait par `HttpURLConnection`
       du pont : plus d'`AbortSignal`, plus de streaming, des en-têtes réécrits.
       Dans l'application d'origine, c'était sa page et son lecteur ; ici, la
       coque a besoin des **jetons**, pas du détourage — et le détourage rend
       exactement le symptôme « les touches du bas ne font plus rien ». Le bloc
       se termine donc par une ligne de la coque (voir `close`) qui laisse la
       page maître de son propre trafic. */
    to: "  try { let resp;",
    close: "\n  /* Coque : la page garde son trafic. `mngFetch` reste utilisé par\n     `playFromUri` (bloc suivant), qui est une commande de la coque. */\n  return oriFetch.apply(this, args);\n};\n",
  },
  {
    name: "playFromUri",
    why: "lancer une piste par l'API Connect (commande `play`, `license: \"tft\"`), pas par un clic",
    from: "window.playFromUri = function",
    to: "window.updNpbState = function",
  },
  {
    name: "manageWake",
    why: "l'écran : verrouillé seulement si la lecture tourne en arrière-plan",
    from: "window.manageWake = function",
    to: "window.manageAll = function",
  },
  {
    name: "trigUnlock",
    why: "le secours du lecteur verrouillé : bouton toujours `disabled` → rechargement annoncé au pont",
    from: "window.trigUnlock = function",
    to: "window.actPlayPause = function",
  },
  {
    name: "act",
    why: "les commandes : lecture/pause (jugée sur l'icône de Spotify), sauts, répétition, favori, position",
    from: "window.actPlayPause = function",
    /* la dernière accolade qui ferme `actSeek` est juste devant — le marqueur
       la laisse donc dans le bloc, sinon le morceau se parse et ne veut plus
       rien dire */
    to: "window.addAutoFeatures=function",
  },
  {
    name: "manageAll",
    why: "la machine d'état : `playing` → notification, mise en veille, minuteries d'arrêt, redémarrage des surveillances",
    from: "window.manageAll = function",
    to: "window.clickNP = function",
  },
  {
    name: "updMedia",
    why: "le rapport à Android : état complet au changement, position seulement au-delà de 4 s",
    from: "window.updMedia = function",
    to: "/* --------------------------------------------------------------------------\n   SpotiDuck — seul ajout",
  },
];

/* Les empreintes sont dans `tools/build-logic.locks.json` (un bloc qui bouge
   n'est plus du code repris tel quel). Au premier relevé — pas de sidecar, ou
   une entrée à `0000000000` — l'outil enregistre ce qu'il trouve et le dit : la
   relecture humaine est le `git diff` du fichier de verrous. */
const LOCKFILE = "tools/build-logic.locks.json";
let LOCKS = {};
try {
  LOCKS = JSON.parse(read(LOCKFILE)).blocks || {};
} catch (e) {
  LOCKS = {};
}
for (const slice of SLICES) {
  if (!LOCKS[slice.name]) LOCKS[slice.name] = { len: 0, md5: "0000000000" };
}

/* Le pont dont le moteur dépend : chaque méthode citée par un bloc doit exister
   côté Kotlin, sinon l'appel échoue silencieusement dans la WebView. */
const BRIDGE_METHODS = [
  "nFetch",
  "deferMessage",
  "wakeUp",
  "wakeOff",
  "isWoke",
  "manageTShut",
  "manageTSleep",
  "recMediaStatus",
  "recMediaPosition",
  "playLoaded",
];

const problems = [];
const recorded = [];
const source = read(SOURCE);

/* -------------------------------------------------------------------------- */
function cut(src, slice) {
  const first = src.indexOf(slice.from);
  if (first < 0) throw new Error(`« ${slice.from} » introuvable`);
  if (src.indexOf(slice.from, first + 1) >= 0) throw new Error(`« ${slice.from} » n'est plus unique`);
  const last = src.indexOf(slice.to, first);
  if (last < 0) throw new Error(`fin « ${slice.to} » introuvable après ${slice.name}`);
  let body = src.slice(first, last);
  body = body.replace(/\s+$/, "");
  if (slice.close) body = body + "\n" + slice.close.trim();
  return body;
}

const blocks = [];
for (const slice of SLICES) {
  try {
    const body = cut(source, slice);
    const lock = LOCKS[slice.name];
    const got = { len: body.length, md5: md5(body) };
    if (!lock || lock.md5 === "0000000000" || lock.len !== got.len || got.md5 === "0000000000") {
      /* premier relevé (sidecar absent, ou bloc nouveau) : on enregistre. */
      LOCKS[slice.name] = { len: got.len, md5: got.md5 };
      recorded.push(`${slice.name} ${got.len} car. md5 ${got.md5}`);
    }
    if (lock && lock.md5 !== "0000000000" && lock.len === got.len && (got.len !== lock.len || got.md5 !== lock.md5)) {
      problems.push(
        `le bloc « ${slice.name} » de l'original a changé (${got.len} car. md5 ${got.md5}, attendu ${lock.len} car. md5 ${lock.md5}) : ` +
          "ce n'est plus du code repris tel quel — relire la source, et réaligner la coque plutôt que le bloc"
      );
    }
    blocks.push({ ...slice, body });
  } catch (error) {
    problems.push(`découpage « ${slice.name} » impossible : ${error.message}`);
  }
}

/* Le pont, vérifié sur le fichier Kotlin (sans ses commentaires). */
const bridge = read(BRIDGE).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const m of BRIDGE_METHODS) {
  if (!new RegExp(`fun ${m}\\(`).test(bridge)) {
    problems.push(`le pont ne fournit plus \`${m}\` : le moteur l'appelle, l'échec serait silencieux`);
  }
}

if (problems.length) {
  console.error("\nSpotiDuck — moteur de lecture\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n${problems.length} problème(s) — ${OUT} n'a pas été écrit\n`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Le wrapper : uniquement de la **nourriture** pour les blocs. Tout ce qui est
   écrit ici est marqué « coque » ; aucun ne redessine quoi que ce soit.
   -------------------------------------------------------------------------- */
const header = `/* ==========================================================================
   SpotiDuck — le moteur de lecture de l'application d'origine, **repris tel
   quel**. Généré par \`tools/build-logic.mjs\` : ne pas éditer ici.

   Huit blocs de \`src/original/spotiduck-original.js\`, recopiés octet pour
   octet (longueurs et md5 vérifiés à chaque \`npm run build\`) : capteur de
   jetons sur le trafic de la page, \`mngFetch\` (requêtes hors WebView par le
   pont Android), \`playFromUri\` (démarrer une piste par l'API Connect),
   \`manageWake\`, \`trigUnlock\`, les six commandes \`act*\`, \`manageAll\` (la
   machine d'état : notification, veille, minuteries), \`updMedia\` (le rapport
   à Android).

   Ce fichier **ne dessine rien**. Ce que l'original y mêlait d'affichage (sa
   barre du haut, son mini-lecteur, son \`npBtn\), ses hacks CSS et ses
   coupures de rangées d'accueil est resté dehors : la coque
   (\`src/inject/spotiduck-ui.js\%) est seule à dessiner, et lui fournit l'état.

   Interface vers la coque : \`window.SpotiDuckLogic\` (méthodes en bas du
   fichier). Les variables d'état que les blocs se partagent sont **fournies par
   la coque** — c'est le seul code qui soit d'ici, et il ne fait que transférer.
   ========================================================================= */
`.replace("spotiduck-ui.js%", "spotiduck-ui.js`");

const glueTop = `
(function () {
  /* **Pas de « use strict »** : les blocs recopiés assignent des variables sans
     les déclarer (\`playing\`, \`featVer\`, \`window.pBtn\`) et se relisent
     ensuite par ce nom — c'est ainsi que l'original fonctionne, et que
     « \`pBtn\` in window » répond vrai quand la coque lui passe le bouton. */
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
`;

/* Les blocs, dans l'ordre de l'original. Ils ne sont précédés d'aucune
   déclaration : le bloc « état » les apporte, et l'original s'appuie sur des
   globales **implicites** (`playing=false`, `window.pBtn = …`) — d'où
   l'absence de `"use strict"` dans le wrapper, et le fait que la nourriture
   fournie plus bas de simples **affectations**, jamais des `var`. */
const body = blocks
  .map((b) => `\n  /* ---- bloc « ${b.name} » — ${b.why} ---- */\n` + b.body)
  .join("\n");

const glueBottom = `

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
    /* Le bouton de lecture est ce que l'original surveille pour savoir si la
       page peut répondre : la coque le lui signale (playLoaded, comme lui). */
    sawButton: function (el) {
      pBtn = el;
      if (el) { try { AndBridge.playLoaded(); } catch (e) {} }
      return !!el;
    },
  };
  /* Le moteur est là : la coque peut cesser de compter sur le seul markup. */
  emit("state", { ready: true });
})();
`;

const out = header + glueTop + body + glueBottom;
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, OUT), out, "utf8");
writeFileSync(join(root, LOCKFILE), JSON.stringify({ bundle: { len: out.length, md5: md5(out) }, blocks: LOCKS }, null, 2) + "\n", "utf8");

const sizes = blocks.map((b) => `${b.name} ${String(b.body.length).padStart(5)} car.`).join(" · ");
console.log(`\nSpotiDuck — moteur de lecture (code d'origine, ${blocks.length} blocs repris tels quels)\n`);
console.log(`  ${sizes}`);
console.log(`\n  → ${OUT} (${out.length} car.) — pont vérifié (${BRIDGE_METHODS.length} méthodes)\n`);
if (recorded.length) {
  console.log(`  ⚑ empreintes relevées pour la première fois dans ${LOCKFILE} — à relire avant de pousser :`);
  for (const r of recorded) console.log(`      ${r}`);
  console.log("");
}
