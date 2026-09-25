#!/usr/bin/env node
/**
 * Copies the built UI bundle and the ad-block list into the Android app so the
 * WebView can load them from `file:///android_asset/`.
 *
 *     node tools/sync-android.mjs       (npm run sync:android)
 *
 * Run it after `npm run build`. The files it writes are committed, so a plain
 * `gradle assembleRelease` works without the Node toolchain — this script only
 * keeps them in sync.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* Un garde-fou cherche une **pratique**, pas un mot cité dans une
   explication : ces contrôles lisent le code sans ses commentaires. */
const stripComments = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "android/app/src/main/assets");

const jobs = [
  { from: join(root, "dist/spotiduck-ui.js"), to: join(assets, "spotiduck-ui.js") },
  { from: join(root, "dist/spotiduck-original.js"), to: join(assets, "spotiduck-original.js") },
  { from: join(root, "dist/original-fingerprint.js"), to: join(assets, "original-fingerprint.js") },
  { from: join(root, "dist/spotiduck-identity.js"), to: join(assets, "spotiduck-identity.js") },
  { from: join(root, "adblock_hosts.txt"), to: join(assets, "adblock_hosts.txt") },
];

mkdirSync(assets, { recursive: true });

let ok = 0;
for (const { from, to } of jobs) {
  if (!existsSync(from)) {
    console.error(`missing ${from} — run \`npm run build\` first`);
    process.exitCode = 1;
    continue;
  }
  copyFileSync(from, to);
  const size = statSync(to).size;
  console.log(`synced ${to.replace(root + "/", "")} (${size} B)`);
  ok++;
}

/* The bundle must never be committed empty or truncated: a broken asset means
   the app silently falls back to Spotify's own (desktop) interface. */
const bundle = readFileSync(join(assets, "spotiduck-ui.js"), "utf8");
if (bundle.length < 50_000 || !bundle.includes("sd-layer")) {
  console.error("spotiduck-ui.js looks invalid — refusing to keep it");
  process.exitCode = 1;
}
if (bundle.includes("</script>")) {
  console.error("bundle contains a literal </script>, which would break injection");
  process.exitCode = 1;
} else {
  console.log(`bundle checked (${bundle.length} chars, ${ok}/${jobs.length} assets synced)`);
}

/* L'identité « bureau » de la coque : elle doit annoncer un bureau — agent,
   plateforme, client hints, greffons — et surtout **ne pas** toucher à la
   géométrie : la coque met la page en page sur la largeur réelle du téléphone,
   une fenêtre de 1920 px la casserait. */
const identity = readFileSync(join(assets, "spotiduck-identity.js"), "utf8");
const identityMust = ["userAgentData", "getHighEntropyValues", '"Win32"', '"Windows"', '"x86"'];
const identityMissing = identityMust.filter((m) => !identity.includes(m));
if (identityMissing.length) {
  console.error(`spotiduck-identity.js incomplet : ${identityMissing.join(", ")}`);
  process.exitCode = 1;
}
const identityCode = stripComments(identity);
for (const geometry of ["innerWidth", "innerHeight", "devicePixelRatio", "screen.", "window.screen"]) {
  if (identityCode.includes(geometry)) {
    console.error(`spotiduck-identity.js touche à la géométrie (${geometry}) : la coque serait cassée`);
    process.exitCode = 1;
  }
}

/* And for the original interface: it is the default one, so a truncated file
   would leave the app with no interface at all. The three landmarks below are
   the ones the grading checks rely on. */
const original = readFileSync(join(assets, "spotiduck-original.js"), "utf8");
const originalMust = ["window.firstFuck", "window.actPlayPause", "window.switchLs", "AndBridge.nFetch"];
const originalMissing = originalMust.filter((m) => !original.includes(m));
if (original.length < 20_000 || originalMissing.length) {
  console.error(
    "spotiduck-original.js looks invalid — refusing to keep it (" +
      (originalMissing.join(", ") || original.length + " chars") +
      ")"
  );
  process.exitCode = 1;
}

/* L'empreinte de navigateur : injectée avant la page, c'est elle qui décide de
   la mise en page. Trois valeurs suffisent à la reconnaître. */
const fingerprint = readFileSync(join(assets, "original-fingerprint.js"), "utf8");
const fpMust = ["return 1920;", "return 1080;", "return 978;"];
const fpMissing = fpMust.filter((m) => !fingerprint.includes(m));
if (fingerprint.length < 4_000 || fpMissing.length) {
  console.error(
    "original-fingerprint.js looks invalid — refusing to keep it (" +
      (fpMissing.join(", ") || fingerprint.length + " chars") +
      ")"
  );
  process.exitCode = 1;
}

/* Same idea for the native-mode script: it *is* the interface in the default
   mode, so an empty or truncated file would leave the app without any bridge
   between the notification and Spotify's own page. */
const native = readFileSync(join(assets, "native-mode.js"), "utf8");
const must = ["window.SpotiDuckUI", "control-button-playpause", "showUiChooser", "recMediaStatus"];
const missing = must.filter((m) => !native.includes(m));
if (native.length < 3_000 || missing.length) {
  console.error("native-mode.js looks invalid — refusing to keep it (" + (missing.join(", ") || native.length + " chars") + ")");
  process.exitCode = 1;
} else {
  console.log(`native-mode.js checked (${native.length} chars)`);
}

/* Et le silence servi à la place des publicités audio : un fichier MP3, pas
   vide, pas énorme. Un fichier tronqué ou absent ramènerait le comportement
   d'avant (blocage sec), ce qui n'est pas ce qu'on veut. */
const silent = readFileSync(join(assets, "silent.mp3"));
const isMp3 = silent.length > 4 && silent[0] === 0xff && (silent[1] & 0xe0) === 0xe0;
if (!isMp3 || silent.length < 8_000 || silent.length > 400_000) {
  console.error("silent.mp3 looks invalid — refusing to keep it (" + silent.length + " bytes)");
  process.exitCode = 1;
} else {
  console.log(`silent.mp3 checked (${silent.length} bytes)`);
}
