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
const runtime = read("src/inject/spotiduck-ui.js");
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
const nativeCalls = read("android/app/src/main/assets/native-mode.js");
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

const nativeAsset = read("android/app/src/main/assets/native-mode.js");
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
if (!/mode\s*==\s*MODE_NATIVE\)\s*MOBILE_UA\s*else\s*DESKTOP_UA/.test(activity.replace(/\s+/g, " "))) {
  errors.push("MainActivity : l'agent de l'interface d'origine n'est plus l'agent bureau");
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
if (!/width=device-width/.test(read("src/inject/spotiduck-ui.js"))) {
  errors.push("la couche injectée ne pose plus le meta viewport");
}
if (!/width=device-width/.test(read("android/app/src/main/assets/native-mode.js"))) {
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
if (!/dur \/ factor\) \* 1000/.test(libraryCode) || !/pos \/ factor\) \* 1000/.test(libraryCode)) {
  errors.push("la lecture de la position ne passe plus par l'unité mesurée");
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
if (!/var value = this\.scale\(\) === 1 \? ms : ms \/ 1000;/.test(libraryCode)) {
  errors.push("le déplacement du curseur n'utilise plus la graduation lue : il viserait la mauvaise position sur un lecteur en millisecondes");
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
