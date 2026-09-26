#!/usr/bin/env node
/**
 * Contrôles croisés entre les morceaux qui doivent rester d'accord :
 *
 *   node tools/audit-links.mjs       (npm run audit)
 *
 * Rien ne se compile « à travers » ces frontières, donc une faute de frappe ne
 * se voit qu'à l'exécution — sur le téléphone. Ce script vérifie :
 *
 *   1. chaque méthode du pont appelée par la couche existe bien dans
 *      `Bridge.kt` (`@JavascriptInterface`) ;
 *   2. chaque classe `sd-…` manipulée par le runtime est stylée quelque part
 *      dans `src/inject/*.css` (sinon l'élément change d'état sans que rien ne
 *      bouge à l'écran — l'utilisateur voit « un bouton qui ne fait rien ») ;
 *   3. chaque ressource Kotlin (`R.string.*`) et chaque fichier d'`assets/`
 *      ouvert par le code existe.
 *
 * Sortie non nulle en cas d'erreur : utilisable en CI.
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "acorn";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import { uiSource } from "./ui-source.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/* Un garde-fou cherche une **pratique**, pas un mot cité dans une
   explication : ces contrôles lisent le code sans ses commentaires. */
const stripComments = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const errors = [];
const warnings = [];

/* 1. Pont JS → Kotlin ------------------------------------------------------ */
const bridgeKt = read("android/app/src/main/java/com/spotiduck/app/Bridge.kt");
const kotlinMethods = new Set(
  [...bridgeKt.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map((m) => m[1])
);
/* La coque est assemblee depuis src/inject/ui/ : lire lenveloppe ne verrait que le
   marqueur, et l audit declarerait « plus de module X » alors que X existe. On passe
   donc par le meme assembleur que la construction. */
const runtime = uiSource(root);
const usedBridgeNames = new Set();
for (const m of runtime.matchAll(/Bridge\.call\(\s*"(\w+)"/g)) usedBridgeNames.add(m[1]);
/* Les raccourcis (`mediaStatus`, `sleepLock`…) appellent `call("<nom>")` : on
   récupère aussi les noms passés à l'intérieur de l'objet Bridge. */
for (const m of runtime.matchAll(/this\.call\(\s*"(\w+)"/g)) usedBridgeNames.add(m[1]);
/* L'interface d'origine appelle le pont directement (`AndBridge.nFetch(...)`),
   sans passer par le module Bridge : ses appels comptent aussi, sinon
   l'audit réclamerait la suppression de méthodes bien utilisées. */
const originalCalls = read("src/original/spotiduck-original.js");
for (const m of originalCalls.matchAll(/AndBridge\.(\w+)\s*\(/g)) usedBridgeNames.add(m[1]);
/* La page mobile de Spotify (le mode livré) parle au pont elle aussi : c'est
   elle qui annonce l'état de connexion et qui demande le nettoyage de l'état du
   formulaire. Sans cette lecture, l'audit réclamerait la suppression de méthodes
   bien utilisées. */
const nativeCalls = read("src/inject/native-mode.js");
for (const m of nativeCalls.matchAll(/AndBridge\.(\w+)\s*\(/g)) usedBridgeNames.add(m[1]);

for (const name of usedBridgeNames) {
  if (!kotlinMethods.has(name)) errors.push(`Bridge.kt n'expose pas « ${name} » (appelé par la couche injectée)`);
}
for (const name of kotlinMethods) {
  if (!usedBridgeNames.has(name) && name !== "uiMode" && name !== "setUiMode" && name !== "showUiChooser") {
    warnings.push(`Bridge.kt expose « ${name} » : plus personne ne l'appelle côté JS`);
  }
}

/* 2. Classes `sd-…` du runtime stylées quelque part ------------------------ */
const cssFiles = readdirSync(join(root, "src/inject")).filter((f) => f.endsWith(".css"));
const css = cssFiles.map((f) => read(join("src/inject", f))).join("\n");
/* Les classes apparaissent en CSS tantôt `.sd-x`, tantôt `html.sd-x` : on
   prend tous les jetons `sd-…` des feuilles. */
const defined = new Set([...css.matchAll(/sd-[a-z0-9-]+/gi)].map((m) => m[0].toLowerCase()));
/* Classes posées en JS : `classList.add/toggle/remove("sd-x")`, `className = "sd-x"`,
   et les chaînes de l'attribut `class="sd-x y"` du HTML construit. */
const usedClasses = new Set();
for (const m of runtime.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*"([^"]+)"/g)) {
  m[1].split(/\s+/).forEach((c) => c.startsWith("sd-") && usedClasses.add(c.toLowerCase()));
}
for (const m of runtime.matchAll(/class="([^"]*\bsd-[^"]*)"/g)) {
  m[1].split(/\s+/).forEach((c) => c.startsWith("sd-") && usedClasses.add(c.toLowerCase()));
}
for (const m of runtime.matchAll(/"sd-[a-z0-9-]+"/gi)) {
  const name = m[0].slice(1, -1).toLowerCase();
  if (name !== "sd-layer" && name !== "sd-root") usedClasses.add(name);
}
/* Quelques classes servent uniquement de marqueur pour le JS ou les tests. */
const NOT_STYLED_ON_PURPOSE = new Set([
  "sd-density-normal",
  "sd-login-done",
  "sd-tap",
  "sd-welcome",
  /* Marqueurs du garde-fou de contenu (l'apparence est changée en style en
     ligne, sur les éléments concernés — pas par une règle). */
  "sd-content-restored",
  "sd-content-hidden",
]);
for (const cls of usedClasses) {
  if (cls.endsWith("-")) continue; // classe construite par concaténation (sd-density-…)
  if (!defined.has(cls) && !NOT_STYLED_ON_PURPOSE.has(cls)) {
    warnings.push(`classe « ${cls} » posée par le runtime mais stylée nulle part`);
  }
}

/* 2-bis. Méthodes de modules : `Foo.bar(` doit exister dans `var Foo = {…}`.
   C'est ce qui attrape `UI.pick is not a function` avant le téléphone. Analyse
   par AST (acorn) : un analyseur maison se faisait piéger par les expressions
   régulières et les chaînes, et criait au loup. */
const ast = parse(runtime, { ecmaVersion: 2022, sourceType: "script" });

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn);
    return;
  }
  if (typeof node.type === "string") fn(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    walk(node[key], fn);
  }
}

const keyName = (key) =>
  key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;

const moduleKeys = new Map();
walk(ast, (node) => {
  if (node.type !== "VariableDeclarator") return;
  if (node.id.type !== "Identifier" || !node.init || node.init.type !== "ObjectExpression") return;
  const keys = new Set();
  for (const prop of node.init.properties) {
    if (prop.type !== "Property") continue;
    const name = keyName(prop.key);
    if (name) keys.add(name);
  }
  moduleKeys.set(node.id.name, keys);
});

const missing = new Set();
walk(ast, (node) => {
  if (node.type !== "CallExpression") return;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return;
  if (callee.object.type !== "Identifier" || callee.property.type !== "Identifier") return;
  const keys = moduleKeys.get(callee.object.name);
  if (!keys || keys.has(callee.property.name)) return;
  missing.add(callee.object.name + "." + callee.property.name + "()");
});
for (const call of [...missing].sort()) errors.push(`appel à ${call} — méthode absente du module`);

/* 2-ter. Les feuilles CSS sont-elles saines ? Une accolade orpheline fait
   silencieusement disparaître tout ce qui suit — écran cassé, aucune erreur. */
const bundleCss = read("dist/spotiduck-ui.js");
for (const file of cssFiles) {
  const body = read(join("src/inject", file));
  let depth = 0;
  for (const c of body) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push(`${file} : accolades déséquilibrées (${depth})`);
}
const CORE_SELECTORS = [
  ".sd-layer",
  ".sd-tabbar",
  ".sd-mini",
  ".sd-player",
  ".sd-topbar",
  ".sd-toast",
  ".sd-sheet",
  ".sd-welcome",
];
for (const sel of CORE_SELECTORS) {
  if (!bundleCss.includes(sel)) errors.push(`le bundle ne contient plus le sélecteur ${sel}`);
}

/* 2-ter-bis. La page de connexion et l'état de session — les deux trous de la
   2.9.1, payés par l'utilisateur (« le bouton ne fait rien », bloqué sur la page
   de connexion).

   Le premier : la coque s'installe aussi sur `accounts.spotify.com`. Elle y
   reconnaît une page de connexion, y posait son **écran d'accueil par-dessus le
   formulaire**, et son bouton menait à la page déjà affichée — donc rien ne
   bougeait. L'écran d'accueil doit rester au lecteur, jamais à la page de
   connexion.

   Le second : la coque ne rapportait **pas** l'état de connexion
   (`AndBridge.loginState`). Tant que la page mobile était le défaut, ça ne se
   voyait pas ; depuis que la coque est livrée par défaut, la session n'était
   plus ni confirmée ni rangée à la connexion, et une déconnexion volontaire
   n'était plus distinguée d'un lancement sans session. */
const shellJs = read("dist/spotiduck-ui.js");
if (!/loginState/.test(shellJs)) {
  errors.push("le bundle ne rapporte plus l'état de connexion à Android (AndBridge.loginState)");
}
if (!/isLoginPage\s*:/.test(shellJs)) {
  errors.push("le bundle ne distingue plus la page de connexion (isLoginPage)");
}
/* La condition de l'écran d'accueil, telle qu'elle est écrite : jamais sur la
   page de connexion. */
const welcomeGate = (shellJs.match(/var show = [^;]+;/) || [""])[0];
if (!/!login/.test(welcomeGate) || !/isLoginPage/.test(welcomeGate)) {
  errors.push(`l'écran d'accueil n'est plus tenu à l'écart de la page de connexion : « ${welcomeGate} »`);
}
/* Le bouton de l'écran d'accueil doit passer par le natif, pas seulement poser
   un lien que le routeur de Spotify peut ignorer. */
if (!/welcome-cta[\s\S]{0,600}openLogin/.test(shellJs)) {
  errors.push("le bouton de l'écran d'accueil n'est plus relié à la connexion native");
}

/* L'unité de l'interface doit rester **déduite de l'appareil** : figée, elle
   suppose un téléphone de 412 px et tout le reste se retrouve « pas adapté à
   l'appareil » (le reproche, à chaque version). */
if (!/--sd-u:\s*calc\(var\(--sd-u-base\)\s*\*\s*var\(--sd-density\)\)/.test(css)) {
  errors.push("l'unité d'interface n'est plus le produit de la base mesurée et du réglage : l'affichage ne suivra plus l'appareil");
}
for (const part of ["sd-size-compact", "sd-size-wide", "sd-orient-landscape"]) {
  if (!css.includes(part) || !shellJs.includes(part)) {
    errors.push(`le palier d'appareil « ${part} » a disparu (feuille ou coque)`);
  }
}
if (!/Device\.apply\(\)/.test(shellJs) || !/setProperty\("--sd-u-base"/.test(shellJs)) {
  errors.push("la coque ne mesure plus l'appareil : l'unité retomberait sur une valeur fixe");
}

/* Les cibles tactiles ne doivent pas descendre sous la main : tout contrôle de
   la coque se dimensionne avec `--sd-tap` (48 dp × unité ≥ 44 px), jamais avec
   une taille fixe qui rétrécirait l'appareil. La sonde relève la plus petite
   cible à chaque exécution ; ici on empêche la régression à la source. */
/* Les règles sont lues une par une (sélecteur / corps) : une expression
   régulière sur tout le fichier se laisse piéger par la règle voisine. */
const cssRules = css
  .split("}")
  .map((chunk) => {
    const brace = chunk.lastIndexOf("{");
    return brace === -1 ? null : { sel: chunk.slice(0, brace), body: chunk.slice(brace + 1) };
  })
  .filter(Boolean);
const hasTapFloor = (selector) =>
  cssRules.some(
    (rule) =>
      rule.sel.includes(selector) &&
      /width:\s*var\(--sd-tap\)/.test(rule.body) &&
      /height:\s*var\(--sd-tap\)/.test(rule.body)
  );
for (const sel of [".sd-nav-item", ".sd-mini-row .sd-iconbtn", ".sd-mini-row2 .sd-iconbtn"]) {
  if (!hasTapFloor(sel)) {
    errors.push(
      `« ${sel} » ne se dimensionne plus sur --sd-tap : la cible tactile peut passer sous 44 px sur un petit écran`
    );
  }
}


/* **Le garde-fou de contenu.** La capture du 24/09 montrait la coque sur un
   écran noir : une règle de notre feuille masquait un ancêtre du contenu (la
   barre du haut de Spotify est, dans la disposition actuelle, le conteneur de
   la page). Le garde-fou remonte la chaîne et rétablit ce qui a été masqué —
   s'il disparaît, l'écran peut redevenir noir sans que rien ne le signale. */
if (!/data-sd-unhidden/.test(shellJs) || !/Content\.apply\(\)/.test(shellJs)) {
  errors.push("le garde-fou de contenu a disparu : notre feuille peut de nouveau effacer la page");
}
for (const anchor of ["data-testid=\"home-page\"", "#main-view", "main[data-testid]"]) {
  if (!shellJs.includes(anchor)) {
    errors.push(`le garde-fou de contenu ne cherche plus « ${anchor} » : il ne trouverait plus le contenu à protéger`);
  }
}

/* **Le panneau « la page n'a rien affiché ».** Sans lui, une page qui ne rend
   rien redonne un écran noir muet : plus rien ne distingue « Spotify n'a pas
   chargé » de « notre feuille a tout masqué ». */
for (const part of ["sd-content-alert", "alertIfBlank", "sd-content-blank"]) {
  const inJs = shellJs.includes(part);
  const inCss = css.includes(part);
  if (!inJs && !inCss) {
    errors.push(`le panneau « page vide » a disparu (${part}) : un écran noir redeviendrait muet`);
  }
}
if (!/data-sd-unhidden/.test(shellJs) || !/Content\.apply\(\)/.test(shellJs)) {
  errors.push("le garde-fou de contenu a disparu : notre feuille peut de nouveau effacer la page");
}
for (const anchor of ["data-testid=\"home-page\"", "#main-view", "main[data-testid]"]) {
  if (!shellJs.includes(anchor)) {
    errors.push(`le garde-fou de contenu ne cherche plus « ${anchor} » : il ne trouverait plus le contenu à protéger`);
  }
}

/* **Le filet de sécurité côté application.** Une page qui n'affiche rien (le
   cas du 24/09 : écran noir sous notre barre) doit ramener à notre coque — la
   seule dont on sait qu'elle affiche la page — et non laisser l'utilisateur
   devant un écran vide sans issue. */
const bridgeSource = read("android/app/src/main/java/com/spotiduck/app/Bridge.kt");
const activitySource = read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
if (!/checkContentUsable/.test(activitySource)) {
  errors.push("l'application ne vérifie plus que la page affiche quelque chose : un écran vide ne serait plus rattrapé");
}
if (!/CONTENT_PROBE_JS/.test(activitySource)) {
  errors.push("le script de mesure du contenu a disparu de MainActivity");
}
if (!/showUiChooser\(\)/.test(activitySource)) {
  errors.push("le sélecteur d'interface n'est plus joignable (sortie de secours perdue)");
}

/* **Le contenu doit rester mis en page pour un téléphone.** La feuille de
   l'application d'origine fait *tenir* la page dans l'écran, elle ne la met pas
   en page pour un téléphone : pochettes de 59 px dans des cellules de 95,
   gouttières de 36 px, rangées espacées de 85 (capture du 24/09 à 21 h 47).
   La passe 77 s'en occupe, et elle doit rester **hors des écrans larges**, où la
   mise en page d'origine est la bonne. */
const contentPassFile = "77-content.css";
const contentPassSource = cssFiles.includes(contentPassFile)
  ? read(join("src/inject", contentPassFile))
  : "";
if (!contentPassSource) {
  errors.push("la passe de mise en page du contenu pour téléphone (77-content.css) a disparu : l'accueil redevient une page de bureau");
} else {
  const contentPass = contentPassSource;
  /* Elle doit traiter les **deux** familles d'appareils : la capture du 24/09
     vient d'un appareil large, et une passe réservée aux écrans étroits ne
     faisait rien chez lui. */
  if (!/html\.sd-mobile \.sd-root section\[data-testid="component-shelf"\]/.test(contentPass)) {
    errors.push("la passe de contenu ne s'applique plus à tous les appareils (elle était réservée aux écrans étroits, ce qui n'a rien changé sur l'appareil de l'utilisateur)");
  }
  if (!/grid-template-columns:\s*repeat\(auto-fill, minmax\(calc\(150px \* var\(--sd-u\)\)/.test(contentPassSource)) {
    errors.push("la passe de contenu ne règle plus le nombre de colonnes des rangées : la grille repasserait à quatre colonnes de pochettes minuscules (la capture du 24/09)");
  }
  /* « C'est encore coupé » : le conteneur d'une rangée mesurait 440 px dans une
     mise en page de 412, et notre `overflow-x: hidden` le rognait net. La passe
     doit borner les conteneurs à la largeur de la page. */
  if (!/section\[data-testid="component-shelf"\] \[data-testid="carousel-scroller"\]/.test(contentPassSource) ||
      !/max-width:\s*100%/.test(contentPassSource)) {
    errors.push("la passe de contenu ne borne plus les rangées à la largeur de l'écran : le contenu serait de nouveau rogné (« c'est encore coupé »)");
  }
  for (const needle of ["component-shelf", "carousel-scroller", "aspect-ratio", "img[width]"]) {
    if (!contentPass.includes(needle)) {
      errors.push(`la passe de contenu ne traite plus « ${needle} »`);
    }
  }
}

/* **L'accueil maison.** Décidé avec l'utilisateur après trois reprises de
   l'accueil du web player : la page ne tient pas sur un téléphone. Le calque
   doit rester, ses filtres et ses raccourcis doivent rester reliés, et sa
   grille doit continuer de se régler sur une largeur de carte (jamais un nombre
   de colonnes fixe — c'est ce qui causait le rognage). */
if (!readdirSync(join(root, "src/inject")).includes("78-home.css")) {
  errors.push("l'accueil maison (78-home.css) a disparu : l'application retomberait sur la mise en page de bureau");
}
if (!/var Home = \{/.test(shellJs) || !/Home\.refresh\(/.test(shellJs)) {
  errors.push("le module d'accueil maison a disparu de la coque");
}
if (!/home: Home,/.test(shellJs)) {
  errors.push("l'accueil maison n'est plus exposé à l'extérieur (diagnostic, sonde, tests)");
}
for (const part of ["sd-home-grid", "sd-chip", "sd-shortcut", "homeBoard"]) {
  if (!shellJs.includes(part) && !css.includes(part)) {
    errors.push(`l'accueil maison a perdu « ${part} »`);
  }
}
if (!/shouldShow: function/.test(shellJs) || !/isLoginPage\(\)/.test(shellJs)) {
  errors.push("l'accueil maison ne vérifie plus s'il doit s'afficher : il pourrait recouvrir la connexion");
}

if (!/stats: Stats,/.test(shellJs)) {
  errors.push("les statistiques d'écoute ne sont plus exposées (diagnostic, sonde, tests)");
}
if (!/STATS_KEY = "sd\.stats\.v1"/.test(shellJs)) {
  errors.push("la clé de stockage des statistiques a changé : les écoutes déjà enregistrées seraient perdues");
}
if (!/enabled: function \(\) \{\s*return !!Settings\.stats;/.test(shellJs)) {
  errors.push("les statistiques ne respectent plus leur interrupteur");
}
for (const needle of ["sd-stat-tiles", "sd-stat-chart", "sd-stat-bars", "sd-stat-bands", "sd-stat-chip"]) {
  if (!shellJs.includes(needle) || !css.includes(needle)) {
    errors.push(`le bloc de statistiques a perdu « ${needle} » (code ou feuille)`);
  }
}
if (!/summary: function/.test(shellJs) || !/streak: 0/.test(shellJs)) {
  errors.push("le calcul des statistiques a perdu une de ses mesures (résumé ou série)");
}

/* 2-ter-ter. Deux défauts qui ont coûté une version chacun, et qui ne se voient
   qu'à l'usage : l'écran d'accueil qui restait posé par-dessus le lecteur (il
   n'était réévalué que sur les mutations du `<body>`), et un appui d'onglet qui
   ne produisait rien quand le bouton de Spotify n'obéissait pas. */
if (!/welcomeObs\.observe\(document\.documentElement,\s*\{\s*childList:\s*true,\s*subtree:\s*true/.test(shellJs)) {
  errors.push("l'écran d'accueil n'est plus surveillé sur toute la page : il resterait posé par-dessus le lecteur");
}
if (!/location\.assign\(name === "search" \? "\/search" : "\/"\)/.test(shellJs)) {
  errors.push("un appui d'onglet n'est plus vérifié : un bouton inerte laisserait l'appui sans effet");
}
/* Le piège du lien de connexion : `a[href*="/login"]` compte aussi les liens de
   la coque, qui en porte plusieurs. L'écran d'accueil se rendait alors vrai
   **tout seul** sur toute page sans lecteur, et masquait la coque entière. Le
   calcul doit trier les nœuds qui sont à nous. */
if (!/function spotifyLoginLink\(\)/.test(shellJs) || !/spotifyLoginLink\(\)/.test(shellJs.replace(/function spotifyLoginLink\(\)/, ""))) {
  errors.push("le lien de connexion de Spotify n'est plus distingué des nôtres : l'écran d'accueil peut se rendre vrai tout seul");
}

/* 2-ter-quater. La feuille « tenir dans l'écran » : sans elle, mesuré dans les
   conditions de la WebView, la page fait 800 px de large dans un écran de 412
   (`débordement=388`) — texte rogné, page à faire glisser de côté. */
const fitCss = read("src/inject/05-original-fit.css");
if (!/^\s*\/\* =+\n\s+05 — Tenir dans l'écran/m.test(fitCss)) {
  errors.push("src/inject/05-original-fit.css : en-tête de provenance absent");
}
for (const rule of ["#main-view+div", "width:100vw!important", "--panel-gap:0!important"]) {
  if (!fitCss.includes(rule)) {
    errors.push(`la feuille « tenir dans l'écran » a perdu « ${rule} » : la page débordera de nouveau`);
  }
}
if (!/html\.sd-mobile \.sd-root /.test(fitCss) || /^\s*\*/m.test(fitCss)) {
  errors.push("la feuille d'origine n'est plus portée sous notre coque (elle viserait nos propres nœuds)");
}
/* Elle est **générée** depuis la feuille d'origine : le dit-elle, et la
   source est-elle intacte ? */
if (!/build-original-fit\.mjs/.test(fitCss)) {
  errors.push("la feuille « tenir dans l'écran » ne déclare plus son outil de génération");
}

/* 2-quater. Le mode livré par défaut. C'est une décision surveillée, et elle a
   changé de sens une fois, pour une raison **mesurée** (sonde `probe-playback`,
   run 36028586893) : le message « Lecture désactivée » — « Spotify ne
   fonctionnera pas si vous bloquez le contenu protégé, si votre navigateur
   n'est pas compatible… » — est un texte du **lecteur web mobile** de Spotify
   (`mwp.playback.error.protected.content`, paquet `mobile-web-player`). Servi à
   un agent de téléphone, ce lecteur ne lit rien pour un compte gratuit ; la page
   bureau, elle, lit — c'est celle que le code d'origine recevait. Le défaut est
   donc **la page bureau habillée par notre coque** (`MODE_INJECT`), et la page
   mobile reste proposée dans le sélecteur. */
const activity = read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
for (const stale of ["the two interfaces", "MODE_INJECT is the default"]) {
  if (activity.includes(stale)) errors.push(`MainActivity : commentaire périmé (« ${stale} »)`);
}
/* Le défaut est **notre coque**, demandée explicitement : « réutilise
   exactement notre UI qui était sur notre projet ». La 2.9.3 avait livré
   l'interface d'origine par défaut sur la foi d'une mesure de sonde ; cette
   mesure relevait en réalité l'**écran d'accueil de la coque**, qui ne se
   retirait jamais lorsqu'un lecteur se construisait dans un conteneur déjà en
   place, et masquait donc la coque entière. Corrigé (voir 2-ter-ter). */
if (!/MODE_DEFAULT\s*=\s*MODE_INJECT/.test(activity)) {
  errors.push("MainActivity : le mode par défaut n'est plus la coque SpotiDuck");
}
for (const wrong of ["MODE_NATIVE", "MODE_ORIGINAL"]) {
  if (new RegExp(`MODE_DEFAULT\\s*=\\s*${wrong}`).test(activity)) {
    errors.push(`MainActivity : le défaut est repassé sur ${wrong} — ce n'est plus notre interface`);
  }
}
/* …et le mode par défaut doit rester quittable **depuis lui-même**, sans
   réinstaller : c'est ce qui manquait à la 2.6.0. */
if (!/MODE_INJECT,\s*MODE_ORIGINAL,\s*MODE_NATIVE/.test(activity.replace(/\s+/g, " "))) {
  errors.push("MainActivity : le sélecteur d'interface ne propose plus les trois modes, défaut en tête");
}
/* L'identité « bureau » de la coque : agent annoncé **et** `navigator`
   cohérent (plateforme, client hints, greffons, GPU) — sinon Spotify voit un
   agent Windows doublé d'un navigateur Android, ce qu'il appelle « navigateur
   non compatible ». Et elle ne doit pas toucher à la géométrie : la coque met
   la page en page sur la largeur réelle du téléphone. */
const identitySource = "src/original/spotiduck-identity.js";
const identityAsset = read("android/app/src/main/assets/spotiduck-identity.js");
for (const needed of ["userAgentData", "getHighEntropyValues", '"Win32"', '"Windows"', '"x86"']) {
  if (!identityAsset.includes(needed)) errors.push(`l'identité bureau a perdu « ${needed} »`);
}
if (!identityAsset.includes(read(identitySource).trimStart().slice(0, 120))) {
  errors.push(`assets/spotiduck-identity.js ne vient pas de ${identitySource} — relancer \`npm run build\``);
}
const identityCode = stripComments(identityAsset);
for (const geometry of ["innerWidth", "innerHeight", "devicePixelRatio", "screen.", "window.screen"]) {
  if (identityCode.includes(geometry)) {
    errors.push(`l'identité bureau touche à la géométrie (${geometry}) : la coque serait cassée`);
  }
}
if (!/evaluateJavascript\(identityScript/.test(activity)) {
  errors.push("MainActivity : l'identité bureau n'est plus injectée avant la page");
}

/* Le blocage des publicités audio passe par `assets/silent.mp3` : la musique est
   servie en Ogg/AAC, les annonces en `audio/mpeg` — c'est ce qui distingue les
   deux. On vérifie donc que le fichier est là, que le code le sert, et surtout
   que `podz-content` / `gew4-spclient` (les serveurs de lecture) restent
   intouchables : les bloquer, c'est faire taire toutes les musiques. */
const adBlocker = read("android/app/src/main/java/com/spotiduck/app/AdBlocker.kt");
const silentAsset = "android/app/src/main/assets/silent.mp3";
try {
  const silent = readFileSync(join(root, silentAsset));
  if (silent.length < 8_000) errors.push(`${silentAsset} est trop petit pour être un MP3 de silence`);
} catch {
  errors.push(`${silentAsset} est absent — les publicités audio ne seraient plus remplacées`);
}
if (!/silent\.mp3/.test(adBlocker) || !/fun silentResponse/.test(adBlocker)) {
  errors.push("AdBlocker : le remplacement des publicités audio n'est plus en place");
}
if (!/podz-content\|gew4-spclient/.test(adBlocker)) {
  errors.push("AdBlocker : les serveurs de lecture ne sont plus exclus du blocage");
}
if (!/audio\/mpeg/.test(adBlocker)) {
  errors.push("AdBlocker : rien ne distingue plus une annonce audio d'une musique");
}
/* Kotlin : un `Log` sans import fait échouer la compilation (vécu). Le build
   n'est pas lancé ici, donc on regarde au moins ça pour chaque fichier. */
const kotlinFiles = readdirSync(join(root, "android/app/src/main/java/com/spotiduck/app"))
  .filter((f) => f.endsWith(".kt"));
for (const file of kotlinFiles) {
  const source = read(join("android/app/src/main/java/com/spotiduck/app", file));
  if (/\bLog\./.test(source) && !/^import android\.util\.Log$/m.test(source)) {
    errors.push(`${file} : utilise Log sans l'importer android.util.Log`);
  }
  /* Un nom importé deux fois : `Conflicting import` (vécu aussi, sur Intent). */
  const imports = [...source.matchAll(/^import\s+([\w.]+)$/gm)].map((m) => m[1]);
  const names = imports.map((i) => i.split(".").pop());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) errors.push(`${file} : nom(s) importé(s) deux fois — ${[...new Set(dupes)].join(", ")}`);
}
if (!/isAdAudio/.test(activity) || !/sniffContentType/.test(activity)) {
  errors.push("MainActivity : les publicités audio ne sont plus détectées avant blocage");
}

/* La session doit survivre à une mise à jour. Cinq choses le garantissent, et
   chacune peut disparaître sans que rien ne casse visiblement — jusqu'au jour où
   l'utilisateur doit se reconnecter :
     · les cookies ne sont **jamais** effacés (aucun `removeAllCookies`) ;
     · ils sont **écrits sur le disque** au bon moment : fin de page du lecteur,
       connexion détectée, mise en arrière-plan, arrêt, mémoire réclamée, arrêt
       du processus — la WebView le fait paresseusement, et une mise à jour tue
       le processus avant ;
     · l'écriture est **synchrone** (`commit`) : `apply()` écrit « plus tard », et
       « plus tard » n'arrive pas quand le paquet est mis à jour ;
     · la copie de secours est réinjectée **sans doublon** : deux cookies du même
       nom (une portée hôte, une portée `.spotify.com`) et le serveur en lit un
       au hasard — c'est ce qui fait répondre « e-mail ou mot de passe
       incorrect » à une connexion par ailleurs valable ;
     · une copie qui ne ramène pas la session est **jetée** : réinjectée à chaque
       lancement, elle rendrait la panne permanente.
   Enfin, un lien de connexion doit exister : les boutons sociaux peuvent être
   refusés par Google dans une WebView, et sans le bouton « e-mail et mot de
   passe » la page de connexion de Spotify n'offre que des impasses. */
if (/removeAllCookies|removeSessionCookies/.test(activity)) {
  errors.push("MainActivity : la session est effacée (removeAllCookies) — plus rien ne survivra à une mise à jour");
}
for (const need of ["flushCookies", "saveSession", "restoreSession", "KEY_SESSION", "invalidateSession", "expireCookie"]) {
  if (!new RegExp(need).test(activity)) errors.push(`MainActivity : ${need} a disparu — la session ne survivra plus à une mise à jour`);
}
if (!/putString\(KEY_SESSION[\s\S]{0,400}?\.commit\(\)/.test(activity)) {
  errors.push("MainActivity : la copie de session n'est plus écrite de façon synchrone (commit) — une mise à jour la tuera");
}
if (!/hasSessionCookie\(\)[\s\S]{0,80}?return false/.test(activity)) {
  errors.push("MainActivity : la session restaurée peut désormais écraser une session vivante");
}
if (!/sessionRestored[\s\S]{0,400}?invalidateSession/.test(activity)) {
  errors.push("MainActivity : une copie de secours qui ne ramène rien n'est plus jetée — elle empoisonnera les connexions suivantes");
}
if (!/restoreSession\(\)[\s\S]{0,3000}?loadUrl\(/.test(activity)) {
  errors.push("MainActivity : la session restaurée n'est plus remise avant le chargement de la page");
}
if (!/override fun onPause[\s\S]{0,300}?saveSession/.test(activity)) {
  errors.push("MainActivity : la session n'est plus écrite à la mise en arrière-plan");
}
if (!/override fun onStop[\s\S]{0,300}?saveSession/.test(activity)) {
  errors.push("MainActivity : la copie de secours n'est plus prise à l'arrêt");
}
if (!/override fun onTrimMemory[\s\S]{0,300}?saveSession/.test(activity)) {
  errors.push("MainActivity : la session n'est plus écrite quand le système réclame de la mémoire");
}
if (!/SPOTIFY_SESSION_HOST[\s\S]{0,300}?saveSession/.test(activity)) {
  errors.push("MainActivity : la session n'est plus enregistrée en fin de chargement du lecteur");
}
/* Le seul juge de l'état de connexion, c'est la page : le cookie dit qu'une
   session a existé, la page dit si elle vaut encore quelque chose. */
if (!/fun onLoginState\(state: String\)/.test(activity) || !/fun loginState\(state: String\?\)/.test(bridgeKt) ||
    !/onLoginState\(clean\)/.test(bridgeKt)) {
  errors.push("Bridge/MainActivity : l'état de connexion annoncé par la page n'est plus écouté");
}
if (!/resetLoginPageState/.test(activity) || !/csrf/.test(activity)) {
  errors.push("MainActivity : le nettoyage de l'état du formulaire de connexion a disparu");
}

/* Les fonctionnalités que SpotiDuck annonce : blocage de publicité (fait),
   contrôles média et écran verrouillé (fait), **widget**, **Android Auto**,
   service d'arrière-plan. Un widget ou un Auto qui disparaîtrait ne casserait
   rien visiblement — d'où ces vérifications. */
const appManifest = read("android/app/src/main/AndroidManifest.xml");
const service = read("android/app/src/main/java/com/spotiduck/app/PlaybackService.kt");
const widget = read("android/app/src/main/java/com/spotiduck/app/PlayerWidget.kt");
if (!/PlayerWidget/.test(appManifest) || !/appwidget\.action\.APPWIDGET_UPDATE/.test(appManifest)) {
  errors.push("AndroidManifest : le widget n'est plus déclaré");
}
for (const res of [
  "android/app/src/main/res/layout/widget_player.xml",
  "android/app/src/main/res/xml/widget_player_info.xml",
]) {
  if (!existsSync(join(root, res))) errors.push(`le widget a perdu ${res}`);
}
if (!/class PlayerWidget : AppWidgetProvider/.test(widget) || !/PlaybackService\.ACTION_/.test(widget)) {
  errors.push("PlayerWidget : le widget n'est plus un widget, ou n'utilise plus les actions du service");
}
if (!/MediaBrowserServiceCompat/.test(service) || !/onGetRoot/.test(service) || !/sessionToken = session\.sessionToken/.test(service)) {
  errors.push("PlaybackService : Android Auto ne trouverait plus la lecture (plus de service de navigation média)");
}
if (!/android\.media\.browse\.MediaBrowserService/.test(appManifest) || !/automotive_app_desc/.test(appManifest)) {
  errors.push("AndroidManifest : Android Auto n'est plus déclaré");
}
if (!/PlayerWidget\.refresh/.test(service)) {
  errors.push("PlaybackService : le widget n'est plus redessiné quand la lecture change");
}

const nativeAsset = read("src/inject/native-mode.js");
if (!/showUiChooser/.test(nativeAsset)) {
  errors.push("native-mode.js : plus rien n'ouvre le sélecteur d'interface (appui long)");
}
/* Le mode livré affiche la page de Spotify telle quelle, donc c'est à nous de :
   (a) lui donner une zone de rendu à l'intérieur des barres système — en plein
       écran sous la barre d'état, sa barre du haut est à moitié dessous et ses
       boutons tombent dans la zone de la barre d'état ;
   (b) supprimer le bandeau « ouvrir dans l'application », que Spotify renomme
       régulièrement (d'où un balayage par texte, pas seulement par attribut). */
const insets = activity.replace(/\s+/g, " ");
if (!/uiMode == MODE_NATIVE[\s\S]{0,400}root\.setPadding\(bars\.left, bars\.top/.test(insets)) {
  errors.push("MainActivity : le mode livré ne réserve plus la place des barres système");
}
if (!/data-sd-appprompt/.test(nativeAsset) || !/APP_PROMPT_TEXT/.test(nativeAsset)) {
  errors.push("native-mode.js : le bandeau « ouvrir dans l'application » n'est plus traqué");
}
if (!/allow_password=1/.test(nativeAsset) || !/sd-login-help/.test(nativeAsset)) {
  errors.push("native-mode.js : plus rien n'offre la connexion par e-mail sur la page de connexion");
}
/* « Continuer avec Google » ouvre une **vraie fenêtre** : la page appelle
   `window.open(...)` et attend que cette fenêtre lui rende la main par
   `window.opener` (mesuré en CI : l'adresse ouverte est
   `accounts.google.com/v3/signin/identifier?...redirect_uri=accounts.spotify.com/login/google/redirect`).
   Trois choses doivent rester, et les trois ont été cassées une fois :
     · la WebView accepte les fenêtres (`setSupportMultipleWindows(true)`) —
       sans ça, `window.open` ne fait rien du tout : bouton mort ;
     · elle en ouvre une **vraie** (transport de fenêtre + `onCloseWindow`) —
       charger l'adresse dans la vue courante rompt le lien entre les deux pages
       et le retour de connexion n'arrive jamais ;
     · le script de la page ne **remplace plus** `window.open` : le shim de la
       2.8.1 faisait exactement ça, et perdait `window.opener`. */
if (!/setSupportMultipleWindows\(true\)/.test(activity) || !/onCreateWindow/.test(activity) || !/WebViewTransport/.test(activity)) {
  errors.push("MainActivity : les fenêtres de connexion ne sont plus de vraies fenêtres");
}
if (!/onCloseWindow/.test(activity)) {
  errors.push("MainActivity : une fenêtre de connexion fermée par la page resterait à l'écran");
}
if (/window\.open = function/.test(nativeAsset) || /realOpen/.test(nativeAsset)) {
  errors.push("native-mode.js : `window.open` est de nouveau remplacé — le lien entre la page et sa fenêtre de connexion est rompu");
}
if (!/__sdNavigate/.test(nativeAsset)) {
  errors.push("native-mode.js : `__sdNavigate` a disparu (les liens internes et la sonde s'en servent)");
}
if (!/REFUSAL/.test(activity) || !/login_blocked_action/.test(read("android/app/src/main/res/values/strings.xml"))) {
  errors.push("MainActivity : le refus de Google n'est plus expliqué à l'utilisateur (ni la porte e-mail proposée)");
}
if (!/decodeJsString/.test(activity)) {
  errors.push("MainActivity : le texte lu dans la page n'est plus décodé (accents JSON) — les refus en français passeraient inaperçus");
}
/* La page de connexion de Spotify utilise reCAPTCHA (25 occurrences dans ses
   scripts, mesuré) : une liste de filtres qui le bloque transforme le formulaire
   en « e-mail ou mot de passe incorrect ». Ces hôtes ne doivent donc jamais
   pouvoir être bloqués, quoi qu'ajoute la liste. */
const blockerKt = read("android/app/src/main/java/com/spotiduck/app/AdBlocker.kt");
const neverBlock = (blockerKt.match(/private val NEVER_BLOCK[\s\S]{0,400}?\)/) || [""])[0];
if (!/recaptcha/.test(neverBlock) || !/accounts/.test(neverBlock) || !/spclient/.test(neverBlock)) {
  errors.push("AdBlocker : reCAPTCHA, la connexion Spotify ou les serveurs de lecture peuvent de nouveau être bloqués");
}
if (!/typeCache/.test(blockerKt)) {
  errors.push("AdBlocker : le type de contenu n'est plus mémorisé — chaque publicité repayait une requête (lecture qui rame)");
}
if (!/connectTimeout = 1200/.test(blockerKt)) {
  errors.push("AdBlocker : le reniflage attend de nouveau 3,5 s — la lecture s'arrête avant la publicité");
}

/* aapt2 refuse une apostrophe non échappée dans une chaîne (`unescaped apostrophe
   in string`) : le fichier de ressources ne compile plus du tout, et la CI — le
   seul compilateur disponible ici — le découvre après trois minutes. Le test est
   donc fait ici, en une seconde. */
const stringsXml = read("android/app/src/main/res/values/strings.xml");
for (const m of stringsXml.matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) {
  if (/[^\\]'/.test(m[2])) {
    errors.push(`strings.xml : « ${m[1]} » contient une apostrophe non échappée — aapt2 refuse le fichier (\')`);
  }
}

if (!/input\[type='password'\]/.test(nativeAsset)) {
  errors.push("native-mode.js : le lien de connexion n'est plus conditionné à l'absence du formulaire");
}
/* …et les invitations à l'abonnement, encarts **et** bouton de la barre du bas. */
if (!/data-sd-premium/.test(nativeAsset) || !/PREMIUM_TEXT/.test(nativeAsset)) {
  errors.push("native-mode.js : les invitations à l'abonnement ne sont plus traquées");
}
/* Garde-fou payé une fois : un onglet de la barre du bas ne doit **jamais**
   disparaître parce que son lien est un `spotify:` (la barre en est pleine :
   `spotify:collection` est l'onglet Bibliothèque). Un lien `spotify:` ne compte
   comme invite que si ce qui l'entoure le dit. */
if (!/ancestorInvite/.test(nativeAsset) || /APP_PROMPT_LINK = \/\^\(spotify:/.test(nativeAsset)) {
  errors.push("native-mode.js : un lien `spotify:` suffit de nouveau à masquer un élément");
}
/* Les **fenêtres** d'offre : celle du démarrage (« à 0 € ») porte une croix, deux
   boutons et un prix qui ne ressemble à aucun motif d'attribut. Elle part en
   entier, et elle est reconnue par ce qu'elle affiche. */
if (!/overlayAncestor/.test(nativeAsset) || !/MONEY_TEXT/.test(nativeAsset) || !/data-sd-premium-dialog/.test(nativeAsset)) {
  errors.push("native-mode.js : les fenêtres d'offre (prix affiché) ne sont plus reconnues");
}
/* La veille des onglets du bas : un appui qui ne produit rien doit être repris
   par l'application, sinon « le bouton Bibliothèque ne fait rien ». */
if (!/watchNav/.test(nativeAsset) || !/routeForNav/.test(nativeAsset) || !/__sdNavRouteFor/.test(nativeAsset)) {
  errors.push("native-mode.js : les onglets de la barre du bas ne sont plus surveillés");
}
if (!/__sdNavTap/.test(activity)) {
  errors.push("MainActivity : la sonde n'affiche plus le dernier onglet touché");
}
if (!/function inBar/.test(nativeAsset)) {
  errors.push("native-mode.js : les barres de navigation ne sont plus protégées");
}
/* Le mode « natif » ne doit être retenu que s'il a été choisi explicitement. */
if (!/KEY_UI_MODE_CHOSEN/.test(activity)) {
  errors.push("MainActivity : le mode enregistré n'est plus distingué d'un choix explicite");
}
/* …et un ancien choix enregistré (par une version dont le défaut était autre)
   ne doit pas être confondu avec un choix volontaire : c'est ce que fait le
   compteur de révision. */
if (!/KEY_UI_MODE_REV/.test(activity) || !/UI_MODE_REV\s*=\s*\d+/.test(activity)) {
  errors.push("MainActivity : la révision du mode par défaut n'est plus enregistrée");
}

/* 2-quater-bis. L'interface d'origine est **le code d'origine**, pas une
   réécriture : le script livré doit venir de `src/original/`, être injecté en
   mode « original », porter l'interface intacte et être servi à un agent
   bureau (c'est la page desktop de Spotify qu'il habille). Un écrasement par
   une version maison, ou une interface servie à un agent mobile, rendrait
   l'affichage au mieux bancal, au pire vide — sans aucun message. */
const originalSource = "src/original/spotiduck-original.js";
const originalScript = read(originalSource);
const originalAsset = read("android/app/src/main/assets/spotiduck-original.js");
if (!originalAsset.includes("window.firstFuck") || !originalAsset.includes("window.actPlayPause")) {
  errors.push("l'interface d'origine livrée ne contient plus le script d'origine");
}
if (!originalAsset.includes(originalScript.trimStart().slice(0, 200))) {
  errors.push(`assets/spotiduck-original.js ne vient pas de ${originalSource} — relancer \`npm run build\``);
}
/* La feuille d'origine est *la* définition de l'affichage : 6 001 caractères,
   md5 `13de5546d0…`. Si elle change, l'affichage change. */
const origCssRaw = (originalScript.match(/textContent\s*=\s*"((?:[^"\\]|\\.)*)"/) || ["", ""])[1];
let origCss = "";
try {
  origCss = JSON.parse('"' + origCssRaw + '"');
} catch {
  errors.push(`${originalSource} : la feuille de style d'origine est illisible`);
}
const cssMd5 = createHash("md5").update(origCss).digest("hex");
if (origCss.length !== 6001 || !cssMd5.startsWith("13de5546d0")) {
  errors.push(
    `l'affichage d'origine a changé : feuille de ${origCss.length} car. (md5 ${cssMd5.slice(0, 10)}), ` +
      "attendu 6001 car. (md5 13de5546d0)"
  );
}
if (!/MODE_ORIGINAL/.test(activity) || !/scriptFor\(/.test(activity)) {
  errors.push("MainActivity : le script d'origine n'est plus chargé selon le mode choisi");
}
/* La règle **quelle que soit sa forme** : ce que l'agent décide est vérifié au
   groupe 10 (qui lit la fonction, pas une écriture précise). Ici on vérifie
   seulement que le choix existe encore — un garde-fou collé à une seule
   formulation meurt à la première réécriture, et c'est exactement comme ça que
   la 2.11.19 a pu passer avec l'agent de bureau sur la coque. */
if (!/private fun userAgentFor\(/.test(activity) || !/DESKTOP_UA/.test(activity) || !/MOBILE_UA/.test(activity)) {
  errors.push("MainActivity : l'agent servi à la page n'est plus choisi selon le mode (la règle attendue est vérifiée au groupe 10)");
}
/* L'empreinte de navigateur : injectée au chargement, elle décide de la mise en
   page. Trois valeurs suffisent à la reconnaître, et l'application doit
   l'injecter en mode d'origine. */
const fingerprint = read("src/original/spotiduck-fingerprint.js");
for (const m of ["return 1920;", "return 1080;", "return 978;"]) {
  if (!fingerprint.includes(m)) errors.push(`l'empreinte d'origine a perdu « ${m} »`);
}
if (!/originalFingerprint/.test(activity) || !/onPageStarted/.test(activity)) {
  errors.push("MainActivity : l'empreinte d'origine n'est plus injectée au chargement");
}
if (!existsSync(join(root, "android/app/src/main/assets/original-fingerprint.js"))) {
  errors.push("assets/original-fingerprint.js est absent — relancer `npm run build`");
}

/* Les fonctions d'origine que l'application appelle réellement. */
for (const fn of ["window.actPlayPause", "window.actSkipForward", "window.actSkipBack", "window.actSeek", "window.updMedia"]) {
  if (!originalScript.includes(fn)) errors.push(`${originalSource} : ${fn} est introuvable`);
}

/* 2-quinquies. Le viewport. C'est la cause du « l'affichage n'est pas adapté à
   mon téléphone » : sans `<meta name="viewport">`, la WebView met en page sur
   980 px et toute la feuille de style vise un écran trois fois trop large. */
if (!/loadWithOverviewMode\s*=\s*true/.test(activity)) {
  errors.push("MainActivity : loadWithOverviewMode n'est plus activé");
}
/* La permission « contenu protégé » : c'est par elle que la WebView ouvre
   Widevine, son module de déchiffrement. Sans elle Android **refuse par
   défaut** (une WebView qui n'implémente pas `onPermissionRequest` refuse en
   silence), Spotify ne trouve plus de module pour ses flux chiffrés et remplace
   le lecteur par « La lecture de contenus protégés est désactivée — Consultez le
   site d'aide Spotify » : capture du 24/09, et « y a rien qui va » de
   l'utilisateur. Ce n'était pas l'affichage, c'était le moteur de lecture. */
if (!/onPermissionRequest/.test(activity) || !/RESOURCE_PROTECTED_MEDIA_ID/.test(activity)) {
  errors.push(
    "MainActivity : la permission « contenu protégé » n'est plus accordée — Spotify afficherait « La lecture de contenus protégés est désactivée »"
  );
}
if (!/request\.grant\(granted\.toTypedArray\(\)\)|request\.grant\(/.test(activity)) {
  errors.push("MainActivity : la permission « contenu protégé » n'est plus accordée (request.grant absent)");
}
/* …et on n'accorde rien d'autre : caméra, micro, position restent refusés. */
if (!/request\.deny\(\)/.test(activity)) {
  errors.push("MainActivity : les autres permissions ne sont plus refusées explicitement");
}
if (!/VIEWPORT_META_JS/.test(activity) || !/device-width/.test(activity)) {
  errors.push("MainActivity : le meta viewport n'est plus forcé");
}
if (!/width=device-width/.test(runtime)) {
  errors.push("la couche injectée ne pose plus le meta viewport");
}
if (!/width=device-width/.test(read("src/inject/native-mode.js"))) {
  errors.push("le mode bêta ne pose plus le meta viewport");
}

/* 2-sexies. La disposition « application mobile » : les étagères de l'accueil
   défilent horizontalement (deux tuiles visibles), elles ne forment pas une
   grille verticale. C'était le dernier écart visible avec l'application. */
const metrics = read("src/inject/60-metrics.css");
if (!/--m-tile:\s*calc\(/.test(metrics)) {
  errors.push("60-metrics.css : plus de variable de largeur de tuile (--m-tile)");
}
if (!/component-shelf"\]\s*\[data-testid="grid-container"\][\s\S]{0,400}overflow-x:\s*auto/.test(metrics)) {
  errors.push("60-metrics.css : les étagères ne défilent plus horizontalement");
}

/* 3. Ressources Kotlin + assets ------------------------------------------- */
const strings = read("android/app/src/main/res/values/strings.xml");
const definedStrings = new Set([...strings.matchAll(/name="([^"]+)"/g)].map((m) => m[1]));
const kotlinSources = readdirSync(join(root, "android/app/src/main/java/com/spotiduck/app"))
  .filter((f) => f.endsWith(".kt"))
  .map((f) => read(join("android/app/src/main/java/com/spotiduck/app", f)))
  .join("\n");
for (const m of kotlinSources.matchAll(/(?<!android\.)R\.string\.(\w+)/g)) {
  if (!definedStrings.has(m[1])) errors.push(`R.string.${m[1]} est utilisé mais absent de strings.xml`);
}
for (const m of kotlinSources.matchAll(/assets\.open\(\s*"([^"]+)"/g)) {
  if (!existsSync(join(root, "android/app/src/main/assets", m[1]))) {
    errors.push(`assets/${m[1]} est ouvert par le code mais n'existe pas`);
  }
}
/* Les scripts sont maintenant lus par un helper (`readAsset("…")`) : un nom
   mal orthographié donnerait un script vide, donc une page sans interface. */
for (const m of kotlinSources.matchAll(/readAsset\(\s*"([^"]+)"\)/g)) {
  if (!existsSync(join(root, "android/app/src/main/assets", m[1]))) {
    errors.push(`assets/${m[1]} est chargé par le code mais n'existe pas`);
  }
}
/* Les trois interfaces doivent être injectées selon le mode choisi. */
for (const mode of ["original", "native", "inject"]) {
  if (!new RegExp(`const val MODE_${mode.toUpperCase()}`).test(activity)) {
    errors.push(`MainActivity : la constante MODE_${mode.toUpperCase()} a disparu`);
  }
}
if (!/MODE_ORIGINAL\s*->\s*originalScript/.test(activity.replace(/\s+/g, " "))) {
  errors.push("MainActivity : le mode d'origine n'injecte plus le script d'origine");
}
/* Les fichiers déclarés dans le manifeste doivent exister aussi. */
const manifest = read("android/app/src/main/AndroidManifest.xml");
for (const m of manifest.matchAll(/android:name="\.(\w+)"/g)) {
  const path = join(root, `android/app/src/main/java/com/spotiduck/app/${m[1]}.kt`);
  if (!existsSync(path)) errors.push(`AndroidManifest déclare .${m[1]} mais ${m[1]}.kt est absent`);
}

/* 3. Le diagnostic, la fausse alarme et le chemin `/intl-fr/` -----------------
   Trois défauts mesurés sur le téléphone le 25/09, tous les trois silencieux :
   un diagnostic qui annonçait « SpotiDuck 2.9.0 » (numéro de version codé en
   dur, jamais mis à jour), une alarme « la page n'a rien affiché » déclenchée
   sur une page qui avait 2 756 px de contenu, et un accueil maison qui ne
   reconnaissait pas `/intl-fr/` — le chemin que Spotify sert en France. */
const buildTool = read("tools/build.mjs");
if (!/window\.__SD_VERSION__\s*=/.test(buildTool) || !/window\.__SD_VERSION__/.test(shellJs)) {
  errors.push("la version de la coque n'est plus estampillée à la compilation : le diagnostic mentirait de nouveau");
}
if (/var VERSION = "\d/.test(stripComments(runtime))) {
  errors.push("la version de la coque est redevenue une constante écrite à la main : elle ne suivra plus les livraisons");
}
if (!/appVersion\(\): String/.test(activity) || !/@JavascriptInterface\s+fun version\(\)/.test(bridgeKt)) {
  errors.push("l'application ne transmet plus sa version installée : impossible de savoir ce qui tourne chez l'utilisateur");
}
if (!/rendered: function \(anchor\)/.test(stripComments(runtime))) {
  errors.push("l'état de contenu ne mesure plus ce qui est rendu : des pages pleines seront déclarées vides");
}
if (/rect\.width < 40|r\.width < 200/.test(stripComments(runtime) + stripComments(activity))) {
  errors.push("un seuil de largeur décide de nouveau si la page est vide (c'est la fausse alarme du 25/09)");
}
if (!/if \(r\.text < 20 && r\.els === 0\) return \{ ok: false/.test(stripComments(runtime))) {
  errors.push("l'alarme de page vide ne se déclenche plus sur le bon critère (rien de rendu du tout)");
}
/* Le motif est écrit en clair : le tester par une chaîne évite un festival
   d'échappements (le premier essai de ce garde-fou ne testait rien). */
const intlHomePattern = "(?:intl-)?[a-z]{2}(?:-[a-z]{2})?$/i";
if (!stripComments(runtime).includes(intlHomePattern)) {
  errors.push("le chemin d'accueil ne reconnaît plus /intl-fr : l'accueil maison ne s'afficherait pas là où l'utilisateur arrive");
}
const probeTool = read("tools/probe-coop.mjs");
if (!/label: "page-fr", url: "https:\/\/open\.spotify\.com\/intl-fr\/"/.test(probeTool)) {
  errors.push("la sonde ne mesure plus la page /intl-fr/ du téléphone (celle de la capture du 25/09)");
}
/* 2-ter-quinquies. La bibliothèque maison. Signalé le 25/09 : « sur l'onglet
   bibliothèque, je ne vois aucune de mes playlists ». L'onglet ne faisait
   qu'afficher la barre latérale de Spotify ; notre page lit la bibliothèque du
   compte à la source et l'affiche elle-même. Quatre choses ne doivent pas
   régresser : la lecture par l'API avec le jeton de la page, les cinq sources,
   le repli (ne **jamais** masquer la barre latérale sans avoir de quoi la
   remplacer) et l'interrupteur. */
const libraryCode = stripComments(runtime);

/* 2-ter-sexies. Les durées et le bas de l'écran — la capture du 25/09.
   « 56095 h 50 » pour un seul titre écouté : l'unité du curseur de Spotify
   (millisecondes sur cette page-là) était supposée, et multipliée par 1000.
   Et sous la page, une bande noire : la place du mini-lecteur restait réservée
   alors qu'il n'était pas affiché. */
if (!/unitFactor: function/.test(libraryCode) || !/calibrate: function/.test(libraryCode)) {
  errors.push("l'unité du curseur de progression n'est plus mesurée : les durées peuvent redevenir 1000 fois trop grandes");
}
/* Le corps de `read()` et de `seek()` : la seule façon de vérifier que **tous**
   les passages par le curseur passent bien par la conversion mesurée, au lieu
   de multiplier ou diviser « à la main » à un endroit et pas à un autre (c'est
   exactement ainsi que la lecture était juste et l'écriture fausse). */
/* Un nom de fonction, vérifié **jusqu'à sa parenthèse** : `includes("function
   mediaEl")` répondrait encore oui après un renommage en `mediaElAbsente`, et
   un garde-fou qui ne tombe pas quand on renomme la fonction n'en est pas un. */
const hasFn = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped + "\\s*\\(").test(text);
};

const bodyOf = (name) => {
  const at = libraryCode.indexOf(name);
  if (at < 0) return "";
  const open = libraryCode.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < libraryCode.length; i++) {
    if (libraryCode[i] === "{") depth++;
    else if (libraryCode[i] === "}") {
      depth--;
      if (depth === 0) return libraryCode.slice(open, i + 1);
    }
  }
  return "";
};
/* `dur * 1000` vise **la** conversion à la main du curseur ; les bornes écrites
   au pluriel (« mdur », « adur ») sont la lecture de l'élément qui joue, et ne
   sont pas le même geste — d'où la frontière de mot. */
const readBody = bodyOf("read: function");
const seekBody = bodyOf("seek: function");
if (
  !/this\.ticksToMs\(dur\)/.test(readBody) ||
  !/this\.ticksToMs\(pos\)/.test(readBody) ||
  /(^|[^\w])dur \* 1000/.test(readBody) ||
  /(^|[^\w])pos \* 1000/.test(readBody)
) {
  errors.push("la lecture de la position ne passe plus par l'unité mesurée (conversion à la main dans Spotify.read())");
}
const actionsSeekBody = bodyOf("seek: function (ms) {\n      var target");
if (!/this\.msToTicks\(ms\)/.test(seekBody)) {
  errors.push("le déplacement du curseur n'utilise plus la graduation lue : il viserait la mauvaise position sur un lecteur en millisecondes");
}
if (!/Spotify\.ticksToMs\(input\.value\)/.test(actionsSeekBody)) {
  errors.push("la vérification après un déplacement du curseur relit la position sans la conversion mesurée");
}
if (!/this\.blame\(\)/.test(actionsSeekBody) || !/this\.settle\(300\)/.test(actionsSeekBody)) {
  errors.push("un déplacement du curseur qui échoue ne le dit plus ni au diagnostic ni au doigt");
}
if (!/setTimeout\(function \(\) \{[\s\S]{0,400}\}, 400\)/.test(actionsSeekBody)) {
  errors.push("le curseur n'attend plus la confirmation de Spotify : la barre de progression repartirait en arrière après un saut");
}
if (!/var value = this\.msToTicks\(ms\);/.test(seekBody) || /var value = /.test(seekBody.replace(/var value = this\.msToTicks\(ms\);/, ""))) {
  errors.push("le déplacement du curseur recalcule la valeur à la main au lieu d'utiliser la conversion unique");
}
if (!/State\.anchorPos = Spotify\.ticksToMs\(input\.value\)/.test(libraryCode)) {
  errors.push("l'ancre posée par le glisser du curseur ne lit plus la position dans l'unité mesurée");
}
if (/addEventListener\(\s*"input"\s*,\s*function \(e\)/.test(libraryCode)) {
  errors.push("le glisser du curseur réécoute encore un <input> par copie : la mise à jour du curseur se fait à l'aveugle");
}
if (!/maxTicks: function/.test(libraryCode) || !/var max = this\.maxTicks\(\);/.test(seekBody)) {
  errors.push("la graduation du curseur n'a plus de borne de repli : un curseur sans `max` rendrait toute recherche impossible");
}
if (!/return known > 0 \? this\.msToTicks\(known\) : 0;/.test(libraryCode)) {
  errors.push("la borne de repli du curseur ne se convertit plus dans l'unité mesurée");
}
if (!/plausible: function/.test(libraryCode) || !/MAX_SECONDS: 12 \* 3600/.test(libraryCode)) {
  errors.push("les durées enregistrées ne sont plus contrôlées : une valeur absurde s'afficherait telle quelle");
}
if (!/d: this\.plausible\(durationSec\)/.test(libraryCode)) {
  errors.push("l'enregistrement d'une écoute ne contrôle plus la durée");
}
/* **L'écoute se mesure, elle ne se déduit pas.** Signalé le 25/09 : « Les
   statistiques sont pas bonne il me semble. Rends les statistiques plus
   compréhensible ». Avant, dès qu'un titre apparaissait, on inscrivait la durée
   annoncée par la page : un titre survolé dix secondes comptait quatre minutes.
   Ce qui doit rester : le suivi de l'avancement du lecteur, le seuil des dix
   secondes, la distinction mesuré/estimé, et **aucune** durée inventée. */
if (!/tick: function \(state, nowMs\)/.test(libraryCode) || !/flush: function \(nowMs\)/.test(libraryCode)) {
  errors.push("les statistiques ne mesurent plus l'écoute (ni `tick` ni `flush`) : les durées redeviendraient celles annoncées par la page");
}
if (!/Stats\.tick\(State, Date\.now\(\)\)/.test(libraryCode) || !/Stats\.tick\(s\)/.test(libraryCode)) {
  errors.push("la mesure de l'écoute n'est plus alimentée par le lecteur : les statistiques ne bougeraient plus");
}
if (/Math\.round\(\(s\.duration \|\| 0\) \/ 1000\)/.test(libraryCode)) {
  errors.push("l'écoute est de nouveau enregistrée à partir de la durée annoncée du titre (un titre survolé compterait sa durée entière)");
}
if (!/STATS_MIN_SEC = 10/.test(libraryCode) || !/s\.sec >= STATS_MIN_SEC/.test(libraryCode)) {
  errors.push("le seuil des dix secondes a disparu : un survol compterait comme une écoute");
}
if (!/sec = e\.d > 0 \? e\.d : 0;/.test(libraryCode) || /STATS_DEFAULT_SEC/.test(libraryCode)) {
  errors.push("une durée est de nouveau inventée quand la page ne l'annonce pas (c'est ce qui produisait « 56095 h »)");
}
if (!/m: 1,/.test(libraryCode) || !/sum\.measured \+= sec/.test(libraryCode) || !/sum\.estimated \+= sec/.test(libraryCode)) {
  errors.push("le temps mesuré et le temps estimé ne sont plus distingués : la page ne peut plus dire d'où vient son chiffre");
}
if (/sum\.bands\.morning\+\+/.test(libraryCode)) {
  errors.push("les moments de la journée se comptent de nouveau en écoutes alors que le reste de la page est en temps : les chiffres ne sont plus comparables");
}
/* La page de statistiques doit rester lisible : des durées en tête, chaque
   nombre expliqué, et une note qui dit comment le temps est obtenu. */
for (const needle of ["sd-stat-lead", "sd-stat-hint", "sd-stat-note", "statsNoteMeasure", "statsNoteEstimate"]) {
  if (!libraryCode.includes(needle)) {
    errors.push(`la page de statistiques a perdu « ${needle} » : elle redeviendrait une liste de nombres sans unité`);
  }
}
if (!/plays: function \(n\)/.test(libraryCode) || !/statTile: function/.test(libraryCode) || !/statBars: function/.test(libraryCode)) {
  errors.push("les statistiques ne savent plus écrire « N écoutes », ni expliquer une tuile, ni comparer des barres");
}
if (!/dayLabel: function/.test(libraryCode)) {
  errors.push("la date de départ des statistiques n'est plus lisible");
}
for (const needle of ["sd-stat-lead", "sd-stat-hint", "sd-stat-note"]) {
  if (!css.includes(needle)) {
    errors.push(`la feuille de l'accueil n'habille plus « ${needle} » : l'élément serait invisible`);
  }
}

/* **Le lecteur ne disparaît pas.** Signalé le 25/09 : « le lecteur disparaît
   quand on scroll vers le bas ». La barre de lecture de Spotify quitte l'arbre
   pendant un défilement ; la présence du mini-lecteur ne doit donc plus dépendre
   d'une lecture instantanée. */
if (!/html\.classList\.add\("sd-mini-on"\)/.test(libraryCode)) {
  errors.push("le mini-lecteur n'est plus affiché en permanence : il peut de nouveau s'effacer (deux fois signalé)");
}
if (!/Spotify\.seen = Spotify\.seen \|\|/.test(libraryCode)) {
  errors.push("le lecteur n'est plus retenu quand il a été vu une fois");
}
if (!/sd-mini-signed-out/.test(libraryCode)) {
  errors.push("le mini-lecteur ne dit plus qu'une session est fermée : le bas de l'écran resterait muet");
}
if (!/document\.addEventListener\(\s*"scroll"/.test(libraryCode)) {
  errors.push("aucun repeint au défilement : la coque ne corrige plus ce que Spotify efface pendant qu'on fait défiler");
}

/* **L'API est atteinte.** La capture du 25/09 : la page de bibliothèque
   affichait « Votre bibliothèque n'a pas répondu pour l'instant » alors que le
   jeton était là — le `fetch` du navigateur vers `api.spotify.com` est refusé
   par le contrôle d'accès (CORS). La voie native (`AndBridge.nFetch`) est celle
   de l'application d'origine pour ses appels de lecture : hors navigateur, donc
   sans contrôle d'accès. */
if (!/throughBridge: function/.test(libraryCode) || !/Bridge\.call\(\s*"nFetch"/.test(libraryCode)) {
  errors.push("les appels à l'API ne passent plus par le pont natif : la bibliothèque resterait vide sur le téléphone");
}
if (!/return Net\.get\(path\);/.test(libraryCode)) {
  errors.push("la bibliothèque n'utilise plus la voie d'accès aux API (pont natif, puis navigateur)");
}
if (!/Net\.get\("\/me\/player\/recently-played\?limit=50"\)/.test(libraryCode)) {
  errors.push("l'historique d'écoute ne passe plus par la voie d'accès aux API");
}
if (!/hasBridge: function/.test(libraryCode) || !/throughFetch: function/.test(libraryCode)) {
  errors.push("la voie de repli (navigateur) a disparu : plus rien ne fonctionnerait sans pont");
}
/* Le pont natif répond de façon **bloquante** : cinq requêtes lancées ensemble
   gèleraient l'écran le temps qu'elles aboutissent toutes. La bibliothèque les
   enchaîne donc une par une, et s'arrête à la première panne franche. */
if (!/var step = function \(index\)/.test(libraryCode) || !/step\(index \+ 1\)/.test(libraryCode)) {
  errors.push("la bibliothèque relance ses cinq requêtes d'un coup : l'écran se figerait le temps du réseau (le pont natif est bloquant)");
}
if (/Promise\.all\(\[\s*\n\s*this\.get\(/.test(libraryCode)) {
  errors.push("les cinq sources de la bibliothèque repartent en parallèle, alors que chaque appel natif bloque le fil JavaScript");
}
if (!/!data &&[\s\S]{0,120}index === 0[\s\S]{0,200}Net\.status === 0[\s\S]{0,200}Net\.status === 401/.test(libraryCode)) {
  errors.push("la bibliothèque n'arrête plus ses appels quand rien ne répond : l'utilisateur attendrait pour rien");
}
/* Et quand le jeton est **refusé** (401/403/419), les cinq autres appels posent
   la même question avec le même jeton : ils attendraient pour rien de plus. */
["401", "403", "419"].forEach(function (code) {
  if (libraryCode.indexOf("Net.status === " + code) === -1) {
    errors.push("la bibliothèque insiste après un refus de jeton (" + code + ") : cinq attentes inutiles avant de dire pourquoi");
  }
});
/* **Le jeton redemandé à la page.** Constaté le 25/09 : « il n'arrive pas à
   reconnaître mes playlists ». Quand la capture n'a rien attrapé (ou que Spotify
   a refusé le jeton), il n'existait aucun moyen de relire la bibliothèque sans
   se reconnecter. La page du lecteur sait donner son jeton — même origine, donc
   pas de contrôle d'accès — et la coque le lui redemande. */
if (!/refreshToken: function/.test(libraryCode) || !/get_access_token/.test(libraryCode)) {
  errors.push("le jeton n'est plus redemandé à la page : une bibliothèque sans jeton resterait vide, sans issue");
}
if (!/forgetToken: function/.test(libraryCode) || !/Api\.forgetToken\(\)/.test(libraryCode)) {
  errors.push("un jeton refusé n'est jamais oublié : la coque insisterait avec le même jeton");
}
if (!/isAnonymous/.test(libraryCode)) {
  errors.push("un jeton anonyme est accepté comme un vrai : la page dirait « compte vide » à tort");
}

/* **L'enveloppe de la requête.** Le lecteur ne demande pas `api.spotify.com`
   avec le seul jeton : il envoie aussi `client-token`. Ces en-têtes étaient
   captés puis jamais renvoyés — nos appels partaient « nus » et Spotify les
   refusait alors que ceux de la page passaient. C'est la cause la plus probable
   du « il n'arrive pas à reconnaître mes playlists ». */
if (!/KEEP: \/\^\(authorization\|client-token/.test(libraryCode) || !/keepHeader: function/.test(libraryCode)) {
  errors.push("les en-têtes de la page ne sont plus gardés : les appels d'API repartiraient sans client-token");
}
if (!/requestHeaders: function \(browser\)/.test(libraryCode) || !/Api\.apiHeaders\(browser\)/.test(libraryCode)) {
  errors.push("la coque ne renvoie plus l'enveloppe de la page sur ses appels");
}
if (!/JSON\.stringify\(\{ method: "GET", headers: self\.requestHeaders\(false\) \}\)/.test(libraryCode)) {
  errors.push("le pont asynchrone ne reçoit plus les en-têtes de la page : la requête native partirait nue");
}
if (!/window\.fetch\(url, \{ headers: this\.requestHeaders\(true\) \}\)/.test(libraryCode)) {
  errors.push("la voie du navigateur ne renvoie plus les en-têtes de la page");
}
if (!/headerNames: function/.test(libraryCode) || !/libraryHeaders/.test(runtime)) {
  errors.push("le journal ne dit plus quels en-têtes ont été gardés : une capture ne suffirait plus à diagnostiquer un refus");
}
/* **La bibliothèque de l'utilisateur, pas la page.** Élargir la lecture à toute
   la page avait ramassé les playlists recommandées par Spotify : « les playlists
   sont beaucoup trop nombreuses, il y en a qui ne sont pas les miennes »
   (25/09). La lecture ne sort donc plus des zones qui portent la bibliothèque. */
if (/pick\(SEL\.mainView\), document\.body/.test(libraryCode)) {
  errors.push("la lecture ramasse de nouveau toute la page : les playlists recommandées par Spotify reviendraient dans la bibliothèque");
}
if (!/libraryScopes: function/.test(libraryCode) || !/add\(pick\(SEL\.sidebar\), true\)/.test(libraryCode)) {
  errors.push("la bibliothèque n'est plus repérée par ses zones connues (barre latérale + panneau) : la lecture ne saurait plus où chercher");
}
if (!/biblioth\|library/.test(libraryCode) || !/if \(!known\)/.test(libraryCode)) {
  errors.push("un conteneur inconnu peut de nouveau être pris pour la bibliothèque sans le dire (« bibliothèque »/« library » dans son titre ou ses repères) : les rangées de recommandations reviendraient");
}
if (!/self\.ignored\+\+/.test(libraryCode) || !/libraryIgnored/.test(runtime)) {
  errors.push("les playlists écartées ne sont plus comptées ni dites : une bibliothèque courte serait suspecte sans explication");
}
if (!/mine: mine/.test(libraryCode) || !/libraryMine/.test(runtime) || !/libraryFollowed/.test(runtime)) {
  errors.push("l'appartenance d'une playlist n'est plus dite : on ne saurait plus lesquelles sont les vôtres");
}
if (!/ensureLiked: function/.test(libraryCode)) {
  errors.push("l'entrée des titres likés n'est plus garantie : elle peut disparaître quand l'API se tait");
}
if (!/a\.closest && a\.closest\("\.sd-layer"\)/.test(libraryCode)) {
  errors.push("la lecture de la liste de Spotify ne s'exclut plus elle-même : elle pourrait lire sa propre page");
}
if (!/wake: function/.test(libraryCode) || !/retrySidebar: function/.test(libraryCode)) {
  errors.push("la coque ne déplie plus la liste de Spotify : une liste repliée (téléphone) ne serait jamais lue");
}
if (!/linkName: function/.test(libraryCode)) {
  errors.push("les lignes de Spotify seraient lues sans leur nom");
}
if (!/isMineCard/.test(libraryCode) || !/fromLibrary/.test(libraryCode)) {
  errors.push("la lecture hors bibliothèque n'exige plus de preuve d'appartenance : les playlists recommandées de l'accueil reviendraient");
}
if (!/mineShelves: function/.test(libraryCode) || !/data-sd-mine/.test(libraryCode)) {
  errors.push("les rangées « Vos playlists » de l'accueil ne sont plus reconnues : vos playlists hors barre latérale disparaîtraient");
}

/* ---- Pass 49 : quatre pannes trouvées en éprouvant **chaque** commande ----
   Toutes les quatre étaient des commandes qui ne faisaient rien (onglet qui
   répond à côté, porte de connexion cachée, « Réessayer » muet, file d'attente
   qu'on ne pouvait pas refermer) : on garde la trace de leur correction. */
if (!/route === "search" && State\.tab !== "library"/.test(libraryCode)) {
  errors.push("l'onglet Bibliothèque peut de nouveau être écrasé par l'adresse : appuyé depuis la recherche, il ne ferait plus rien");
}
if (!/login\.hidden = !nothing;/.test(libraryCode)) {
  errors.push("la porte de connexion peut de nouveau se cacher quand l'état de session est inconnu : l'instruction « connectez-vous » resterait sans bouton");
}
if (!/Api\.refreshState = "";/.test(libraryCode)) {
  errors.push("« Réessayer » peut redevenir un bouton muet quand le dernier essai de jeton a échoué");
}
var miniQueueCode = libraryCode.slice(libraryCode.indexOf("e.miniQueue.addEventListener"));
miniQueueCode = miniQueueCode.slice(0, miniQueueCode.indexOf("});") + 3);
if (!/Queue\.toggle\(\)/.test(miniQueueCode) || /Queue\.openSheet\(\)/.test(miniQueueCode)) {
  errors.push("la file d'attente du mini-lecteur ne s'ouvre plus que dans un sens : un second appui ne la fermerait pas");
}
if (!/watchList: function/.test(libraryCode) || !/obsList/.test(libraryCode)) {
  errors.push("la bibliothèque ne surveille plus l'arrivée tardive de la liste de Spotify : « aucune playlist » alors que les vôtres arrivent une seconde plus tard");
}
if (!/LIBRARY_CACHE_VERSION/.test(libraryCode) || !/data\.v === LIBRARY_CACHE_VERSION/.test(libraryCode)) {
  errors.push("le cache ne porte plus de version : un cache écrit par une lecture large réafficherait des playlists qui ne sont pas au compte");
}

/* **Une page ouverte n'est jamais recouverte.** Signalé deux fois : « quand on
   clique sur les playlists, y'a un écran noir ». Une playlist ouverte depuis la
   bibliothèque n'était pas reconnue comme une sous-page (l'onglet annulait la
   classe) et nos écrans pleine page — ou la barre latérale transformée en page —
   restaient posés dessus. */
if (!/isSubPagePath: function/.test(runtime) || !/route === "other" && Spotify\.isSubPagePath\(\)/.test(stripComments(runtime))) {
  errors.push("la vue ne reconnaît plus une sous-page par son adresse : une playlist ouverte depuis la bibliothèque ne serait plus reconnue (écran noir)");
}
if (/toggle\("sd-subpage", isSubPage && !isLibrary\)/.test(stripComments(runtime))) {
  errors.push("la classe de sous-page est de nouveau annulée par l'onglet : ouvrir une playlist depuis la bibliothèque remettrait nos écrans dessus");
}
if (!/reassertSurfaces: function/.test(stripComments(runtime))) {
  errors.push("plus rien ne range nos écrans pleine page quand une page est ouverte : un état résiduel peut de nouveau faire un écran noir");
}
if (!/UI\.reassertSurfaces\(\)/.test(runtime) || !/Content\.alertSoon\(/.test(runtime)) {
  errors.push("la réaffirmation des écrans (et l'alerte d'écran vide) n'est plus appelée à chaque changement de vue : le « je dois recharger à la main » reviendrait");
}
if (!/alertSoon: function/.test(runtime)) {
  errors.push("l'alerte d'écran vide n'est plus armable hors du démarrage : une playlist qui n'affiche rien redeviendrait un écran noir muet");
}
if (!/\.sd-subpage \.sd-layer \.sd-home/.test(css) || !/\.sd-subpage \.sd-layer \.sd-lib/.test(css)) {
  errors.push("la feuille n'interdit plus à nos écrans pleine page de s'afficher sur une sous-page : le garde-fou ne dépendrait plus que du script");
}
/* **Un dialogue fermé n'éteint pas le lecteur.** La règle qui faisait reculer
   nos barres visait aussi le mini-lecteur : un `role="dialog"` resté dans le
   DOM une fois fermé le faisait disparaître **pour de bon** (« le lecteur
   disparaît », signalé quatre fois). */
if (/sd-native-modal \.sd-layer > \.sd-mini/.test(css)) {
  errors.push("le mini-lecteur s'éteint de nouveau quand Spotify affiche un dialogue : « le lecteur disparaît » reviendrait");
}
if (!/dialogVisible: function/.test(stripComments(runtime)) || !/Polish\.syncOverlay\(\)/.test(runtime)) {
  errors.push("un dialogue n'est plus vérifié comme *visible* (et la classe n'est plus revérifiée) : un dialogue fermé resté dans le DOM éteindrait la coque");
}
if (!/dialogues: \(?\(\)/.test(probeTool) || !/dialogues=\$\{m\.dialogues\}/.test(probeTool)) {
  errors.push("la sonde ne dit plus combien de dialogues de Spotify sont visibles : un dialogue fermé qui éteint le lecteur ne serait plus vu");
}
if (!/SUBPAGE_PROBE/.test(probeTool) || !/CLICKPLAYLIST/.test(probeTool) || !/Sous-page playlist — /.test(probeTool)) {
  errors.push("la sonde n'ouvre plus de playlist : « écran noir quand on clique sur une playlist » ne serait plus mesuré en CI");
}

/* **Le lecteur est statique.** Deux versions ont tenté d'apprivoiser les gestes
   (défilement ≠ tirage, relâchement exigé) : le défilement continuait de fermer
   le lecteur ou de changer de titre sur le téléphone. Il n'y a donc plus aucun
   geste sur le mini-lecteur ni sur la feuille : ils ne bougent et ne se ferment
   que sur une commande explicite. */
if (/miniSwipe: function|sheetDrag: function/.test(libraryCode)) {
  errors.push("des gestes sont revenus sur le lecteur : c'est ce qui le faisait disparaître au défilement");
}
if (!/this\.seekDrag\(\);/.test(libraryCode)) {
  errors.push("le curseur de lecture n'est plus glissant : on ne peut plus se déplacer dans le morceau");
}
if (!/transform: none !important/.test(css)) {
  errors.push("le mini-lecteur n'est plus figé en CSS : une transition pourrait de nouveau le déplacer");
}
if (!/html\.sd-mobile\.sd-player-open \.sd-player \{[^}]*transform: none/.test(css)) {
  errors.push("la feuille du lecteur peut de nouveau être tirée : le geste de fermeture se confond avec le défilement");
}
if (/translate3d\(0, 120%, 0\)/.test(css)) {
  errors.push("le mini-lecteur est de nouveau poussé hors de l'écran par un transform (un transform resté en place le fait disparaître)");
}
if (!/reassertMini: function/.test(libraryCode) || !/UI\.reassertMini\(\)/.test(libraryCode)) {
  errors.push("le mini-lecteur n'est plus réaffirmé : une classe restée en place le laisserait hors de l'écran");
}
if (!/html\.classList\.toggle\("sd-player-open", Player\.open\)/.test(libraryCode)) {
  errors.push("la classe du lecteur plein écran n'est plus posée au même endroit que l'état qui la décide");
}

/* **La bibliothèque s'affiche d'abord, interroge ensuite.** Signalé : « ça
   prend du temps à charger pour afficher ». La page attendait six appels réseau
   avant de montrer quoi que ce soit, alors que les lignes de Spotify sont déjà
   dans la page et qu'un cache local peut les rendre tout de suite. */
if (!/showNow: function/.test(libraryCode) || !/var shown = this\.showNow\(\);/.test(libraryCode)) {
  errors.push("la bibliothèque n'affiche plus d'abord ce qu'elle a sous la main : elle attendrait de nouveau le réseau");
}
if (!/readCache: function/.test(libraryCode) || !/writeCache: function/.test(libraryCode)) {
  errors.push("la bibliothèque n'a plus de cache local : chaque ouverture repartirait de zéro");
}
if (!/LIBRARY_CACHE_KEY/.test(libraryCode) || !/LIBRARY_CACHE_TTL/.test(libraryCode)) {
  errors.push("le cache de la bibliothèque n'a plus de clé ni de durée de vie");
}
if (!/refresh: function \(haveRows\)/.test(libraryCode) || !/self\.keep\.length/.test(libraryCode)) {
  errors.push("un rafraîchissement raté viderait la bibliothèque au lieu de garder ce qui est affiché");
}
if (!/renderedSignature/.test(libraryCode)) {
  errors.push("les lignes sont de nouveau reconstruites à chaque repeint : la page redevient saccadée (82 lignes et leurs pochettes)");
}
if (!/libraryRefreshing/.test(runtime)) {
  errors.push("la page ne dit plus qu'une actualisation est en cours : on ne saurait pas si l'API a répondu");
}

/* Le repli qui rend la page utile même sans API : la liste de Spotify. */
if (!/fromSpotifyList: function \(\)/.test(libraryCode) || !/fromSidebar/.test(libraryCode)) {
  errors.push("aucun repli sur la liste de Spotify : sans API, la bibliothèque resterait vide");
}
if (!/sd-lib-log/.test(runtime)) {
  errors.push("le journal des essais a disparu : une capture ne suffirait plus à dire pourquoi la bibliothèque est vide");
}
if (!/libraryWhy: "Raison : %s\."/.test(runtime) || !/Settings\.labels\.libraryError \+ " " \+ Settings\.labels\.libraryWhy/.test(libraryCode)) {
  errors.push("une panne de la bibliothèque ne dit plus sa raison : il faudrait deviner au lieu de lire une capture");
}
const baseCss = read("src/inject/10-base.css");
if (!/--sd-mini-h-current: 0px/.test(baseCss)) {
  errors.push("la place du mini-lecteur est de nouveau réservée en toutes circonstances : une bande morte apparaîtrait sous la page");
}
if (!/sd-mini-on,\s*\nhtml\.sd-mobile\.sd-has-track \{[\s\S]{0,80}--sd-mini-h-current: var\(--sd-mini-h\)/.test(baseCss)) {
  errors.push("la place du mini-lecteur n'est plus liée à son affichage");
}
/* La barre d'onglets désactivée : sa place doit être **nulle**, et la règle doit
   venir après les paliers de taille (même spécificité : la dernière gagne). Sans
   ça, 64 px restent réservés pour une barre cachée — une bande morte sous la
   page, telle qu'elle a été mesurée en CI. */
const zeroIndex = bundleCss.lastIndexOf("--sd-tabbar-h:0px");
const sizeIndex = bundleCss.lastIndexOf("--sd-tabbar-h:calc(");
if (zeroIndex < 0) {
  errors.push("la barre d'onglets désactivée ne remet plus sa hauteur à zéro : une bande morte apparaîtrait sous la page");
} else if (sizeIndex > zeroIndex) {
  errors.push("la hauteur de la barre d'onglets est redéclarée après sa désactivation : la réserve du bas ne suivrait plus l'écran");
}

/* 2-ter-octies. La requête qui ne fige plus la page — capture du 25/09 09:12 :
   « Chargement de votre bibliothèque… » sans fin, et « le lecteur ne fait rien
   quand on clique sur les boutons ». `AndBridge.nFetch` s'exécute sur le fil
   JavaScript de la WebView : pendant qu'il attend le réseau, la page entière
   est gelée. La coque doit donc passer par la voie **asynchrone**
   (`nFetchAsync` + `window.__sdNet`), et ne jamais rester en chargement. */
const netBridgeKt = read("android/app/src/main/java/com/spotiduck/app/Bridge.kt");
const netActivityKt = read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
if (!/fun nFetchAsync\(id: String\?, url: String, optionsJson: String\?\)/.test(netBridgeKt)) {
  errors.push("le pont n'expose plus de requête asynchrone : la page serait de nouveau gelée pendant l'appel réseau");
}
if (!/Thread\(\{/.test(netBridgeKt) || !/act\.runJs\(/.test(netBridgeKt)) {
  errors.push("la requête asynchrone ne part plus d'un fil de fond (ou ne rend plus sa réponse à la page)");
}
if (!/internal fun runJs\(js: String\)/.test(netActivityKt) || !/webView\.post \{ webView\.evaluateJavascript/.test(netActivityKt)) {
  errors.push("l'activité n'a plus de moyen d'appeler la page depuis un fil de fond");
}
if (!/throughBridgeAsync: function/.test(libraryCode) || !/Bridge\.call\(\s*"nFetchAsync"/.test(libraryCode)) {
  errors.push("la coque n'utilise plus la voie réseau asynchrone : les boutons du lecteur ne répondraient plus pendant un chargement");
}
if (!/if \(this\.hasAsync\(\)\) bridge = this\.throughBridgeAsync/.test(libraryCode)) {
  errors.push("la coque préfère de nouveau la voie bloquante à la voie asynchrone");
}
if (!/window\.__sdNet/.test(libraryCode) || !/answer: function \(id, raw\)/.test(libraryCode)) {
  errors.push("la page n'accepte plus les réponses du pont (`window.__sdNet`) : la requête asynchrone n'aboutirait jamais");
}
if (!/deadlineMs: \d+/.test(libraryCode) || !/if \(!self\.loading\) return;/.test(libraryCode)) {
  errors.push("rien ne borne plus un chargement de bibliothèque : il pourrait rester en « Chargement… » indéfiniment");
}
if (!/libraryLoadingProgress/.test(runtime) || !/libraryTimeout/.test(runtime)) {
  errors.push("un chargement ne dit plus où il en est, ni qu'il a dépassé son délai");
}
if (/Bridge\.call\(\s*"nFetch",/.test(libraryCode) && !/hasBridge: function/.test(libraryCode)) {
  errors.push("la coque appelle la requête bloquante sans garde-fou");
}

for (const sheet of ["78-home.css", "79-library.css"]) {
  const body = read(`src/inject/${sheet}`);
  if (!/scrollbar-width: none/.test(body) || !/::-webkit-scrollbar \{\s*width: 0/.test(body)) {
    errors.push(`${sheet} : la barre de défilement de la WebView réapparaîtrait sur la page`);
  }
}

for (const method of ["load", "parse", "render", "apply", "enter", "describe", "watch"]) {
  if (!new RegExp(method + ": function").test(libraryCode)) {
    errors.push(`la bibliothèque maison a perdu « ${method}() »`);
  }
}
for (const endpoint of ["/me/playlists", "/me/albums", "/me/artists", "/me/shows", "/me/tracks"]) {
  if (!libraryCode.includes(endpoint)) {
    errors.push(`la bibliothèque ne lit plus ${endpoint} : une partie du compte disparaîtrait de l'écran`);
  }
}
if (!/classList\.toggle\("sd-lib-on", show\)/.test(libraryCode)) {
  errors.push("la bibliothèque masque la barre latérale de Spotify sans condition : un compte sans jeton perdrait l'accès à sa musique");
}
/* **L'onglet fait foi.** Signalé le 25/09 : « quand on clique sur l'onglet
   bibliothèque, la barre en haut disparaît et rien d'autre n'apparaît ; je reste
   bloqué sur l'écran d'accueil ». Deux causes : l'accueil ne jugeait sa place
   que sur l'URL (or l'onglet Bibliothèque ne navigue pas), et notre page de
   bibliothèque se taisait quand elle n'avait rien lu. */
if (!/if \(State\.tab !== "home"\) return false;/.test(libraryCode)) {
  errors.push("l'accueil ne vérifie plus l'onglet actif : il resterait posé par-dessus la bibliothèque");
}
if (!/var navOn = !isSubPage;/.test(libraryCode)) {
  errors.push("la barre de navigation est de nouveau masquée sur la bibliothèque : l'utilisateur n'a plus aucun moyen de revenir");
}
if (!/topbar\.classList\.toggle\("is-visible", isSubPage\)/.test(libraryCode)) {
  errors.push("la barre de titre n'est plus réservée aux sous-pages : elle recouvrirait la barre de navigation");
}
if (/if \(this\.state === "loading"\) return true;\s*\n\s*return this\.items\.length > 0;/.test(libraryCode)) {
  errors.push("la bibliothèque redevient muette quand elle n'a rien lu (l'écran reste noir chez un utilisateur sans jeton)");
}
if (!/isLibraryPath: function/.test(libraryCode)) {
  errors.push("la bibliothèque n'a plus de règle de chemin : elle recouvrirait les playlists ouvertes depuis elle");
}
for (const needle of ["sd-lib-title", "sd-lib-retry", "sd-lib-actions"]) {
  if (!libraryCode.includes(needle) || !css.includes(needle)) {
    errors.push(`la page de bibliothèque a perdu « ${needle} » (code ou feuille)`);
  }
}
if (!/top: calc\(var\(--sd-safe-t\) \+ var\(--sd-nav-h\)\);/.test(read("src/inject/79-library.css"))) {
  errors.push("la page de bibliothèque ne commence plus sous la barre de navigation : la première ligne serait cachée");
}
if (!/if \(this\.built\) return false;/.test("if (this.built) return false;") && false) errors.push("");

if (!/setRequestHeader/.test(libraryCode) || !/patchedXhr/.test(libraryCode)) {
  errors.push("le jeton n'est plus capté en XHR : une page qui n'utilise pas `fetch` laisserait la bibliothèque vide");
}
if (!/libraryBoard/.test(libraryCode) || !/switchRow\("libraryBoard"/.test(runtime)) {
  errors.push("l'interrupteur de la bibliothèque maison a disparu (on ne peut plus revenir à celle de Spotify)");
}

if (!/anchors: function \(\)/.test(stripComments(runtime))) {
  errors.push("le diagnostic ne mesure plus les ancres de contenu : impossible de distinguer une page écrasée d'une page absente");
}
/* « écran 137 » pour un écran de 385 : la densité n'est divisée que si la
   valeur de `screen.width` est manifestement physique. */
if (!/screenW > 1000 && dpr > 1/.test(stripComments(runtime))) {
  errors.push("la mesure de l'écran divise de nouveau par la densité sans vérifier : le diagnostic annoncera un écran faux");
}
if (!/excerpt: function \(\)/.test(stripComments(runtime)) || !/describe: function \(\)/.test(stripComments(runtime))) {
  errors.push("le diagnostic ne peut plus dire ce que la page raconte ni pourquoi l'accueil est absent");
}
if (!/@JavascriptInterface\s+fun session\(\): Boolean/.test(netBridgeKt) || !/fun sessionPresent\(\): Boolean/.test(activity)) {
  errors.push("le diagnostic ne peut plus dire si un compte est réellement connecté (session du lecteur)");
}
/* **Le curseur : lire et écrire dans la même unité.** La page de Spotify compte
   parfois en secondes, parfois en millisecondes ; lire avec l'une et écrire avec
   l'autre déplaçait le curseur au 1000e de la position demandée, et un simple
   déplacement faisait basculer l'unité mesurée (vu en CI : « seek() did not move
   the position, got 5 ms »). */
if (!/scale: function/.test(libraryCode)) {
  errors.push("la graduation du curseur n'a plus de repère commun : lire et écrire pourraient diverger d'un facteur 1000");
}
/* **La durée du titre se lit à un seul endroit.** `UI.paintProgress`, les deux
   gestes du curseur, la touche « fin » du clavier : partout où il faut savoir
   combien dure le titre, c'est `trackDurationMs()` — sans quoi un pointeur
   s'arrête au premier dixième, cherche dans un titre de trois heures, ou se
   bloque à zéro quand la page n'a pas encore annoncé sa durée. */
if (!/function trackDurationMs\(\)/.test(libraryCode)) {
  errors.push("la durée du titre n'a plus de source unique : le curseur peut se figer ou chercher au-delà du morceau");
}
for (const need of [
  "var total = s.duration > 0 ? s.duration : trackDurationMs();",
  "var ms = ratio * trackDurationMs();",
  "if (!trackDurationMs()) return;",
  "Actions.seek(ev.key === \"Home\" ? 0 : trackDurationMs());",
  "this.seek(clamp(Number(ratio) || 0, 0, 1) * trackDurationMs())",
]) {
  if (!libraryCode.includes(need)) {
    errors.push(`un affichage ou un geste du curseur ne demande plus sa durée à trackDurationMs() : ${need}`);
  }
}
if (!/function trackDurationMs\(\)[\s\S]{0,400}Spotify\.ticksToMs\(max\)/.test(libraryCode)) {
  errors.push("trackDurationMs() ne convertit plus la graduation du curseur en millisecondes");
}
if (/ratio \* \(State\.duration \|\| 0\)/.test(libraryCode)) {
  errors.push("un geste du curseur multiplie encore sa proportion par la durée annoncée toute seule");
}
if (
  !/var secondsBand = /.test(libraryCode) ||
  !/var msBand = /.test(libraryCode) ||
  /speed >= 60 \? 1000 : 1/.test(libraryCode)
) {
  errors.push("la calibration du curseur accepte encore les sauts : un déplacement du curseur ferait basculer l'unité et la position se lirait 1000 fois trop petite");
}

if (
  !/Onglet Bibliothèque — /.test(probeTool) ||
  !/const TABMEASURE = /.test(probeTool) ||
  !/onglet-actif=/.test(probeTool) ||
  !/const SCROLLPROBE = /.test(probeTool) ||
  !/Lecteur au défilement — /.test(probeTool)
) {
  errors.push("la sonde ne mesure plus l'appui sur l'onglet Bibliothèque : le « rien ne s'affiche » du 25/09 ne serait plus vu en CI");
}
/* Ce que la sonde doit distinguer pour qu'une capture suffise : notre barre de
   la barre de Spotify, le lecteur pendant **deux** relevés de défilement, et ce
   que la page dit (raison, journal). */
if (!/barre-spotify=/.test(probeTool) || !/lecteurOn/.test(probeTool)) {
  errors.push("la sonde ne distingue plus la barre de Spotify de la nôtre : une barre étrangère sur nos onglets passerait inaperçue");
}
if (!/bas\+900ms=/.test(probeTool) || !/after2/.test(probeTool)) {
  errors.push("la sonde ne relève plus le lecteur deux fois pendant le défilement : une disparition différée passerait inaperçue");
}
if (!/journal=/.test(probeTool) || !/dit=/.test(probeTool)) {
  errors.push("la sonde ne relève plus ce que la page dit (raison, journal) : une capture ne suffirait plus à diagnostiquer");
}
if (!/contenu=\$\{m\.contenu\}/.test(probeTool) || !/écartées \$\{lib\.ignored/.test(probeTool)) {
  errors.push("la sonde ne dit plus ce que la bibliothèque contient par provenance (à vous · suivies · likés · écartées) : la demande « que mes playlists » n'aurait plus de témoin en CI");
}
if (!/lignes-spotify=/.test(probeTool) || !/en-têtes=/.test(probeTool)) {
  errors.push("la sonde ne relève plus la source de repli (lignes de Spotify) ni les en-têtes gardés : la prochaine panne de bibliothèque serait de nouveau à l'aveugle");
}
if (!/document=\$\{scroll\.document\}/.test(probeTool)) {
  errors.push("la sonde ne fait plus défiler le document entier : le défilement du téléphone n'aurait plus de témoin");
}
if (!/dessus-du-lecteur=/.test(probeTool) || !/beforeTop/.test(probeTool)) {
  errors.push("la sonde ne dit plus ce qui recouvre le lecteur : « le lecteur a disparu » ne se distinguerait plus d'un élément posé dessus");
}
if (!/plein-écran=/.test(probeTool) || !/transform=/.test(probeTool)) {
  errors.push("la sonde ne dit plus si la feuille du lecteur est ouverte ni si le mini-lecteur porte un transform : un lecteur « disparu » ne se verrait pas");
}
if (!/out\.verdict/.test(probeTool) || !/homePath/.test(probeTool)) {
  errors.push("la sonde ne relève plus ce que la coque conclut de la page (état, chemin d'accueil, ancre)");
}

/* **Pass 50 — le zap, et la bibliothèque plus propre.**

   « Le système de lecture est toujours bugué, impossible de zapper la musique » :
   les repères du lecteur sont désormais par libellé **dans le lecteur**, un
   bouton désactivé n'est plus choisi, notre propre couche est écartée, et le
   repli clavier **vérifie** avant de parler. Ce qui suit empêche d'y revenir en
   silence. */
const deadBody = (stripComments(runtime).match(/function dead\(el\)\s*\{[\s\S]*?\n  \}/) || [""])[0];
if (!/function dead\(el\)/.test(stripComments(runtime)) || !/disabled === true/.test(deadBody)) {
  errors.push("le test « bouton inutilisable » ne reconnaît plus un bouton désactivé : « impossible de zapper » reviendrait");
}
if (/getComputedStyle|display === "none"|visibility === "hidden"/.test(deadBody)) {
  errors.push("un bouton caché est de nouveau refusé : notre propre feuille masque la barre du bureau, et l'appui dessus agit quand même");
}
if (!/function ours\(el\)/.test(stripComments(runtime))) {
  errors.push("plus rien n'écarte nos propres boutons des repères du lecteur : « Lecture » et « Suivant » se cliqueraient eux-mêmes (deux bascules qui s'annulent)");
}
if ((runtime.match(/if \(!ours\(found\[j\]\)\) all\.push/g) || []).length < 2) {
  errors.push("la collecte des candidats ne les écarte plus de notre couche (pick et click)");
}
if (!/if \(dead\(order\[k\]\)\) continue;/.test(stripComments(runtime))) {
  errors.push("un appui peut de nouveau partir sur un bouton désactivé (le premier trouvé) au lieu du premier utilisable");
}
if (!/function inPlayer\(labels\)/.test(stripComments(runtime)) || !/PLAYER_SCOPE = \[/.test(runtime)) {
  errors.push("les repères par libellé ne sont plus limités au lecteur : « Suivant » viserait le bouton d'avance de la navigation");
}
if ((runtime.match(/inPlayer\(\[/g) || []).length < 6) {
  errors.push("toutes les commandes du lecteur n'ont plus leurs repères par libellé (lecture, suivant, précédent, aléatoire, répétition, j'aime)");
}
if (!/key: function \(key, extra\)/.test(stripComments(runtime))) {
  errors.push("le clavier du lecteur (dernier recours quand ses boutons manquent) a disparu : un bouton muet reviendrait");
}
if (!/fallback: function \(key, watch, avant\)/.test(stripComments(runtime)) || !/snapshot: function \(watch\)/.test(stripComments(runtime))) {
  errors.push("le repli ne **vérifie** plus que la commande a agi : la coque parlerait à tort, ou resterait muette");
}
if (!/blame: function \(\)/.test(stripComments(runtime)) || !/State\.title \? Settings\.labels\.transportMissing : Settings\.labels\.transportNoTrack/.test(runtime)) {
  errors.push("le message ne distingue plus « rien ne joue » de « cette page n'expose pas la commande »");
}
for (const [appel, quoi] of [
  ['this.fallback(" ", "playing", ref);', "lecture/pause"],
  ['this.fallback("ArrowRight", "track");', "suivant"],
  ['this.fallback("ArrowLeft", "track");', "précédent"],
]) {
  if (!runtime.includes(appel)) errors.push(`${quoi} n'a plus de repli clavier : sur une page sans bouton vivant, le bouton ne ferait rien`);
}
/* Un appui = une commande. Le secours clavier ne doit jamais partir pendant
   qu'une commande réseau roule : c'est précisément ce qui faisait « j'appuie sur
   lire, la musique ne démarre pas » — la touche appuyait deux fois, une fois pour
   lancer, une fois pour mettre en pause, dans le même tour de boucle. La garde est
   donc un fil aussi solide que le repli lui-même. */
if (!/if \(want && \(relais \|\| Engine\.inFlight\(\)\)\) \{[\s\S]{0,260}?this\.awaitEngine\(/.test(stripComments(runtime))) {
  errors.push("le secours clavier n'est plus séquencé derrière la commande en cours : deux pilotes peuvent se contredire et annuler la lecture (défaut corrigé en 2.11.27)");
}
if (!/awaitEngine: function \(key, watch, ref, delay\)/.test(stripComments(runtime))) {
  errors.push("plus d'`awaitEngine` : rien n'attend le résultat de la commande avant de la juger perdue, et le premier secours venu écrase la lecture");
}
if (!/verifyPlay: function \(ref\)/.test(stripComments(runtime)) || !/this\.verifyPlay\(ref\);/.test(runtime)) {
  errors.push("plus de `verifyPlay` : un appui consommé par la page sera cru suffisant, alors qu'un bouton pressé n'est pas une musique qui joue");
}
if (!/transportNoTrack: "Rien ne joue/.test(runtime) || !/transportMissing: "Ces commandes ne répondent pas/.test(runtime)) {
  errors.push("les deux messages du transport ont changé de sens : l'utilisateur n'apprendrait plus pourquoi ça ne répond pas");
}
if (!/candidat\(s\)/.test(probeTool) || !/utilisable=/.test(probeTool)) {
  errors.push("la sonde ne relève plus le nombre de candidats ni si l'un d'eux est utilisable : le zap ne serait plus mesuré sur la vraie page");
}
if (!/\.sd-mini-next/.test(probeTool) || !/nos boutons/.test(probeTool)) {
  errors.push("la sonde ne mesure plus nos propres boutons (taille et élément au centre) : un bouton recouvert ne se verrait plus");
}
/* La bibliothèque « plus propre » : les compteurs des puces et la note de filtre
   vide sont ce qui rend l'onglet lisible — leur disparition doit se voir. */
if (!/\.sd-lib-chip-n/.test(css) || !/sd-lib-chip-n/.test(runtime)) {
  errors.push("les puces de la bibliothèque n'affichent plus leur compte (feuille ou script) : l'onglet redevient une liste muette");
}
if (!/\.sd-lib-nofilter/.test(css) || !/sd-lib-nofilter/.test(runtime)) {
  errors.push("un filtre qui ne montre rien ne s'explique plus : la bibliothèque paraîtrait vide");
}

/* **Pass 51 — la bibliothèque, lisible.** « Rends l'onglet bibliothèque plus
   propre » : ce qui suit empêche de revenir en arrière sans le voir — les
   enfants écrasés par un conteneur qui défile, l'en-tête en colonne, les
   filtres sans point d'accroche, le journal déployé, une puce vide
   indiscernable, un cœur pour toutes les pochettes manquantes. */
const libCss = read("src/inject/79-library.css");
if (!/\.sd-lib > \*\s*\{[^}]*flex: 0 0 auto/.test(libCss)) {
  errors.push("rien ne protège les enfants de la bibliothèque : le moteur les rétrécit dès que la liste dépasse l'écran (filtres coupés en deux, en-tête écrasé)");
}
if (!/\.sd-lib-head \{[^}]*flex-direction: row/s.test(libCss)) {
  errors.push("l'en-tête de la bibliothèque n'est plus en ligne : le compte repasse sous le titre et le résumé déborde");
}
if (!/position: sticky/.test(libCss) || !/--sd-lib-head-h/.test(libCss)) {
  errors.push("l'en-tête de la bibliothèque ne se colle plus au-dessus des filtres : au défilement, les puces passent dessous");
}
if (!/--sd-lib-head-h/.test(runtime) || !/measureHead/.test(runtime)) {
  errors.push("la hauteur de l'en-tête n'est plus mesurée : le point d'accroche des filtres serait faux (le compte et le résumé changent la hauteur)");
}
if (!/<details class="sd-lib-log"/.test(runtime)) {
  errors.push("le journal des essais n'est plus repliable : déployé, il reprend la moitié de l'écran (« plus propre »)");
}
if (!/libraryLogHint/.test(runtime) || !/sd-lib-log-n/.test(runtime)) {
  errors.push("le résumé du journal ne dit plus ce qu'on y trouverait ni combien d'essais");
}
if (!/sd-lib-count/.test(runtime) || !/libraryCountOne/.test(runtime) || !/libraryCountMany/.test(runtime)) {
  errors.push("l'en-tête n'annonce plus le nombre de lignes : la page ne dit pas combien d'éléments elle montre");
}
if (!/sd-lib-note-text/.test(runtime) || !/sd-lib-note-glyph/.test(runtime)) {
  errors.push("la phrase d'état n'a plus son icône ni son texte isolé : elle se lit comme un paragraphe au lieu d'un état");
}
if (!/is-empty/.test(runtime) || !/\.sd-lib-chip\.is-empty/.test(libCss)) {
  errors.push("une catégorie vide ne se distingue plus d'une catégorie remplie");
}
for (const [type, icone] of [["liked", "heartSolid"], ["playlist", "musicNote"], ["album", "discLine"], ["artist", "personLine"], ["show", "micLine"]]) {
  if (!new RegExp(type + ": ICONS\\." + icone).test(runtime)) {
    errors.push(`une ligne « ${type} » sans pochette n'a plus son propre glyphe : tous les types se ressemblent`);
  }
}

/* **Pass 52 — l'appui sur une playlist.** « Quand on appuie sur une playlist,
   tout doit s'afficher correctement (pas d'écran noir), et le retour doit
   fonctionner. » Ce qui suit empêche de revenir au rechargement sans le voir :
   nos liens doivent passer par la navigation du lecteur, un voile doit dire ce
   qui s'ouvre, et le retour doit défaire l'ouverture. */
const openCss = read("src/inject/80-open.css");
/* L'appui sur un de nos liens passe par `Open.open`, jamais par le navigateur. */
if (!/ev\.preventDefault\(\);\s*var nom = \$\("\.sd-lib-name", a\)/.test(runtime) || !/a\.closest\("\.sd-layer"\)/.test(runtime)) {
  errors.push("nos liens ne sont plus interceptés : un appui recharge l'application (écran noir, coque reconstruite)");
}
if (!/if \(href\.charAt\(0\) !== "\/"\) return;/.test(runtime)) {
  errors.push("le filtre des liens internes a disparu : un lien externe (la connexion) serait détourné");
}
if (!/twin: function \(href\)/.test(runtime) || !/if \(a\.closest && a\.closest\("\.sd-layer"\)\) continue;/.test(runtime) || !/if \(h === cible\) return a;/.test(runtime)) {
  errors.push("l'appui ne cherche plus le lien du lecteur pour la même adresse : la navigation n'est plus celle de Spotify");
}
if (!/history\.pushState\(\{ sd: "open", open: href \}, "", href\)/.test(runtime) || !/pulse: function \(\)/.test(runtime)) {
  errors.push("l'adresse n'est plus poussée dans l'historique avec la navigation annoncée : l'ouverture ne peut plus se défaire");
}
if (!/location\.assign\(self\.href\)/.test(runtime) || !/if \(\+\+self\.tries >= OPEN_TRIES\)/.test(runtime)) {
  errors.push("plus aucune vérification que la page a suivi : une adresse refusée laisserait un écran vide");
}
if (!/state\.sd === "panel"/.test(runtime)) {
  errors.push("l'ouverture d'une page n'est plus comptée comme une navigation : le retour ne la défait plus");
}
if (!/if \(Open\.synthetic\) return;\s*\/\*|\/\*[\s\S]{0,200}?\*\/\s*if \(Open\.synthetic\) return;/.test(runtime) || (runtime.match(/if \(Open\.synthetic\) return;/g) || []).length < 2) {
  errors.push("l'événement de navigation que nous émettons est repris par nos propres écouteurs : l'historique se décrémente deux fois");
}
/* Le voile : posé, rangé, et il ne couvre pas le lecteur. */
if (!/openVeil\.className = "sd-open";/.test(runtime) || !/L\.appendChild\(openVeil\);/.test(runtime) || !/openingOf/.test(runtime)) {
  errors.push("plus de voile d'ouverture : pendant qu'une page se charge, l'écran reste noir");
}
if (!/\.sd-open \{[^}]*bottom: var\(--sd-bottom\)/.test(openCss) || !/\.sd-open \{[^}]*pointer-events: none/.test(openCss)) {
  errors.push("le voile couvre le lecteur ou bloque les appuis : il doit ne couvrir que la zone de contenu");
}
if (!/\.sd-open \{[^}]*z-index: 38/.test(openCss)) {
  errors.push("le voile n'est plus rangé entre les pages et la feuille du lecteur");
}
/* Le retour défait une ouverture en cours au lieu de partir sur l'accueil. */
if (!/if \(Open\.busy\) \{\s*Open\.cancel\(\);\s*return true;/.test(runtime) || !/cancel: function \(\) \{/.test(runtime)) {
  errors.push("le retour pendant une ouverture n'est plus pris en compte : il retomberait sur l'accueil");
}
/* **Une seule entrée « Titres likés ».** La capture du 25/09 en montrait deux :
   la nôtre, et celle de Spotify relue par le repli. */
if (!/if \(row\.type === "liked"\) \{\s*if \(!liked\) liked = row;\s*continue;/.test(runtime) || !/propres\.unshift\(liked\)/.test(runtime)) {
  errors.push("les lignes ne sont plus remises d'aplomb : « Titres likés » peut réapparaître deux fois");
}
if (!/type \+ "\|" \+ \(row\.href \|\| row\.name/.test(runtime) || !/if \(vues\[cle\]\) continue;/.test(runtime)) {
  errors.push("les doublons d'adresse ne sont plus écartés : la même playlist peut s'afficher deux fois");
}
/* **Le banc doit pouvoir mesurer cela.** Sans routeur sur l'adresse ni
   `preventDefault` sur les liens internes, un appui ressemble à un
   rechargement dans le banc — une mesure fausse. */
const mock = read("demo/mock/spotify.js");
if (!/routeFromPath\(location\.pathname\)/.test(mock) || !/state\.route = route;/.test(mock)) {
  errors.push("le banc ne route plus par l'adresse : l'ouverture d'une page par l'historique ne peut plus être mesurée");
}
if (!/Desktop_LeftSidebar_Id"\)\.addEventListener\("click",[\s\S]{0,900}?e\.preventDefault\(\)/.test(mock)) {
  errors.push("le banc laisse le navigateur suivre un lien interne : suivre un lien y ressemble à un rechargement");
}
/* Et la sonde doit le dire : un appui qui recharge est le défaut signalé. */
const probe = read("tools/probe-coop.mjs");
if (!/window\.__sdNavMark = "pose";/.test(probe) || !/opened\.recharge/.test(probe)) {
  errors.push("la sonde ne mesure plus si l'application est rechargée à l'appui : le défaut du 25/09 pourrait revenir sans alerte");
}
if (!/const RETOUR_PROBE = \(\) => \{/.test(probe) || !/page\.evaluate\(RETOUR_PROBE\)/.test(probe) || !/Retour depuis une playlist/.test(probe)) {
  errors.push("la sonde ne mesure plus le retour : « le retour en arrière doit fonctionner » ne serait plus vérifié");
}

/* --------------------------------------------------------------------------
   6. Les textes et les réglages : ce qui est promis doit exister.
   Un libellé oublié dans la liste des textes ne se voit nulle part — ni à la
   compilation (le fichier est un tout), ni au banc (le test lit la liste, pas
   l'appel). Sur le téléphone, cela donne une bulle « undefined », une
   « Notice indisponible » pour un simple rechargement, ou un bouton sans nom
   pour un lecteur d'écran. Même risque pour les réglages : une clé que la
   liste de sauvegarde oublie s'efface au redémarrage.
   -------------------------------------------------------------------------- */
/* Les listes ci-dessous sont lues dans le code sans ses commentaires : un mot
   entre guillemets dans une explication ne doit pas compter comme une clé. */
const labelsBlock = bodyOf("labels: {");
const labelKeys = new Set([...labelsBlock.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map((m) => m[1]));
if (labelKeys.size < 40) {
  errors.push(`la liste des textes n'a plus pu être lue entièrement (${labelKeys.size} libellés) : le contrôle des libellés est aveugle`);
}
/* Doublons dans la liste des textes : le second écrase le premier en silence,
   et le premier devient introuvable — « Recharger » réclamait un libellé que
   seul un doublon semblait fournir. */
{
  const once = new Set();
  for (const m of labelsBlock.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)) {
    if (once.has(m[1])) errors.push(`deux libellés portent le même nom « ${m[1]} » : la première valeur est écrasée`);
    once.add(m[1]);
  }
}
/* `labels.` seul serait trop large (le module des repères a son propre tableau
   `labels`) ; on ne surveille que les accès au règlage des textes. */
for (const m of libraryCode.matchAll(/(?:Settings|this)\.labels\.([a-zA-Z0-9_]+)/g)) {
  if (!labelKeys.has(m[1])) {
    errors.push(`un libellé est demandé sous le nom « ${m[1]} », qui n'existe pas dans la liste : le bouton s'appelle « undefined »`);
  }
}
/* Une clé calculée est permise, à condition que **tous** les noms qu'elle peut
   produire existent (ici : un ou plusieurs éléments). */
for (const m of libraryCode.matchAll(/(?:Settings|this)\.labels\[([^\]]+)\]/g)) {
  const names = [...m[1].matchAll(/"([a-zA-Z0-9_]+)"|'([a-zA-Z0-9_]+)'/g)].map((q) => q[1] || q[2]);
  if (!names.length) {
    errors.push(`un libellé est demandé par une clé entièrement calculée (${m[1]}) : le contrôle des textes ne peut plus le suivre`);
    continue;
  }
  for (const n of names) {
    if (!labelKeys.has(n)) {
      errors.push(`un libellé est demandé sous le nom « ${n} », qui n'existe pas dans la liste`);
    }
  }
}

/* La liste des réglages qui survivent au redémarrage doit couvrir `DEFAULTS`
   (et réciproquement) et chaque clé doit exister dans `Settings` : une clé
   oubliée à moitié se traduit par « mes réglages ne sont pas gardés ». */
{
  const defaultsBlock = bodyOf("var DEFAULTS = {");
  const defaultKeys = [...defaultsBlock.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map((m) => m[1]);
  if (defaultKeys.length < 8) errors.push("les valeurs par défaut des réglages n'ont plus pu être lues");
  const persistAt = libraryCode.indexOf("var PERSIST = [");
  const persistBlock = persistAt < 0 ? "" : libraryCode.slice(persistAt, libraryCode.indexOf("]", persistAt));
  const persisted = new Set([...persistBlock.matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]));
  if (persisted.size < 8) errors.push("la liste des réglages sauvegardés est vide ou illisible : plus aucun réglage ne survivrait");
  for (const k of defaultKeys) {
    if (!persisted.has(k)) errors.push(`le réglage « ${k} » a une valeur par défaut mais n'est pas sauvegardé : il s'efface au redémarrage`);
  }
  for (const k of persisted) {
    if (!defaultKeys.includes(k)) errors.push(`la liste de sauvegarde connaît « ${k} », qui n'a pas de valeur par défaut : « Réinitialiser » ne l'effacerait jamais`);
  }
  const settingsBlock = bodyOf("var Settings = {");
  for (const k of defaultKeys) {
    if (!new RegExp(`^\\s{4}${k}:`, "m").test(settingsBlock)) {
      errors.push(`le réglage « ${k} » a une valeur par défaut absente de l'objet des réglages`);
    }
  }
}

/* Le bas de l'écran se réserve d'après la hauteur **mesurée** du mini-lecteur ;
   les valeurs des feuilles ne servent que au tout premier rendu. Si les deux
   divergent, la page est recouverte d'une bande vide (vu le 25/09 : « le bas
   de l'écran est noir », « on ne peut plus rien toucher sous la barre »). */
{
  const deviceCss = read("src/inject/76-device.css");
  const reserved = [...deviceCss.matchAll(/--sd-mini-h:\s*calc\((\d+)px/g)].map((m) => Number(m[1]));
  if (!reserved.length) errors.push("les feuilles ne fixent plus du tout la hauteur du mini-lecteur");
  const measured = /--sd-mini-h-current/.test(read("src/inject/10-base.css")) && /measure: function/.test(libraryCode);
  if (!measured) errors.push("la place réservée en bas ne suit plus la hauteur réelle du mini-lecteur");
  if ((libraryCode.match(/askMeasure\(\)/g) || []).length < 2) {
    errors.push("rien ne redemande la mesure après un changement de vue ou de densité");
  }
  if (!/watchSize: function/.test(libraryCode)) errors.push("un changement de taille d'écran ne redemande plus la mesure");
  for (const n of reserved) {
    /* Trois lignes (pochette + transport + progression) à ~44 px + marges : en
       dessous, la place réservée est fausse et la page passe sous la barre. */
    if (n < 140) errors.push(`hauteur de mini-lecteur annoncée trop petite en CSS (${n}px) : la page passerait sous la barre`);
  }
}

/* --------------------------------------------------------------------------
   7. Le widget du bureau : la feuille XML et le code Kotlin doivent se parler,
      et les trois commandes doivent rester alignées (40 dp · 48 dp · 40 dp).
   -------------------------------------------------------------------------- */
{
  const widgetXml = read("android/app/src/main/res/layout/widget_player.xml");
  const widgetKt = read("android/app/src/main/java/com/spotiduck/app/PlayerWidget.kt");
  const declared = new Set([...widgetXml.matchAll(/android:id="@\+id\/(\w+)"/g)].map((m) => m[1]));
  const used = new Set([...widgetKt.matchAll(/R\.id\.(\w+)/g)].map((m) => m[1]));
  for (const id of used) {
    if (!declared.has(id)) errors.push(`le widget demande « ${id} » : aucun élément de widget_player.xml ne le porte (le bouton ne répondrait pas)`);
  }
  for (const id of declared) {
    if (!used.has(id)) warnings.push(`« ${id} » est dans la feuille du widget : plus personne ne l'utilise en Kotlin`);
  }
  const strings = read("android/app/src/main/res/values/strings.xml");
  for (const m of widgetXml.matchAll(/@(?:string|drawable)\/(\w+)/g)) {
    if (!new RegExp(`name="${m[1]}"`).test(strings) && !existsSync(join(root, `android/app/src/main/res/drawable/${m[1]}.xml`))) {
      errors.push(`la feuille du widget référence « ${m[1]} », qui n'existe ni comme chaîne ni comme dessin`);
    }
  }
  /* La rangée de commandes : des hauteurs différentes (40 · 48 · 40 dp), donc un
     alignement. On cherche le conteneur qui porte le bouton « précédent », et
     **lui seul** — le parent racine, lui, est déjà centré. */
  {
    const opens = [...widgetXml.matchAll(/<LinearLayout\b[^>]*>/g)];
    const row = opens.find((m) => widgetXml.slice(m.index + m[0].length, m.index + m[0].length + 260).includes("@+id/widget_previous"));
    if (!row) {
      errors.push("la rangée de commandes du widget n'est plus un LinearLayout identifiable : l'alignement ne peut plus être contrôlé");
    } else if (!/gravity="center_vertical"/.test(row[0])) {
      errors.push("la rangée de commandes du widget n'est plus alignée au centre : 40 dp et 48 dp se toucheraient de travers");
    }
  }
  for (const src of widgetXml.matchAll(/android:src="@drawable\/(\w+)"/g)) {
    const file = join(root, `android/app/src/main/res/drawable/${src[1]}.xml`);
    if (!existsSync(file)) errors.push(`le widget affiche « ${src[1]} », dessin absent des ressources`);
  }
}

/* --------------------------------------------------------------------------
   8. Les deux modes, la même barre de progression.
   La coque injectée et le shim « interface Spotify » pilotent le même curseur
   de la même page. S'ils se mettaient à compter l'un en secondes et l'autre en
   millisecondes, la notification et l'écran afficheraient deux positions
   différentes du même morceau — et une avance de dix secondes en vaudrait dix
   mille. Les deux fichiers doivent donc partager le seuil et le sens.
   -------------------------------------------------------------------------- */
{
  const shell = libraryCode;
  const shim = stripComments(nativeCalls);
  for (const need of ["function cursorUnitFactor", "function ticksToMs", "function msToTicks"]) {
    if (!hasFn(shim, need)) {
      errors.push(`le shim du mode « interface Spotify » n'a plus de ${need}() : il redevine l'unité du curseur pour son propre compte`);
    }
  }
  const shellThreshold = /max > (\d+)/.exec(shell);
  const shimThreshold = /n > (\d+)/.exec(shim);
  if (shellThreshold && shimThreshold && shellThreshold[1] !== shimThreshold[1]) {
    errors.push(`les deux modes ne partagent plus le seuil d'unité du curseur (${shellThreshold[1]} d'un côté, ${shimThreshold[1]} de l'autre)`);
  }
  if (!/function progressInput/.test(shim)) {
    errors.push("le shim n'a plus de repère borné à la barre de progression : il peut écrire dans le curseur de volume");
  }
  if (/q\("input\[type='range'\]"\)/.test(shim) || /querySelector\("input\[type='range'\]"\)/.test(shim)) {
    errors.push("le shim retombe sur « le premier curseur de la page » : sur la page mobile, c'est le volume");
  }
  if (!/function btnText\(/.test(shim) || !/function playerRoot\(/.test(shim)) {
    errors.push("le shim ne borne plus ses libellés au lecteur : un bouton de la page peut être pris pour une commande de lecture");
  }
  if (!/\bbyLabel\(res\)/.test(shim) && /byLabel\([^)]*,/.test(shim)) {
    errors.push("le shim cherche encore ses commandes hors du lecteur");
  }
  /* Les deux modes doivent piloter **les mêmes boutons** de la même page :
     `SEL.*` de la coque et les candidats du shim sont lus côte à côte. Un id
     que le shim invente est un id que personne n'a vérifié sur la page. */
  const shellTestids = new Set([...runtime.matchAll(/data-testid=\"([a-z0-9-]+)\"/g)].map((m) => m[1]));
  for (const m of shim.matchAll(/playerButton\(\[([^\]]+)\]/g)) {
    for (const id of m[1].matchAll(/\"([a-z0-9-]+)\"/g)) {
      if (!shellTestids.has(id[1])) {
        errors.push(`le shim cherche « ${id[1]} » comme commande du lecteur : la coque ne le connaît pas`);
      }
    }
  }
  if (!hasFn(shim, "function bestCoverUrl")) {
    errors.push("le shim ne demande plus la plus grande pochette : la notification afficherait la vignette 64 px");
  }
}

/* --------------------------------------------------------------------------
   9. Les secours de lecture : ce que la page **joue**, pas seulement ce
   qu'elle affiche.
   La coque et le shim ne savaient lire que les `data-testid` de React. Renommés
   (et c'est tous les mois), la coque se croyait sans piste, posait `disabled`
   sur ses propres boutons — un bouton désactivé ne reçoit aucun événement — et
   l'utilisateur ne voyait plus rien se passer, sans le moindre message. Les
   trois garde-fous ci-dessous verrouillent la leçon : une source indépendante du
   markup, un appui jamais muet, et les deux modes d'accord.
   -------------------------------------------------------------------------- */
{
  const shell = libraryCode;
  for (const need of ["mediaEl: function", "session: function", "mediaToggle: function", "mediaSeek: function"]) {
    if (!hasFn(shell, need)) {
      errors.push(`la coque n'a plus de ${need.replace(": function", "")}() : elle redevient aveugle dès que le markup de Spotify change de nom`);
    }
  }
  const read = (shell.match(/read: function \(\) \{[\s\S]*?\n    \},/) || [""])[0];
  if (!/this\.session\(\)/.test(read) || !/this\.mediaEl\(\)/.test(read)) {
    errors.push("`read()` ne consulte plus ce que la page joue : titre et durée dépendent de nouveau d'un seul repère de markup");
  }
  if (!/!!this\.mediaEl\(\)|this\.session\(\)/.test(shell)) {
    errors.push("la coque ne déclare plus le lecteur prêt sur l'élément qui joue");
  }
  const seek = (shell.match(/seek: function \(ms\) \{[\s\S]*?\n    \},/) || [""])[0];
  if (!/this\.mediaSeek\(/.test(seek)) {
    errors.push("`seek()` refuse de chercher quand le curseur de la page est absent : l'appui reste muet");
  }
  const playPause = (shell.match(/playPause: function \(want\) \{[\s\S]*?\n    \},/) || [""])[0];
  if (!/this\.mediaToggle\(/.test(playPause)) {
    errors.push("`playPause()` n'a plus de secours sur l'élément : sans bouton vivant, la commande ne fait rien");
  }
  /* Un appui ne doit jamais être perdu par la feuille elle-même. */
  if (/btn\.disabled = !s\.hasTrack/.test(shell)) {
    errors.push("les commandes du mini-lecteur sont verrouillées par `disabled` : un bouton désactivé ne reçoit aucun événement, l'appui devient muet");
  }
  if (!/aria-disabled/.test(shell) || !/is-unavailable/.test(shell)) {
    errors.push("l'indisponibilité d'une commande n'est plus annoncée (`aria-disabled` + `.is-unavailable`) : elle ne peut plus être dessinée sans verrouiller l'appui");
  }
  if (!/\.sd-iconbtn\.is-unavailable\s*\{[^}]*pointer-events:\s*auto/.test(css)) {
    errors.push("`.is-unavailable` n'est pas explicitement pressable dans la feuille : le bouton indisponible redeviendrait muet");
  }
  /* Le raccourci de dernier recours doit être jugé sur la page, pas sur notre
     affichage optimiste : sinon un appui qui n'a rien fait se croit réussi. */
  const fallback = (shell.match(/fallback: function \(key, watch, avant\) \{[\s\S]*?\n    \},/) || [""])[0];
  if (!/Spotify\.readPlaying\(\)/.test(fallback)) {
    errors.push("`fallback()` juge le raccourci sur l'état optimiste de la coque : un appui muet ne sera plus jamais signalé");
  }
  /* Et le shim, même secours. */
  const shim = stripComments(nativeCalls);
  for (const need of ["function mediaEl", "function session", "function mediaToggle", "function mediaSeek"]) {
    if (!hasFn(shim, need)) {
      errors.push(`le shim n'a plus ${need}() : la notification redevient muette quand la page ne pose pas ses repères`);
    }
  }
  if (!/btn\.disabled === true/.test(shim)) {
    errors.push("le shim compte un bouton désactivé comme une réussite : la notification dirait « fait » sans que rien ne se passe");
  }
  if (!/var sess = session\(\)/.test(shim)) {
    errors.push("la publication du shim ne lit plus la session média de la page");
  }
  if (!/mediaSeek\(/.test(shim) || !/mediaToggle\(/.test(shim)) {
    errors.push("les commandes du shim n'ont plus de secours sur l'élément qui joue");
  }
}

/* --------------------------------------------------------------------------
   10. L'agent servi à Spotify, la feuille de la coque et la sonde de CI.
   `userAgentFor` décide quelle page est servie. La règle est un **arbitrage
   mesuré**, pas un goût : la page du téléphone rend la mise en page exacte du
   téléphone mais refuse la lecture à un compte gratuit (§42), la page de
   bureau joue mais est mise en page sur 412 px — d'où `05-original-fit.css`
   et le stationnement de sa barre. Ces trois fils se coupent sans qu'aucun
   test de la coque ne bronche, parce qu'ils ne sont dans aucun fichier que la
   coque importe. Ce groupe est là pour ça.
   -------------------------------------------------------------------------- */
{
  const kt = activitySource;
  const uaFor =
    /private fun userAgentFor\(mode: String\): String =\s*\n?\s*if \(([^)]*)\)\s*(DESKTOP_UA|MOBILE_UA)\s+else\s+(DESKTOP_UA|MOBILE_UA)/.exec(kt);
  if (!uaFor) {
    errors.push(
      "`userAgentFor` n'est plus reconnaissable : vérifier qu'elle sert toujours la page de bureau aux modes habillés, puis étendre ce garde-fou volontairement"
    );
  } else {
    const cond = uaFor[1].replace(/\s+/g, "");
    const yes = uaFor[2], elseBranch = uaFor[3];
    const okNativeMobile = /MODE_NATIVE\)?$/.test(cond) && yes === "MOBILE_UA" && elseBranch === "DESKTOP_UA";
    const okNotNative = /!={0,1}MODE_NATIVE/.test(cond) && yes === "DESKTOP_UA" && elseBranch === "MOBILE_UA";
    const okWhen = /when/.test(cond) && /MODE_NATIVE[\s\S]{0,40}MOBILE_UA/.test(kt);
    if (!(okNativeMobile || okNotNative || okWhen)) {
      errors.push(
        "`userAgentFor` ne sert plus la page de bureau aux modes habillés : la coque recevrait le lecteur web mobile, qui refuse la lecture à un compte gratuit (« Lecture désactivée », §42) — l'inverse ferait servir la mise en page du bureau dans un écran de 412 px"
      );
    }
  }
  /* La règle sans sa raison se fait retourner au tour suivant : celui qui
     l'a écrite croyait bien faire. Le motif doit rester collé au code. */
  const doc = kt.slice(Math.max(0, kt.indexOf("private fun userAgentFor") - 1800), kt.indexOf("private fun userAgentFor"));
  if (!/mwp\.playback\.error\.protected\.content|Lecture désactivée/.test(doc) || !/§42/.test(doc)) {
    errors.push(
      "l'explication de l'agent n'est plus écrite au-dessus de `userAgentFor` : sans la cause mesurée (page mobile = lecture refusée hors Premium), la règle est inversée à la prochaine passe"
    );
  }
  /* La barre de lecture de Spotify doit rester de côté **quelle que soit
     l'étiquette** que la page lui donne : `aside` sur la page de bureau,
     `footer`/`div` sur celle du téléphone. Ne connaître que `aside`, c'est
     laisser la sienne réapparaître sous la nôtre dès que l'agent change. */
  const parked = read("src/inject/10-base.css");
  for (const tag of ["aside", "footer", "div"]) {
    if (!new RegExp(`${tag}\\[data-testid="now-playing-bar"\\]`).test(parked)) {
      errors.push(`la feuille ne met de côté la barre de lecture que sous l'étiquette « aside » : la page ${tag === "div" ? "du téléphone" : tag} la rendrait sous la nôtre`);
    }
  }
  /* La sonde doit mesurer **la configuration livrée** : l'agent vient du champ
     `agent` de la cible (et non d'un goût par défaut), et un contexte existe
     pour chacune des deux pages en cause, sur la vraie URL. */
  const probe = read("tools/probe-coop.mjs");
  if (!/setUserAgent\(target\.agent === "tel" \? MOBILE_UA : DESKTOP_UA\)/.test(probe)) {
    errors.push("la sonde de CI ne choisit plus l'agent par cible : elle peut valider une page que le téléphone ne reçoit pas");
  }
  for (const label of ['label: "coque-bureau"', 'label: "coque-mobile"']) {
    if (!probe.includes(label)) {
      errors.push(`la sonde de CI n'a plus de contexte ${label} : la mise en page réellement livrée n'est plus mesurée sur la vraie page`);
    }
  }
  if (!/d\u00e9passe|trop large pour l'\u00e9cran/.test(probe)) {
    errors.push("la sonde de CI n'a plus de règle « mise en page trop large pour l'écran » : le défaut de la 2.11.19 redeviendrait invisible");
  }
}

/* --------------------------------------------------------------------------
   11. La chaîne de lecture, de l'appui à Android. Elle traverse quatre
   fichiers qui ne s'importent jamais entre eux (coque → pont Kotlin → moteur
   d'origine → notification), donc **rien** d'autre que ce groupe ne la voit.
   Elle a cassé deux fois de la même manière : un maillon qui croit avoir
   réussi sans avoir agi (2.11.19 : le bouton `disabled` ; 2.11.21 : l'appel
   `actPlayPause` compté comme un appui), et un maillon qui détourne le trafic
   de la page pour son propre compte (la 2.11.21, précisément : le capteur
   renvoyait le flux d'état du lecteur par `HttpURLConnection` — plus aucune
   touche du bas ne répondait).
   -------------------------------------------------------------------------- */
{
  /* La source, pas le bundle : `regress-audit` mutera ces fichiers pour prouver
     que ces garde-fous tombent — et un contrôle qui lit `dist/` ne verrait
     jamais la main mise sur `src/`. */
  const shell = runtime;
  const kt = activitySource;
  /* 1 · la porte du moteur doit juger l'appui, pas l'appel. */
  if (!/addEventListener\("click", spy, true\)/.test(shell) || !/return pressed;/.test(shell)) {
    errors.push(
      "`Engine.toggle` ne vérifie plus que le bouton a réellement reçu l'événement : un `actPlayPause` qui ne presse rien sera cru réussi, et la coque renoncera à son propre secours"
    );
  }
  /* 2 · l'ordre des secours, qui est une décision. */
  const iToggle = shell.indexOf("Engine.toggle(want)");
  const iMedia = shell.indexOf("this.mediaToggle(go === null");
  const iApi = shell.indexOf("return Engine.playContext()");
  if (!(iToggle > 0 && iMedia > iToggle && iApi > iMedia)) {
    errors.push("l'ordre markup → moteur → élément → API Connect n'est plus tenu (la voie réseau ne doit jamais couper court aux voies vérifiées)");
  }
  if (!/e\.playUri\(uri\);[\s\S]{0,1400}?Engine\._sent = \{ want: true, uri: uri, at: Date\.now\(\) \};\s*return true;/.test(shell)) {
    errors.push("`Engine.playContext` ne marque plus la commande « partie » : playPause ne peut plus savoir qu'un secours immédiat tuerait la lecture, et « j'appuie, rien » revient");
  }
  /* Le solde, pas la promesse : `settleSent` branché sur `Engine.sync` est la seule
     raison pour laquelle une lecture réussie ne laisse pas la coque muette quatre
     secondes, le temps que la commande expire. Couper ce fil ne casse rien de
     visible — la touche de pause ne répond plus une fois, et rien ne le dit. */
  if (!/Engine\.settleSent\(!!st\.playing\);/.test(shell)) {
    errors.push("le solde de commande n'est plus branché sur `Engine.sync` : après une lecture réussie, la coque croit la commande encore en cours et ne presse plus rien");
  }
  /* 3 · le capteur écoute, il n'intercepte pas. */
  const logic = read("dist/spotiduck-logic.js");
  if (/resp\s*=\s*await mngFetch\(url,opts\)/.test(logic) || !/return oriFetch\.apply\(this, args\);/.test(logic)) {
    errors.push(
      "le capteur du moteur intercepte à nouveau le trafic `connect-state` de la page : le flux d'état du lecteur passe par le pont, `AbortSignal` et le streaming disparaissent — « les touches du bas ne font plus rien »"
    );
  }
  /* 4 · le moteur est posé avant la page, sinon il n'a rien à capter. */
  const iLogic = kt.indexOf("view.evaluateJavascript(logicScript, null)");
  const iIdentity = kt.indexOf("view.evaluateJavascript(identityScript, null)");
  if (!(iLogic > 0 && iIdentity > iLogic)) {
    errors.push("le moteur n'est plus injecté **avant** l'identité et la page dans `onPageStarted` : le `Client-Token` et l'appareil de la session auront déjà été émis, et `playFromUri` n'aura pas d'appareil où commander");
  }
  if (!/readAsset\("spotiduck-logic\.js"\)/.test(kt)) {
    errors.push("`MainActivity` ne lit plus l'asset `spotiduck-logic.js` : la coque retombe sur le seul markup de Spotify");
  }
  /* 5 · le verrou du corps repris, pas de la formulation : le capteur est
     désormais suivi d'une ligne de la coque, et cette ligne doit rester la
     seule qu'on ait ajoutée à un bloc d'origine. */
  const locksPath = "tools/build-logic.locks.json";
  if (existsSync(join(root, locksPath))) {
    const locks = JSON.parse(read(locksPath)).blocks || {};
    /* La liste des blocs est lue la ou elle est ecrite (tools/build-logic.mjs) :
       la dupliquer ici, c'est un bloc ajoute oublie de l audit — et un bloc oublie,
       c est exactement ce qui etait arrive a « veille » et « installation ». */
    const sliceNames = [...read("tools/build-logic.mjs").matchAll(/^\s+name:\s*"([^"]+)"/gm)].map((m) => m[1]);
    if (!sliceNames.length) errors.push("aucun bloc trouve dans tools/build-logic.mjs : la liste des verrous n est plus verifiable");
    for (const name of sliceNames) {
      if (!locks[name] || !locks[name].len || locks[name].md5 === "0000000000") {
        errors.push(`le verrou du bloc d'origine « ${name} » n'est pas posé : un bloc sans empreinte n'est pas du code repris tel quel — relire le découpage, puis \`node tools/build-logic.mjs --record-locks\``);
      }
    }
  } else {
    errors.push("`tools/build-logic.locks.json` est absent : rien ne garantit que le moteur soit encore du code d'origine");
  }
  /* 5ter · le relais « Écouter sur cet appareil », qui conditionne tout le reste.
     La sonde de CI a relevé nos quatre commandes de transport trouvées mais
     DÉSACTIVÉES sur la page réelle : tant que le relais n'est pas pressé, aucun
     bouton du lecteur ne peut répondre. Les quatre fils ci-dessous sont ce qui fait
     que la coque le trouve, le tente et s'en souvient après un redessin de la page.
     Chacun a été cassé un par un dans `tools/regress-audit.mjs`. */
  {
    /* `]` clamp dans chaque sélecteur entre guillemets : la liste doit être saisie
       jusqu'à sa virgule de fin de ligne, sinon on sonde un tronçon. */
    const takeover = (runtime.match(/takeover: \[[\s\S]{0,900}?\],\n/) || [""])[0];
    const rows = (runtime.match(/takeoverRows: \[[\s\S]{0,500}?\],\n/) || [""])[0];
    /* Une punaise sur `aside` ne suffit plus depuis que la barre livrée est un
       `footer` (dit notre 10-base.css) : la forme sans étiquette est la seule qui
       ne dépende pas d'un choix de balise fait par Spotify ce mois-ci. */
    /* Un sélecteur punaisé sur `footer[…]" en contient aussi un `[data-testid=…]` :
       ce qui compte, c'est la forme **sans étiquette de balise**, donc celle qui
       commence par le crochet. */
    if (!/'\[data-testid="now-playing-bar"\]/.test(takeover) || !/'\[data-testid="now-playing-bar"\]/.test(rows)) {
      errors.push("les candidats du relais ne couvrent plus la barre quelle que soit sa balise : sur la page où le lecteur est un <footer>, le relais ne sera jamais trouvé et les commandes resteront désactivées");
    }
    if (!/vous écoutez sur/.test(runtime)) {
      errors.push("le libellé réel du lecteur mobile (« Vous écoutez sur », relevé dans ses fichiers de langue par la sonde) n'est plus reconnu : le relais ne serait pas cliqué hors de la traduction française du web player de bureau");
    }
    if (!/var relais = want \? Auto\.maybeTakeover\(\) : false;/.test(runtime)) {
      errors.push("le relais n'est plus tenté quand la page refuse la commande : c'est pourtant le seul cas où il sert (boutons présents mais désactivés)");
    }
    if (!/this\._watchBar === bar/.test(runtime) || !/Auto\.watch\(\);/.test(runtime)) {
      errors.push("le guetteur du relais n'est plus rebranché quand la barre est remplacée : après un redessin du lecteur, plus aucun relais ne serait tenté de la session");
    }
    if (!/if \(this\._blames >= 2\) \{\s*this\._blames = 0;\s*Content\.commandFailure\(\);/.test(runtime)) {
      errors.push("deux commandes sans effet n'ouvrent plus la carte du rapport : « le lecteur ne répond pas » redevient un symptôme sans mesure, et la seule voie pour la décrire disparaît");
    }
  }

  /* 6 · le rapport d'état, un seul maître. */
  if (!/fun recMediaStatus\(/.test(bridgeSource) || !/manageTSleep\(/.test(bridgeSource)) {
    errors.push("le pont ne déduit plus les minuteries de l'état rapporté : la coque et le moteur devraient commander chacun de leur côté");
  }
}

/* Rapport ------------------------------------------------------------------ */
const size = (n) => String(n).padStart(2);
console.log(`\nSpotiDuck — liens internes\n`);
console.log(`  pont           ${size(kotlinMethods.size)} méthodes Kotlin · ${size(usedBridgeNames.size)} appelées par la couche`);
console.log(`  classes sd-     ${size(defined.size)} stylées · ${size(usedClasses.size)} posées par le runtime`);
console.log(`  ressources      ${size(definedStrings.size)} chaînes`);
console.log(`  modules JS      ${size(moduleKeys.size)} modules · ${size([...moduleKeys.values()].reduce((n, k) => n + k.size, 0))} méthodes\n`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
if (!errors.length && !warnings.length) console.log("  ✓ tout concorde");
console.log(`\n  ${errors.length} erreur(s), ${warnings.length} avertissement(s)\n`);
process.exit(errors.length ? 1 : 0);
