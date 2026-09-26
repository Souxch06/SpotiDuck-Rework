/**
 * Contrôle des garde-fous : chaque correction de la 2.11.18 et de la 2.11.19 est
 * annulée une par une, et l'audit doit la signaler. Les nombres cités dans
 * `docs/UI-REWORK.md` viennent d'ici (`node tools/regress-audit.mjs`), pas d'une
 * estimation : un garde-fou qui ne tombe pas quand on réintroduit le défaut
 * n'est pas un garde-fou.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const files = {
  ui: "src/inject/spotiduck-ui.js",
  dev: "src/inject/76-device.css",
  shim: "android/app/src/main/assets/native-mode.js",
  widget: "android/app/src/main/res/layout/widget_player.xml",
  shell: "src/inject/20-shell.css",
};
const originals = {};
for (const k of Object.keys(files)) originals[k] = readFileSync(join(root, files[k]), "utf8");

const CASES = [
  ["ui", "out.duration = this.ticksToMs(dur);", "out.duration = dur * 1000;", "unité mesurée"],
  ["ui", "out.position = this.ticksToMs(pos);", "out.position = pos;", "unité mesurée"],
  ["ui", "var p = Spotify.ticksToMs(input.value);", "var p = Number(input.value) * 1000;", "relit la position sans la conversion"],
  ["ui", "State.anchorPos = Spotify.ticksToMs(input.value);", "State.anchorPos = Number(input.value) / 1000;", "ancre posée par le glisser"],
  ["ui", "document.addEventListener(\"input\", Mirror.onCursor, true);", "input.addEventListener(\"input\", function (e) { State.anchorPos = e.target.value; });", "par copie"],
  ["ui", "maxTicks: function () {", "maxTicksInutilise: function () {", "borne de repli"],
  ["ui", "var max = this.maxTicks();", "var max = parseFloat(input.getAttribute(\"max\"));", "borne de repli"],
  ["ui", "var total = s.duration > 0 ? s.duration : trackDurationMs();", "var total = s.duration;", "trackDurationMs"],
  ["ui", "return this.seek(clamp(Number(ratio) || 0, 0, 1) * trackDurationMs());", "return this.seek(clamp(Number(ratio) || 0, 0, 1) * (State.duration || 0));", "trackDurationMs"],
  ["ui", "Settings.labels.reloadPlayerAction, ICONS.refreshLine", "Settings.labels.reloadIntrouvable, ICONS.refreshLine", "n'existe pas dans la liste"],
  ["ui", "    app: \"SpotiDuck\",", "    app: \"SpotiDuck\",\n    reload: \"Recharger\",", "même nom"],
  ["ui", "    \"homeBoard\",\n    \"libraryBoard\",\n  ];", "  ];", "n'est pas sauvegardé"],
  ["ui", "    density: \"normal\",\n  };", "    density: \"normal\",\n    nouveauReglage: true,\n  };", "valeur par défaut", "var DEFAULTS = {"],
  ["dev", "--sd-mini-h: calc(168px * var(--sd-u));", "--sd-mini-h: calc(96px * var(--sd-u));", "trop petite"],
  ["ui", "    if (UI.built) UI.askMeasure();", "    /* mesure retirée */", "redemande la mesure", "function applyDensity"],
  ["ui", "    watchSize: function () {", "    watchSizeInutilise: function () {", "changement de taille d'écran"],
  ["shim", "return n > 10000 ? 1000 : 1;", "return n > 99999 ? 1000 : 1;", "seuil d'unité"],
  ["shim", "function bestCoverUrl(img) {", "function bestCover(img) {", "plus grande pochette"],
  ["shim", "function playerRoot() {", "function playerRootAbsente() {", "ses libellés au lecteur"],
  ["shim", "var input = progressInput();", "var input = progressInput() || q(\"input[type='range']\");", "le premier curseur de la page"],
  ["widget", "            android:gravity=\"center_vertical\"\n            android:orientation=\"horizontal\">", "            android:orientation=\"horizontal\">", "alignée au centre"],
  ["widget", "android:id=\"@+id/widget_next\"", "android:id=\"@+id/widget_next2\"", "widget_next"],
  ["shim", '"add-button", "now-playing-widget-like-button"', '"button-like-invent"', "comme commande du lecteur"],
  /* Les secours de lecture de la 2.11.19 (« les boutons ne font rien »). */
  ["ui", "mediaEl: function () {", "mediaElInutilise: function () {", "n'a plus de mediaEl"],
  ["ui", "var sess = this.session();", "var sess = null;", "ne consulte plus ce que la page joue"],
  ["ui", "if (!input) return this.mediaSeek(ms);", "if (!input) return false;", "refuse de chercher"],
  ["ui", "return this.mediaToggle(go === null ? !this.readPlaying() : go);", "return false;", "plus de secours sur l'\u00e9l\u00e9ment"],
  ["ui", "          if (btn.disabled) btn.disabled = false;", "          btn.disabled = !s.hasTrack;", "verrouill"],
  ["ui", "var dom = Spotify.readPlaying();", "var dom = State.playing;", "état optimiste"],
  ["shell", "html.sd-mobile .sd-iconbtn.is-unavailable {\n  opacity: 0.4;\n  pointer-events: auto;\n}", "html.sd-mobile .sd-iconbtn.is-unavailable {\n  opacity: 0.4;\n}", "pressable"],
  ["shim", "function mediaEl() {", "function mediaElAbsente() {", "n'a plus function mediaEl"],
  ["shim", "if (!btn || btn.disabled === true) return false;", "if (!btn) return false;", "comme une réussite"],
  ["shim", "var sess = session();", "var sess = {};", "ne lit plus la session m\u00e9dia"],
];

const restore = () => {
  for (const k of Object.keys(files)) writeFileSync(join(root, files[k]), originals[k]);
};
process.on("exit", restore);

let caught = 0;
let missed = [];
for (const [file, from, to, expect, after] of CASES) {
  let text = originals[file];
  if (after) {
    const cut = text.indexOf(after);
    if (cut < 0) {
      missed.push(`${expect} :: ancre introuvable (${after})`);
      console.log(`? ${expect} — ancre introuvable`);
      continue;
    }
    const head = text.slice(0, cut);
    if (!text.slice(cut).includes(from)) {
      missed.push(`${expect} :: motif introuvable après l'ancre`);
      console.log(`? ${expect} — motif introuvable après l'ancre`);
      continue;
    }
    text = head + text.slice(cut).replace(from, to);
  } else if (!text.includes(from)) {
    missed.push(`${expect} :: motif introuvable (${from.slice(0, 40)})`);
    console.log(`? ${expect} — motif introuvable`);
    continue;
  }
  writeFileSync(join(root, files[file]), text.replace(from, to));
  let out = "";
  try {
    out = execSync("node tools/audit-links.mjs", { encoding: "utf8" });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  restore();
  const flagged = out.includes("✗") && out.includes(expect);
  if (flagged) caught++;
  else missed.push(`${expect} :: non signalé`);
  console.log(`${flagged ? "✓" : "✗"} ${expect}`);
}
console.log(`\n${caught}/${CASES.length} régressions détectées`);
if (missed.length) console.log("manquées :\n  " + missed.join("\n  "));
process.exit(missed.length ? 1 : 0);
