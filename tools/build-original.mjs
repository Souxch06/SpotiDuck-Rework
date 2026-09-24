#!/usr/bin/env node
/**
 * Prépare l'**interface d'origine** pour l'application.
 *
 *     node tools/build-original.mjs        (npm run build:original)
 *
 * `src/original/spotiduck-original.js` est le code d'origine repris tel quel
 * (voir l'en-tête du fichier et `src/original/README.md`). Ce script ne le
 * modifie pas : il vérifie qu'il est bien intact et le copie là où
 * l'application le charge.
 *
 * Les contrôles portent sur ce qui se casserait **silencieusement** :
 *
 *   · la feuille de style d'origine (6 001 caractères, md5 `13de5546d0…`) —
 *     c'est elle qui dessine l'interface, une altération ne se verrait qu'à
 *     l'écran ;
 *   · les fonctions d'origine que l'application appelle (`actPlayPause`,
 *     `actSkipForward`, `actSkipBack`, `actSeek`, `actAddToFav`, `actRepeat`,
 *     `updMedia`, `switchLs`, `addCSSJSHack`…) ;
 *   · les méthodes du pont que le script utilise (`AndBridge.nFetch`, etc.) :
 *     si l'une manque côté Kotlin, la lecture ou la bibliothèque s'arrêtent
 *     sans message.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const SOURCE = "src/original/spotiduck-original.js";
const FINGERPRINT = "src/original/spotiduck-fingerprint.js";
/* Empreintes des deux blocs d'origine — voir l'en-tête du fichier source. */
const CSS_MD5 = "13de5546d0";
const CSS_LENGTH = 6001;
const REQUIRED = [
  "window.mngFetch",
  "window.playFromUri",
  "window.firstFuck",
  "window.manageAll",
  "window.actPlayPause",
  "window.actSkipBack",
  "window.actSkipForward",
  "window.actRepeat",
  "window.actAddToFav",
  "window.actSeek",
  "window.addCSSJSHack",
  "window.addAutoFeatures",
  "window.addAndAuto",
  "window.switchLs",
  "window.updMedia",
  "window.SpotiDuckUI",
  "AndBridge.nFetch",          // le pont réseau du script d'origine
  "window.updMedia",           // rapporteur d'état → notification Android
  "window.mngFetch = async",   // requêtes de lecture hors WebView
];

const problems = [];
const original = read(SOURCE);

// 0. l'empreinte de navigateur (injectée avant la page) ----------------------
/* Elle n'a pas de « forme » reconnaissable, mais ce sont les valeurs qu'elle
   pose qui décident de la mise en page : si elles changent, l'affichage
   change. */
const fingerprint = read(FINGERPRINT);
for (const expected of [
  'window.screen.__defineGetter__("width"',
  'return 1920;',
  'return 1080;',
  'return 978;',
  'window.__defineGetter__("devicePixelRatio"',
  'navigator.__defineGetter__("userAgent"',
  'getHighEntropyValues',
]) {
  if (!fingerprint.includes(expected)) {
    problems.push(`empreinte d'origine incomplète : ${expected} est absent`);
  }
}
if (fingerprint.length < 4_000 || fingerprint.length > 7_000) {
  problems.push(`l'empreinte d'origine fait ${fingerprint.length} caractères (4 000 à 7 000 attendus)`);
}

// 1. la feuille de style d'origine -------------------------------------------
const styleMatch = original.match(/textContent\s*=\s*"((?:[^"\\]|\\.)*)"/);
if (!styleMatch) {
  problems.push("la feuille de style d'origine est introuvable dans le script");
} else {
  const css = JSON.parse('"' + styleMatch[1] + '"');
  const md5 = createHash("md5").update(css).digest("hex").slice(0, 10);
  if (css.length !== CSS_LENGTH || md5 !== CSS_MD5) {
    problems.push(`la feuille de style d'origine a changé (${css.length} car., md5 ${md5})`);
  }
}

// 2. les fonctions d'origine -------------------------------------------------
for (const fn of REQUIRED) {
  if (!original.includes(fn)) problems.push(`fonction d'origine absente : ${fn}`);
}

// 3. le pont attendu par le script ------------------------------------------
const bridgeKt = read("android/app/src/main/java/com/spotiduck/app/Bridge.kt");
const needed = new Set(
  [...original.matchAll(/AndBridge\.(\w+)\s*\(/g)].map((m) => m[1])
);
const available = new Set(
  [...bridgeKt.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map((m) => m[1])
);
for (const name of needed) {
  if (!available.has(name)) problems.push(`AndBridge.${name}() est appelé par le script mais absent de Bridge.kt`);
}

// 4. l'injection -------------------------------------------------------------
if (original.includes("</script>")) {
  problems.push("le script contient un </script> littéral : l'injection WebView casserait");
}

if (problems.length) {
  console.error("interface d'origine — contrôle échoué :");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

// copie ---------------------------------------------------------------------
const banner =
  "/* SpotiDuck — interface d'origine (voir src/original/README.md). Copie de " +
  SOURCE +
  " ; ne pas modifier ici. */\n";
const out = banner + original;

mkdirSync(join(root, "dist"), { recursive: true });
for (const target of ["dist/spotiduck-original.js", "android/app/src/main/assets/spotiduck-original.js"]) {
  const dir = join(root, target);
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(dir, out);
}
const fpOut = banner + fingerprint;
for (const target of ["dist/original-fingerprint.js", "android/app/src/main/assets/original-fingerprint.js"]) {
  writeFileSync(join(root, target), fpOut);
}
const size = Buffer.byteLength(out);
console.log(`✔ interface d'origine  (${(size / 1024).toFixed(1)} kB)`);
console.log(`✔ empreinte d'origine  (${(fpOut.length / 1024).toFixed(1)} kB, 1920×1080 bureau)`);
console.log(`  ${needed.size} méthodes du pont · ${REQUIRED.length} fonctions d'origine · feuille ${CSS_LENGTH} car. (md5 ${CSS_MD5})`);
if (!existsSync(join(root, "dist/spotiduck-original.js"))) process.exit(1);
