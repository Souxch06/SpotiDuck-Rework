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
   expédié la page web mobile de Spotify comme interface par défaut, sans
   connexion utilisable, et il a fallu une version entière pour revenir en
   arrière. Le choix reste donc sous surveillance. */
const activity = read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
if (!/MODE_DEFAULT\s*=\s*MODE_INJECT/.test(activity)) {
  errors.push("MainActivity : le mode par défaut n'est plus l'interface injectée");
}
/* Le mode « natif » ne doit être retenu que s'il a été choisi explicitement. */
if (!/KEY_UI_MODE_CHOSEN/.test(activity)) {
  errors.push("MainActivity : le mode enregistré n'est plus distingué d'un choix explicite");
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
