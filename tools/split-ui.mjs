#!/usr/bin/env node
/**
 * Découpe la coque en modules — une section = un fichier.
 *
 *     node tools/split-ui.mjs            (écrit src/inject/ui/, réécrit la coque)
 *     node tools/split-ui.mjs --dry      (montre le découpage, n'écrit rien)
 *
 * La règle de cette passe est une règle de **construction**, pas de style : le
 * bundle généré doit sortir **identique octet pour octet** après la découpe. C'est
 * ce qui la distingue d'un remaniement : un remaniement se juge à « c'est plus
 * joli », une découpe se juge à `cmp` sur `dist/spotiduck-ui.js` et aux 154
 * assertions de fumée. Si un octet bouge, l'outil refuse d'écrire.
 *
 * Ce que l'outil ne fait pas, volontairement :
 *   · il ne réécrit aucun texte. Chaque fichier de `src/inject/ui/` contient le
 *     morceau de la coque, indentation comprise (deux espaces : le corps est celui
 *     de l'IIFE). C'est ce qui rend la recollerie triviale et vérifiable — un
 *     `dédentage` ici serait une cause de faux écarts ;
 *   · il ne touche pas à l'ordre des sections : l'ordre est le numéro gravé dans la
 *     bannière, donc dans le nom du fichier, donc dans le tri. Pas de liste à
 *     entretenir à la main (c'est exactement le défaut qu'on vient de corriger sur
 *     les feuilles CSS et sur les verrous du moteur) ;
 *   · il ne découpe pas **à l'intérieur** d'une section. Une fonction qui lit la
 *     page et une fonction qui la dessinent dans le même fichier, c'est le contrat
 *     d'origine de la coque : « Spotify adapter », c'est un seul fichier parce que
 *     c'est une seule idée, avec ses 1 000 lignes.
 *
 * Le point de coupe est la bannière de section, telle qu'elle est écrite depuis le
 * début du projet : trois lignes, deux traits de 70 tirets qui encadrent le titre
 * numéroté (« 10. Actions — optimistic UI + verification »). Les titres sur plusieurs
 * lignes sont admis (sections 7, 11, 13).
 *
 * Note d'expérience, posée là parce qu'elle dit quelque chose de l'exercice : la
 * bannière ne peut PAS être recopiée telle quelle dans ce commentaire — sa
 * troisième ligne ferme le bloc, et le fichier ne se parse plus. C'est exactement le
 * défaut que la règle 1 du portique attrape, et c'est en écrivant cet outil qu'on
 * l'a rencontré trois fois.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src/inject");
const SHELL = join(SRC, "spotiduck-ui.js");
const MODS = join(SRC, "ui");
export const MARKER = "  /* @@MODULES@@ */";

/* Une frontière = une bannière de section : deux traits de tirets de 70 colonnes,
   un titre entre les deux. Les sections numérotées (« 10. Actions … ») sont les plus
   anciennes ; les autres (« Sheets », « Library », « Cache »…) sont nées des passes
   ultérieures et n'ont pas de numéro. Les deux formes comptent : la règle est la
   **forme** de la bannière, pas son numéro — sinon la découpe laisse un bloc de
   4 366 lignes sous le nom du premier module rencontré, ce que la première
   tentative de cet outil a exactement fait. */
const BANNER = /^ {2}\/\* -{60,} \*\n(?: {3}\*.*\n)*? {3}\* -{60,} \*\/\n/gm;

const src = readFileSync(SHELL, "utf8");
const banners = [];
for (const m of src.matchAll(BANNER)) {
  /* Le titre = les lignes entre les deux traits. La dernière ligne du bloc est le
     trait de fermeture, et la regex s'arrête aprs le 
 : deux lments retirer, pas
     un : sinon le titre embarque le trait de fermeture (soixante tirets et la fin du
     bloc), et le nom de fichier avec lui. */
  const title = m[0]
    .split("\n")
    .slice(1, -2)
    .map((l) => l.replace(/^ {3}\* ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const num = /^\s*(\d+)\.\s/.exec(m[0].split("\n")[1] || "");
  banners.push({ start: m.index, num: num ? num[1] : null, title: title.replace(/^\s*\d+\.\s*/, "") });
}
if (banners.length < 25) {
  console.error(`\n  Seulement ${banners.length} bannières de section reconnues (25 attendues au minimum) : le format a change, la decoupe est abandonnee.\n  Un decoupage silencieux sur un format non reconnu est exactement le genre d'accident qu'on est venu corriger.\n`);
  process.exit(1);
}

/* Les pièces : de la bannière k à la bannière k+1, la dernière allant jusqu'à la
   fin du corps de l'IIFE. La « tête » (en-tête du fichier + ouverture de l'IIFE)
   et la « queue » (fermeture) restent dans la coque. */
const iifeClose = src.lastIndexOf("\n})();");
if (iifeClose < banners[banners.length - 1].start) {
  console.error("  Introuvable : la fermeture de l'IIFE. Découpe abandonnée.");
  process.exit(1);
}
const head = src.slice(0, banners[0].start);
const tail = src.slice(iifeClose);
const pieces = banners.map((b, i) => {
  const end = i + 1 < banners.length ? banners[i + 1].start : iifeClose;
  return { ...b, index: i, end, text: src.slice(b.start, end) };
});
const glue = head + pieces.map((p) => p.text).join("") + tail;
if (glue !== src) {
  console.error("  Le recollement ne reproduit pas le fichier d'origine (dérive de " + (glue.length - src.length) + " octets) : j'abandonne avant d'écrire.");
  process.exit(1);
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "not", "are", "was", "into", "our", "their", "its", "but", "nor", "so", "as", "at", "on", "of", "to", "in", "is", "it", "a"]);
const slug = (title) => {
  const cleaned = title
    /* Les titres portent la numérotation historique des passes (« 10-bis. »,
       « 11e-ter. », « 5 bis. ») : elle ne dit rien du contenu et polluerait le nom. */
    .replace(/^\s*\d+\s*(?:[-.]?\s*[a-zà-ÿ]+)*\.?\s*/i, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^(bis|ter|quater|quinquies|ies|suite|\d+$)/.test(w));
  return cleaned.slice(0, 3).join("-") || "module";
};

const plan = pieces.map((p) => ({
  file: `${String(p.index).padStart(3, "0")}-${slug(p.title)}.js`,
  lines: p.text.split("\n").length - 1,
  chars: p.text.length,
  title: p.title,
  num: p.num,
}));

/* Un module qui ne se parse pas **seul** n'est pas un module : c'est une frontière
   mal posée (coupe au milieu d'une déclaration). On le vérifie avant d'écrire. */
const badParse = [];
for (const p of pieces) {
  try {
    parse("(function () {" + p.text + "})", { ecmaVersion: "latest", sourceType: "script" });
  } catch (e) {
    badParse.push(`${p.num} — ${p.title.slice(0, 40)} : ${String(e.message).slice(0, 60)}`);
  }
}
if (badParse.length) {
  console.error("\n  Sections qui ne se lisent pas isolées (frontière mal posée) :\n    " + badParse.join("\n    ") + "\n");
  process.exit(1);
}

const t = plan.reduce((a, p) => Math.max(a, p.title.length), 0);
console.log(`\nSpotiDuck — découpe de la coque en modules (${plan.length} sections)\n`);
for (const p of plan) console.log(`  ${p.file.padEnd(34)} ${String(p.lines).padStart(5)} lignes · ${String(p.chars).padStart(6)} octets  ${(p.title.length > 62 ? p.title.slice(0, 62) + "…" : p.title)}`.trimEnd());
console.log(`\n  tête ${head.split("\n").length - 1} lignes · queue ${tail.split("\n").length - 1} lignes · total ${src.split("\n").length} lignes`);

if (process.argv.includes("--dry")) {
  console.log("\n  (--dry : rien n'a été écrit)\n");
  process.exit(0);
}

mkdirSync(MODS, { recursive: true });
for (const f of readdirSync(MODS)) rmSync(join(MODS, f), { recursive: true, force: true });
for (let i = 0; i < plan.length; i++) writeFileSync(join(MODS, plan[i].file), pieces[i].text, "utf8");
writeFileSync(SHELL, head + MARKER + "\n" + tail, "utf8");
console.log(`\n  → ${plan.length} modules dans src/inject/ui/ · coque réduite à ${(head.length + MARKER.length + tail.length)} octets (contre ${src.length})`);
console.log("  → le recollement est identique à l'original : vérifié avant écriture, pas après.\n");
