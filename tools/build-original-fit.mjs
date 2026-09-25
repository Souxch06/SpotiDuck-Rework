#!/usr/bin/env node
/**
 * Porte la feuille « tenir dans l'écran » de l'application d'origine.
 *
 *   node tools/build-original-fit.mjs          # vérifie (sort en erreur si périmé)
 *   node tools/build-original-fit.mjs --write  # (re)génère src/inject/05-original-fit.css
 *
 * Pourquoi un outil, et pas un copier-coller à la main : cette feuille est le
 * mécanisme par lequel l'application d'origine fait tenir une page **bureau**
 * (celle de Spotify) sur l'écran d'un téléphone. Elle est mesurable et elle a
 * un coût quand elle manque — mesuré par la sonde `probe-coop` :
 *
 *     mise en page=412px · contenu=800×731 · débordement=388
 *
 * Autrement dit, sans elle, la page est deux fois plus large que l'écran : texte
 * rogné, page à faire glisser de côté, « l'affichage n'est plus adapté à
 * Android ». La reprendre telle quelle, c'est prendre le code de SpotiDuck pour
 * la mise en page de son contenu, et garder notre coque pour l'interface.
 *
 * Deux transformations seulement, et elles sont motivées :
 *
 *   1. **Portée `html.sd-mobile .sd-root`** — la feuille d'origine visait une
 *      page où elle était seule. Chez nous, la coque est posée sur la même page
 *      et nos propres feuilles (10-…) doivent pouvoir reprendre la main : on
 *      préfixe donc chaque sélecteur, au lieu de laisser des règles globales
 *      (`*`, `body`, `main`) frapper aussi notre couche.
 *   2. **`*{transition:none}` est écartée** : elle éteignait les transitions de
 *      la couche d'origine, mais couperait aussi celles de notre coque (mini-
 *      lecteur, onglets). Ce n'est pas une règle de mise en page.
 *
 * Le reste est repris **au caractère près**, y compris les `!important` et les
 * `display:none` qui retirent le mobilier de la page bureau (bandeau marketing,
 * lien de téléchargement, pied de page, info-bulles).
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src/original/spotiduck-original.js");
const TARGET = join(ROOT, "src/inject/05-original-fit.css");

const original = await readFile(SOURCE, "utf8");

/* La feuille est posée par le script d'origine juste avant `appendChild` :
   `let st = document.createElement("style"); st.textContent = "…";` */
const match = original.match(/createElement\("style"\);\s*st\.textContent\s*=\s*"((?:[^"\\]|\\.)*)";/);
if (!match) {
  console.error("✗ feuille d'origine introuvable dans src/original/spotiduck-original.js");
  process.exit(1);
}
const css = JSON.parse('"' + match[1] + '"');

/* « * » tout court ne vise pas notre coque ; « body » non plus (la page, c'est
   le `<body>`). Tout le reste passe sous `html.sd-mobile .sd-root`. */
const scope = (selector) => {
  const s = selector.trim();
  if (!s) return s;
  if (s === "*") return "html.sd-mobile .sd-root *";
  if (s === "body") return "html.sd-mobile body";
  if (s.startsWith("html") || s.startsWith(":root")) return s;
  return "html.sd-mobile .sd-root " + s;
};

const kept = [];
const dropped = [];
for (const block of css.split("}")) {
  const at = block.indexOf("{");
  if (at < 0) continue;
  const selectors = block.slice(0, at).trim();
  const body = block.slice(at + 1).trim();
  if (!selectors || !body) continue;
  /* Écartée : elle éteint les transitions de *tout* le document, donc de notre
     coque aussi. Elle ne participe pas à la mise en page. */
  if (selectors === "*" && /transition\s*:\s*none/.test(body)) {
    dropped.push(selectors);
    continue;
  }
  kept.push(
    selectors
      .split(",")
      .map((s) => scope(s))
      .join(", ") + " {\n  " + body.replace(/;\s*/g, ";\n  ").replace(/;\n\s*$/, ";") + "\n}"
  );
}

const header = `/* ==========================================================================
   05 — Tenir dans l'écran : la feuille de l'application d'origine

   Fichier **généré** par \`tools/build-original-fit.mjs\` depuis
   \`src/original/spotiduck-original.js\` (la feuille que le script d'origine pose
   avant \`document.head.appendChild(st)\`, elle-même déchiffrée de
   \`C1356q3\`). Ne pas modifier à la main : relancer l'outil.

   C'est cette feuille qui fait tenir une page **bureau** — celle de Spotify —
   sur l'écran d'un téléphone. Mesuré sans elle, dans les conditions de la
   WebView (sonde \`probe-coop\`) :

       mise en page=412px · contenu=800×731 · débordement=388

   Autrement dit, deux fois plus large que l'écran : texte rogné, page à faire
   glisser de côté. C'est le reproche « l'affichage n'est plus adapté à Android ».

   Deux écarts, et deux seulement (voir l'en-tête de l'outil) : les sélecteurs
   sont portés sous \`html.sd-mobile .sd-root\` pour que nos propres feuilles
   puissent reprendre la main, et \`*{transition:none}\` est écartée parce
   qu'elle éteindrait aussi les transitions de notre coque. Le reste est repris
   au caractère près.

   Empreinte de la feuille d'origine : ${createHash("md5").update(css).digest("hex")} (${css.length} caractères).
   ========================================================================== */

`;

const result = header + kept.join("\n\n") + "\n";
const previous = await readFile(TARGET, "utf8").catch(() => null);

if (process.argv.includes("--write")) {
  await writeFile(TARGET, result);
  console.log(`✔ src/inject/05-original-fit.css (${kept.length} règles, ${result.length} octets, ${dropped.length} écartée)`);
} else if (previous !== result) {
  console.error("✗ src/inject/05-original-fit.css ne correspond plus à la feuille d'origine — relancer avec --write");
  process.exit(1);
} else {
  console.log(`✔ feuille d'origine portée (${kept.length} règles, ${css.length} caractères à l'origine)`);
}
