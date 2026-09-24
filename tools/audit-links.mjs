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
const NOT_STYLED_ON_PURPOSE = new Set(["sd-density-normal", "sd-login-done", "sd-tap", "sd-welcome"]);
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

/* 2-quater. Le mode livré par défaut. Ce n'est pas une broutille : le 2.6.0 a
   expédié la page web mobile de Spotify comme interface par défaut sans qu'on
   puisse en sortir, et il a fallu deux versions pour revenir en arrière. Le
   défaut est donc une décision explicite, surveillée ici : c'est
   l'**affichage mobile**, c'est-à-dire la page que Spotify sert à un
   téléphone. Jamais notre propre habillage : une coque maison livrée par
   défaut, c'est ce que l'utilisateur avait justement refusé. */
const activity = read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
for (const stale of ["the two interfaces", "MODE_INJECT is the default"]) {
  if (activity.includes(stale)) errors.push(`MainActivity : commentaire périmé (« ${stale} »)`);
}
if (!/MODE_DEFAULT\s*=\s*MODE_NATIVE/.test(activity)) {
  errors.push("MainActivity : le mode par défaut n'est plus l'affichage mobile");
}
if (/MODE_DEFAULT\s*=\s*MODE_INJECT/.test(activity)) {
  errors.push("MainActivity : le mode par défaut est redevenu notre habillage");
}
/* …et le mode par défaut doit rester quittable **depuis lui-même**, sans
   réinstaller : c'est ce qui manquait à la 2.6.0. Dans le mode mobile, le seul
   chemin vers le sélecteur est l'appui long de `native-mode.js`. */
if (!/MODE_NATIVE,\s*MODE_ORIGINAL,\s*MODE_INJECT/.test(activity.replace(/\s+/g, " "))) {
  errors.push("MainActivity : le sélecteur d'interface ne propose plus les trois modes");
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
if (!/isAdAudio/.test(activity) || !/sniffContentType/.test(activity)) {
  errors.push("MainActivity : les publicités audio ne sont plus détectées avant blocage");
}

/* La session doit survivre à une mise à jour. Trois choses le garantissent, et
   chacune peut disparaître sans que rien ne casse visiblement — jusqu'au jour où
   l'utilisateur doit se reconnecter :
     · les cookies ne sont **jamais** effacés (aucun `removeAllCookies`) ;
     · ils sont **écrits sur le disque** au bon moment : fin de page du lecteur,
       connexion détectée, pause, arrêt — la WebView le fait paresseusement, et
       une mise à jour tue le processus avant ;
     · une copie de secours est gardée et remise si la WebView n'a plus rien.
   Enfin, un lien de connexion doit exister : les boutons sociaux ne fonctionnent
   pas dans une WebView, et sans le bouton « e-mail et mot de passe » la page de
   connexion de Spotify n'offre que des impasses. */
if (/removeAllCookies|removeSessionCookies/.test(activity)) {
  errors.push("MainActivity : la session est effacée (removeAllCookies) — plus rien ne survivra à une mise à jour");
}
for (const need of ["flushCookies", "saveCookies", "restoreCookies", "KEY_COOKIES"]) {
  if (!new RegExp(need).test(activity)) errors.push(`MainActivity : ${need} a disparu — la session ne survivra plus à une mise à jour`);
}
if (!/restoreCookies\(\)[\s\S]{0,3000}?loadUrl\(/.test(activity)) {
  errors.push("MainActivity : la session restaurée n'est plus remise avant le chargement de la page");
}
const lifecycle = activity.replace(/\s+/g, " ");
if (!/override fun onPause[\s\S]{0,200}?flushCookies/.test(activity)) {
  errors.push("MainActivity : les cookies ne sont plus écrits à la mise en arrière-plan");
}
if (!/override fun onStop[\s\S]{0,300}?saveCookies/.test(activity)) {
  errors.push("MainActivity : la copie de secours n'est plus prise à l'arrêt");
}
if (!/url\.contains\("open\.spotify\.com"\)[\s\S]{0,300}?saveCookies/.test(activity)) {
  errors.push("MainActivity : la session n'est plus enregistrée en fin de chargement du lecteur");
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
