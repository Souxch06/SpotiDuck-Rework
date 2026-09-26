/**
 * La source de la coque, **assemblée**.
 *
 *     import { uiSource, UI_DIR, SHELL } from "./ui-source.mjs";
 *     const src = uiSource(root);
 *
 * Depuis la découpe en modules (`tools/split-ui.mjs`, v2.11.26), `src/inject/
 * spotiduck-ui.js` n'est plus qu'une enveloppe : l'en-tête, l'ouverture de l'IIFE,
 * un marqueur, la fermeture. Le corps vit un fichier par section dans
 * `src/inject/ui/`.
 *
 * Cet objet existe pour une raison : l'assemblage doit être **défini une fois**.
 * Six outils lisaient le fichier source à la main (audit, deux fumées, régressions,
 * sonde, générateur du moteur, portique) — si chacun connaissait l'ordre des
 * modules, la découpe aurait remplacé un monolithe par six monolithes en
 * désaccord. L'ordre vient du nom de fichier (numéro gravé par la bannière), donc
 * d'aucune liste à entretenir.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "  /* @@MODULES@@ */";
export const UI_SUBDIR = "src/inject/ui";
export const SHELL_SUBPATH = "src/inject/spotiduck-ui.js";

/** Les modules dans l'ordre d'assemblage : tri par nom, donc par numéro. */
export function uiModules(root) {
  const dir = join(root, UI_SUBDIR);
  const names = readdirSync(dir).filter((f) => /^\d{2,3}-.*\.js$/.test(f)).sort();
  return names.map((f) => ({ name: f, path: `${UI_SUBDIR}/${f}`, text: readFileSync(join(dir, f), "utf8") }));
}

/** Coque assemblée, octet pour octet ce que lisait tout le monde avant la découpe. */
export function uiSource(root) {
  const shell = readFileSync(join(root, SHELL_SUBPATH), "utf8");
  const parts = uiModules(root);
  if (!parts.length) {
    throw new Error(`${UI_SUBDIR}/ est vide : la coque n'a plus de modules. \`node tools/split-ui.mjs\`.`);
  }
  const n = shell.split(MARKER).length - 1;
  if (n !== 1) {
    throw new Error(
      `${SHELL_SUBPATH} contient ${n} marqueur ${MARKER.trim()} (il en faut exactement un) : ` +
        "l'assemblage ne saurait pas où poser les modules. Relancer tools/split-ui.mjs plutôt que d'éditer la coque à la main."
    );
  }
  const assembled = shell.replace(MARKER + "\n", () => parts.map((p) => p.text).join(""));
  /* Trois controles, tous bon marche / echec rapide :
       · la tete et la queue de l'enveloppe sont conservees telles quelles ;
       · chaque module apparait dans le texte assemble, une fois ;
       · la longueur totale est exactement ce qu'elle doit etre (ni morceau perdu,
         ni morceau double) — c'est ce que le portique revérifie de son cote. */
  if (!assembled.startsWith(shell.slice(0, shell.indexOf(MARKER)))) throw new Error("la tete de l'enveloppe a disparu de l'assemblage");
  for (const m of parts) {
    const first = assembled.indexOf(m.text);
    if (first < 0) throw new Error(`module ${m.name} absent de l'assemblage`);
    if (assembled.indexOf(m.text, first + 1) >= 0 && m.text.length > 40) {
      throw new Error(`module ${m.name} appears twice — deux bannières de même section ?`);
    }
  }
  const attendu = shell.length - (MARKER.length + 1) + parts.reduce((a, m) => a + m.text.length, 0);
  if (assembled.length !== attendu) {
    throw new Error(`assemblage de ${assembled.length} octets, attendu ${attendu} : un module n'est pas à sa place`);
  }
  return assembled;
}

/** Le numéro de chaque module, pour les règles du portique. */
export function uiNumbers(root) {
  return uiModules(root).map((p) => Number(p.name.match(/^\d+/)[0]));
}
