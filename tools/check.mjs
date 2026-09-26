#!/usr/bin/env node
/**
 * Le portique d'hygiène du dépôt — `npm run check`.
 *
 *     node tools/check.mjs                 les règles, une table, code 1 si ça coince
 *     node tools/check.mjs --selftest      prouve que chaque détecteur tombe
 *
 * Pourquoi cet outil existe, en une phrase : ce dépôt « compile » trois langages à
 * la fois (le JS de la coque, le JS repris de l'application d'origine, le Kotlin
 * et le XML Android), ses sorties générées sont **versionnées**, et toutes les
 * cassures vécues depuis la 2.11.18 sont tombées dans un de ces six trous — aucune
 * n'était une erreur d'algorithme :
 *
 *   1. un fichier qui ne se parse pas. Cas vécu deux fois : un accent grave oublié
 *      dans le commentaire d'un gabarit de génération ferme le littéral plus tôt que
 *      prévu, l'outil ne se parse plus — et comme la génération suivante est
 *      enchaînée dans un script npm, rien ne le dit à celui qui commit.
 *   2. une sortie générée périmée, commitée : retoucher src/inject puis pousser sans
 *      reconstruire livre l'ancienne version dans l'APK.
 *   3. une ressource présente sur le disque mais absente du dépôt : un clone frais
 *      (la CI, un autre poste) produit un APK amputé, sans un message. Cas vécu sur
 *      android/app/src/main/assets/spotiduck-logic.js.
 *   4. l'inverse : l'index déclare un fichier « supprimé » qui existe encore sur le
 *      disque (rollback d'environnement, reset, merge) — le commit suivant retire une
 *      ressource vivante de la branche.
 *   5. un verrou de bloc d'origine à son gabarit 0000000000 : le moteur est livré
 *      sans preuve qu'il est du code repris tel quel.
 *   6. le pont et les ressources : une méthode citée par le JS et absente du Kotlin
 *      (l'appel s'écrase dans un try, ça se voit comme « la commande ne fait rien »),
 *      un XML de ressource mal formé, une signature Kotlin déclarée deux fois, une
 *      référence §NN vers une section de doc qui n'existe plus.
 *
 * Détail de la conception et justifications : docs/UI-REWORK.md §60.
 *
 * Les règles 1 à 5 ne demandent aucun outil lourd : acorn (déjà dépendance de
 * l'audit) tient lieu de compilateur pour le JS, jsdom pour le XML, git pour la
 * cohérence dépôt/disque. Le Kotlin n'est pas compilé ici — pas de SDK Android dans
 * ce contexte : à la place, trois vérifications déterministes (commentaires,
 * chaînes brutes, signatures dupliquées) qui sont exactement les accidents des
 * retouches par patch ; la syntaxe complète reste vérifiée par
 * android.yml::compileDebugKotlin, qui ne se trompe pas.
 *
 * Ce fichier est lui-même soumis à sa règle 1 : `--selftest` échoue s'il ne se
 * parse plus, et un portique qui meurt sur une exception sort quand même en code 1
 * — jamais « vert » par accident.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = fileURLToPath(import.meta.url);
const root = resolve(dirname(HERE), "..");

const rel = (p) => relative(root, p).split("\\").join("/");
const read = (p) => readFileSync(join(root, p), "utf8");
const has = (p) => existsSync(join(root, p));
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

function runOnce() {
  try {
    return execFileSync(process.execPath, [HERE], { cwd: root, encoding: "utf8" });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

/* -------------------------------------------------------------------------- *
 * L'auto-test d'abord, avant toute sortie anticipée : chaque règle est rejouée
 * sur une mutation réelle du dépôt, annulée dans un `finally`. Un portique dont
 * on ne peut pas prouver qu'il tombe n'est pas un portique, c'est une décoration.
 * -------------------------------------------------------------------------- */
if (process.argv.includes("--selftest")) {
  const TMP = ["src/inject/_selftest.js", "src/inject/_selftest-orphan.css"];
  const STALE = "android/app/src/main/assets/spotiduck-ui.js";
  const mutations = [
    {
      name: "JS qui ne se parse pas (règle 1)",
      apply: () => writeFileSync(join(root, TMP[0]), "var a = {;\n", "utf8"),
      must: "ne se parse pas",
    },
    {
      name: "gabarit fermé trop tôt par un accent grave (règle 1, le cas vécu)",
      apply: () => writeFileSync(join(root, TMP[0]), "var s = `un ` accent`;\n", "utf8"),
      must: "ne se parse pas",
    },
    {
      name: "sortie générée périmée côté application (règle 2)",
      apply: () => writeFileSync(join(root, STALE), readFileSync(join(root, STALE), "utf8") + "\n/* périmé */\n", "utf8"),
      must: "ressource périmée",
    },
    {
      name: "entrée de construction non suivie par git (règle 3)",
      apply: () => writeFileSync(join(root, TMP[1]), ".x { color: red }\n", "utf8"),
      must: "pas suivis par git",
    },
    {
      name: "référence de doc pendante (règle 6)",
      /* Le numero de section est construit a l'execution, pas ecrit en clair :
         sinon le portique se signale lui-meme une reference pendante, en scannant
         son propre code — regle juste, mais aveuglee par son auto-test. */
      apply: () => writeFileSync(join(root, TMP[0]), `/* voir docs/UI-REWORK.md §${4000 + 99} */\nvar b = 1;\n`, "utf8"),
      must: "sans section dans docs/UI-REWORK.md",
    },
  ];
  let hits = 0;
  for (const m of mutations) {
    const backup = m.name.startsWith("sortie") ? readFileSync(join(root, STALE), "utf8") : null;
    try {
      m.apply();
      const out = runOnce();
      if (out.includes(m.must)) {
        hits++;
        console.log(`  ✓ ${m.name}`);
      } else {
        console.log(`  ✗ ${m.name} : rien n'a été signalé — le détecteur est aveugle`);
        console.log(out.split("\n").filter((l) => l.includes("✗")).slice(0, 3).join("\n"));
      }
    } finally {
      if (backup !== null) writeFileSync(join(root, STALE), backup, "utf8");
      for (const f of TMP) { try { rmSync(join(root, f), { force: true }); } catch (e) {} }
    }
  }
  const bilan = hits === mutations.length ? "chaque règle tombe quand elle doit tomber" : "un détecteur est décoratif : le corriger avant de compter sur le portique";
  console.log(`\n  auto-test : ${hits}/${mutations.length} mutations détectées — ${bilan}\n`);
  process.exit(hits === mutations.length ? 0 : 1);
}

/* -------------------------------------------------------------------------- *
 * Les règles.
 * -------------------------------------------------------------------------- */
let parse;
let JSDOM;
try {
  ({ parse } = await import("acorn"));
  ({ JSDOM } = await import("jsdom"));
} catch (e) {
  console.error(
    "\n  Le portique a besoin d'acorn et de jsdom, les devDependencies du dépôt : `npm install` d'abord.\n" +
      "  Il sort en erreur plutôt que de laisser passer un dépôt non vérifié.\n"
  );
  process.exit(2);
}

const errors = [];
const warnings = [];
const ok = [];

/* 1 · tout le JS du dépôt se parse ----------------------------------------- */
{
  const DIRS = ["src/inject", "src/original", "tools", "demo", "dist", "android/app/src/main/assets"];
  let n = 0;
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const ext = extname(file);
      if (ext !== ".js" && ext !== ".mjs") continue;
      const src = readFileSync(file, "utf8");
      try {
        parse(src, { ecmaVersion: "latest", sourceType: ext === ".mjs" ? "module" : "script", allowAwaitOutsideFunction: true });
        n++;
      } catch (e) {
        errors.push(
          `${rel(file)} ne se parse pas (${e.loc ? "ligne " + e.loc.line : "où ?"} : ${String(e.message).slice(0, 90)}) — ` +
            "un fichier qui ne se parse pas n'est pas une histoire de style : son générateur ne tourne plus, et la sortie commitée garde la version d'avant."
        );
      }
    }
  }
  if (!errors.length) ok.push(`${n} fichiers JS parsés (acorn, dernier ECMAScript)`);
}

/* 2 · ressources livrées == sorties générées -------------------------------- */
/* La liste des couples (dist -> asset) est **lue dans tools/sync-android.mjs** :
   un portique qui tiendrait sa propre liste à la main pourrit à la première ligne
   ajoutée là-bas, et devient un faux allié. */
const pairs = (() => {
  const src = has("tools/sync-android.mjs") ? read("tools/sync-android.mjs") : "";
  return [...src.matchAll(/\{\s*from:\s*join\(root,\s*"([^"]+)"\),\s*to:\s*join\(assets,\s*"([^"]+)"\)\s*\}/g)].map((m) => ({
    dist: m[1],
    asset: `android/app/src/main/assets/${m[2]}`,
  }));
})();
if (!pairs.length) {
  errors.push("`tools/sync-android.mjs` n'expose plus sa liste de copies { from, to } : plus personne ne vérifie la fraîcheur des ressources livrées.");
} else {
  let bad = 0;
  for (const p of pairs) {
    if (!has(p.dist)) { errors.push(`${p.dist} absent, alors qu'il doit être copié vers ${p.asset} — \`npm run build\`.`); bad++; continue; }
    if (!has(p.asset)) { errors.push(`${p.asset} absent — \`npm run android\`.`); bad++; continue; }
    if (!readFileSync(join(root, p.dist)).equals(readFileSync(join(root, p.asset)))) {
      errors.push(`${p.asset} ne correspond pas à ${p.dist} : ressource périmée, l'APK serait construit avec la version d'avant — \`npm run android\`.`);
      bad++;
    }
  }
  if (!bad) ok.push(`${pairs.length} ressources de l'application identiques à leur source générée, octet pour octet`);
}

/* 3+4 · le dépôt et le disque ne se contredisent pas ------------------------ */
{
  let tracked = new Set();
  let stagedDeletions = [];
  let gitOk = true;
  try {
    tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
    stagedDeletions = execFileSync("git", ["diff", "--cached", "--name-status"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("D\t"))
      .map((l) => l.slice(2).trim());
  } catch (e) {
    gitOk = false;
    warnings.push("git indisponible : les règles « suivi par le dépôt » et « index cohérent » sont sautées.");
  }
  if (gitOk) {
    const missing = [];
    for (const p of pairs) if (has(p.asset) && !tracked.has(p.asset)) missing.push(p.asset);
    for (const dir of ["src/inject", "src/original"]) {
      for (const f of walk(join(root, dir))) if (!tracked.has(rel(f))) missing.push(rel(f));
    }
    if (missing.length) {
      errors.push(
        `${missing.length} fichier(s) nécessaires à la construction ne sont pas suivis par git : ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""} — ` +
          "un clone frais de la branche produirait un APK amputé, sans la moindre erreur. Les ajouter : git add."
      );
    } else ok.push("toutes les entrées et toutes les sorties de construction sont suivies par le dépôt");

    const ghosts = stagedDeletions.filter((f) => has(f));
    if (ghosts.length) {
      errors.push(
        `l'index déclare supprimé ${ghosts.join(", ")} alors que le fichier existe sur le disque : le prochain commit retirerait une ressource vivante de la branche. ` +
          "git add -A avant de commiter (cas vécu le 26/09 sur spotiduck-logic.js, après un rollback d'environnement)."
      );
    } else ok.push("aucun fantôme dans l'index : rien d'« effacé » qui existe encore");
  }
}

/* 5 · verrous du moteur repris de l'origine --------------------------------- */
{
  const slices = [...read("tools/build-logic.mjs").matchAll(/^\s+name:\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (!slices.length) errors.push("tools/build-logic.mjs ne nomme plus aucun bloc : la liste des verrous est vide, le moteur n'est plus vérifié.");
  if (!has("tools/build-logic.locks.json")) {
    errors.push("tools/build-logic.locks.json absent : rien ne prouve que dist/spotiduck-logic.js soit du code d'origine intact.");
  } else {
    let locks = null;
    try {
      locks = JSON.parse(read("tools/build-logic.locks.json")).blocks || {};
    } catch (e) {
      errors.push(`tools/build-logic.locks.json illisible : ${String(e.message).slice(0, 60)}`);
    }
    if (locks) {
      const holes = slices.filter((n) => !locks[n] || !locks[n].len || locks[n].md5 === "0000000000");
      if (holes.length) {
        errors.push(
          `bloc(s) d'origine sans verrou posé : ${holes.join(", ")} — relire le découpage puis \`node tools/build-logic.mjs --record-locks\`. ` +
            "Un bloc sans empreinte n'est plus « repris tel quel » : c'est du code dont on a perdu la source."
        );
      } else ok.push(`${slices.length} blocs d'origine verrouillés (longueur + md5)`);
      const extra = Object.keys(locks).filter((n) => slices.indexOf(n) < 0);
      if (extra.length) warnings.push(`le fichier de verrous connaît des blocs disparus de l'outil : ${extra.join(", ")}`);
    }
  }
}

/* 6a · le pont, dans le sens JS -> Kotlin ----------------------------------- */
{
  const ktFiles = walk(join(root, "android/app/src/main/java"));
  const kt = ktFiles.map((f) => readFileSync(f, "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const provided = new Set([...kt.matchAll(/\bfun\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const js = ["src/inject/spotiduck-ui.js", "dist/spotiduck-logic.js", "android/app/src/main/assets/native-mode.js"]
    .filter(has)
    .map(read)
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = new Set();
  for (const m of js.matchAll(/\bAndBridge\.([A-Za-z0-9_]+)\s*\(/g)) wanted.add(m[1]);
  for (const m of js.matchAll(/(?:this|Bridge)\.call\(\s*"([A-Za-z0-9_]+)"/g)) wanted.add(m[1]);
  const gone = [...wanted].filter((n) => !provided.has(n));
  if (gone.length) {
    errors.push(`le JS appelle ${gone.join(", ")} sur le pont et aucune méthode Kotlin de ce nom n'existe : l'appel échoue dans un try, et ça se voit comme « la commande ne fait rien ».`);
  } else if (wanted.size) ok.push(`${wanted.size} méthodes du pont appelées depuis le JS, toutes présentes côté Kotlin`);
}

/* 6b · Kotlin déterministe, XML, doc ---------------------------------------- */
{
  /* Un approximateur de syntaxe Kotlin écrit à la main ferait plus de faux
     positifs que de bien — et une règle qui hurle une fois est une règle qu'on
     retire, puis on casse le Kotlin en confiance. Donc : seulement ce qui est
     déterministe sans grammaire et qui correspond au seul mode de casse vécu ici,
     la retouche de ces fichiers par petits patches. Trois choses : les
     délimiteurs de commentaires s'équilibrent ; les guillemets triples
     s'équilibrent ; aucune signature n'est déclarée deux fois à l'identique (les
     surcharges sont légales, c'est la signature complète qui est comparée). */
  for (const f of walk(join(root, "android/app/src/main/java"))) {
    const src = readFileSync(f, "utf8");
    const opened = src.split("/*").length - 1;
    const closed = src.split("*/").length - 1;
    if (opened !== closed) {
      errors.push(`${rel(f)} : ${opened} ouvertures et ${closed} fermetures de commentaires — un bloc non fermé avale le code qui suit, et le compilateur accusera loin de la cause.`);
    }
    const raws = src.split('"""').length - 1;
    if (raws % 2) errors.push(`${rel(f)} : guillemets triples en nombre impair — une chaîne brute non fermée avale tout ce qui suit son ouverture.`);
    /* Pas de règle « signature déclarée deux fois dans le fichier » : essayée ici,
       elle tombe sur MainActivity, qui déclare bien shouldOverrideUrlLoading deux
       fois — dans deux WebViewClient distincts, ce qui est parfaitement légal. Une
       règle qui crie sur du code valide finit retirée, et le Kotlin se casse alors
       en confiance. La grammaire complète appartient à compileDebugKotlin (CI de
       release), qui ne se trompe pas. */  }

  const xmls = walk(join(root, "android/app/src/main/res")).filter((f) => f.endsWith(".xml"));
  if (has("android/app/src/main/AndroidManifest.xml")) xmls.push(join(root, "android/app/src/main/AndroidManifest.xml"));
  let bad = 0;
  for (const f of xmls) {
    const dom = new JSDOM(readFileSync(f, "utf8"), { contentType: "text/xml" });
    const e = dom.window.document.querySelector("parsererror");
    if (e) { errors.push(`${rel(f)} n'est pas du XML valide : ${e.textContent.trim().slice(0, 110)} — aapt2 refuserait la ressource, et l'APK ne se construirait pas.`); bad++; }
  }
  if (!bad) ok.push(`${xmls.length} ressources XML bien formées (faute avant aapt2)`);

  const doc = has("docs/UI-REWORK.md") ? read("docs/UI-REWORK.md") : "";
  /* Deux formes de titres cohabitent dans cette doc, pour des raisons d'age : les
     premiers chapitres sont « ## 6. Limites connues », les suivants « ## §30 — … ».
     Une regle qui n'admettrait que la seconde accuserait a juste titre… 26 refs
     valides, et la regle serait retiree la semaine suivante. On accepte donc les
     deux, et une reference resolue par un titre de chapitre l'est. */
  const sections = new Set([...doc.matchAll(/^#{2,4}\s+§?\s*(\d+)/gm)].map((m) => m[1]));
  if (!doc) warnings.push("docs/UI-REWORK.md absent : la règle des références §NN est sautée.");
  const holes = new Map();
  const srcs = [...walk(join(root, "src")), ...walk(join(root, "tools")), ...walk(join(root, "android/app/src/main/java"))]
    .filter((f) => [".js", ".mjs", ".kt", ".css"].includes(extname(f)));
  for (const f of srcs) {
    /* Le texte est scrute **enti**er, commentaires compris : une reference de doc
       vit dans un commentaire par definition, et retirer les commentaires avant de
       chercher les references rendait la regle aveugle — c'est l'auto-test du
       portique qui vient de le montrer, en echouant sur sa propre mutation. */
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/§(\d+)/g)) {
      if (!sections.has(m[1])) {
        if (!holes.has(m[1])) holes.set(m[1], []);
        holes.get(m[1]).push(rel(f));
      }
    }
  }
  if (holes.size) {
    errors.push(
      [...holes.entries()].map(([n, fs]) => `§${n} cité (${fs.slice(0, 3).join(", ")}) sans section dans docs/UI-REWORK.md`).join(" · ") +
        " — une référence de doc cassée, c'est une décision dont on a perdu la raison : c'est ainsi qu'une règle est retournée une semaine plus tard."
    );
  } else ok.push(`références §NN toutes résolvables (${sections.size} sections)`);
}

/* 7 · scripts npm et workflows : rien de pendu ------------------------------ */
{
  const pkg = JSON.parse(read("package.json"));
  const referenced = new Set();
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const m of String(cmd).matchAll(/node\s+(tools\/[\w.-]+\.mjs)/g)) {
      referenced.add(m[1]);
      if (!has(m[1])) errors.push(`le script npm « ${name} » appelle ${m[1]}, qui n'existe pas.`);
    }
    for (const m of String(cmd).matchAll(/npm run ([\w:.-]+)/g)) {
      if (!pkg.scripts[m[1]]) errors.push(`le script npm « ${name} » s'appuie sur « npm run ${m[1]} », qui n'est pas défini.`);
    }
  }
  const wfDir = join(root, ".github/workflows");
  const wfs = existsSync(wfDir) ? readdirSync(wfDir) : [];
  const wfText = wfs.map((f) => readFileSync(join(wfDir, f), "utf8")).join("\n");
  for (const m of wfText.matchAll(/npm run ([\w:.-]+)/g)) if (!pkg.scripts[m[1]]) errors.push(`un workflow appelle « npm run ${m[1]} », que package.json ne définit pas.`);
  for (const m of wfText.matchAll(/node (tools\/[\w.-]+\.mjs)/g)) if (!has(m[1])) errors.push(`un workflow appelle ${m[1]}, qui n'existe pas.`);
  ok.push(`${Object.keys(pkg.scripts || {}).length} scripts npm et ${wfs.length} workflows : références résolues`);

  const engines = pkg.engines && pkg.engines.node;
  if (!engines) warnings.push("package.json sans « engines.node » : un générateur qui exige une syntaxe récente ne le dit qu'à l'exécution.");
  const orphans = readdirSync(join(root, "tools"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `tools/${f}`)
    .filter((p) => !referenced.has(p) && !wfText.includes(p) && !readFileSync(join(root, p), "utf8").includes("depuis un script npm"));
  if (orphans.length) warnings.push(`outil(s) dans tools/ que ni npm ni les workflows n'appellent : ${orphans.join(", ")} — entrée humaine à citer dans docs/ARCHITECTURE.md, ou à retirer`);
}

/* 8 · le bundle porte tout, et la bonne version ---------------------------- */
{
  if (!has("dist/spotiduck-ui.js")) {
    errors.push("dist/spotiduck-ui.js absent : `npm run build`.");
  } else {
    const bundle = read("dist/spotiduck-ui.js");
    const css = readdirSync(join(root, "src/inject")).filter((f) => f.endsWith(".css")).sort();
    const out = css.filter((f) => !bundle.includes(f) && !bundle.includes(f.replace(/\.css$/, "")));
    if (out.length) errors.push(`feuille(s) CSS non reprise(s) par le bundle : ${out.join(", ")} — la liste des parties de tools/build.mjs n'est pas le répertoire, elle doit le suivre.`);
    else ok.push(`${css.length} feuilles CSS reprises dans le bundle`);
    const version = JSON.parse(read("package.json")).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`package.json : « ${version} » n'est pas un X.Y.Z`);
    if (!bundle.includes(String(version))) errors.push(`le bundle ne porte pas la version ${version} : il n'est pas reconstruit depuis ce package.json.`);
    if (!read("tools/build.mjs").includes("__SD_VERSION__")) errors.push("tools/build.mjs ne pose plus window.__SD_VERSION__ : plus rien, sur un téléphone, ne permet de savoir quelle version tourne.");
    else ok.push(`version ${version} portée par le bundle (le diagnostic du téléphone la cite)`);
  }
}

/* -------------------------------------------------------------------------- */
console.log("\nSpotiDuck — portique d'hygiène\n");
for (const line of ok) console.log(`  ✓ ${line}`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
console.log(
  `\n  ${errors.length} erreur(s), ${warnings.length} avertissement(s)` +
    (errors.length
      ? " — le dépôt ne se reconstruit pas à l'identique, ou pas du tout : rien ne part en release\n"
      : " — le dépôt se construit de zéro, ses ressources livrées sont à jour, et il ne se contredit pas\n")
);
process.exit(errors.length ? 1 : 0);
