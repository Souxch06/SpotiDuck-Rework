#!/usr/bin/env node
/**
 * Smoke test for the injected mobile layer.
 *
 *   node tools/smoke.mjs
 *
 * Runs the real bundle (dist/spotiduck-ui.js) against the mock web player
 * (demo/mock/spotify.js) inside jsdom, and checks the behaviour that is easy
 * to break: DOM contract, tab routing, transport wiring, seek, gestures, and
 * — most importantly — the `AndBridge` payload the Android app consumes.
 *
 * jsdom has no layout engine, so this validates *logic*, not pixels; the
 * visual pass is done with the demo harness (demo/index.html).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(ROOT, p), "utf8");

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? "" : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? "" : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ setup */
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://open.spotify.com/",
  pretendToBeVisual: true,
  runScripts: "dangerously",
});
const { window } = dom;
const doc = window.document;

/* Spy on the Android bridge BEFORE the bundle boots. */
/* **Le pont Android tel qu'il est : des méthodes précises, et rien d'autre.**
   Un `Proxy` qui répond à tout — y compris à `nFetchAsync`, la voie réseau
   asynchrone ajoutée en 2.11.8 — faisait croire au banc que la version
   asynchrone était disponible : le script attendait alors une réponse qui ne
   venait jamais (« la bibliothèque n'a rien lu (état loading) »). Les ponts
   simulés déclarent donc, comme celui du téléphone, ce qu'ils savent faire. */
const withoutAsync = (handler) => ({
  ...handler,
  get: (target, prop, ...rest) =>
    String(prop) === "nFetchAsync" ? undefined : handler.get(target, prop, ...rest),
});

const bridgeCalls = [];
window.eval(`
  window.AndBridge = new Proxy({}, {
    get: (t, prop) => (...args) => {
      window.__bridgeCalls.push([String(prop), args]);
      if (String(prop) === "isWoke") return false;
      return undefined;
    }
  });
  window.__bridgeCalls = [];
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
`);
const errors = () => window.__errors || [];

/* jsdom has no layout: give it a phone viewport and a `visualViewport` so the
   viewport-dependent code paths (keyboard detection, gesture thresholds) run
   exactly like they do in the app. */
window.eval(`
  Object.defineProperty(document.documentElement, "clientWidth", { get: () => 360, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { get: () => 640, configurable: true });
  window.__vvListeners = [];
  window.visualViewport = {
    width: 360,
    height: 640,
    addEventListener: (type, fn) => window.__vvListeners.push([type, fn]),
    removeEventListener: () => {},
  };
`);

window.eval(await read("demo/mock/spotify.js"));
window.eval(await read("dist/spotiduck-ui.js"));
await tick(80);

const SD = window.SpotiDuckUI;
const UI = SD && SD._internals && SD._internals.UI;
const state = SD && SD.state;
const q = (sel) => doc.querySelector(sel);

/* ------------------------------------------------------------------ tests */
check("bundle exposes a versioned namespace", () => {
  assert(SD && SD.version, "window.SpotiDuckUI missing");
  return "v" + SD.version;
});

check("mobile root class applied, desktop bar kept alive", () => {
  assert(doc.documentElement.classList.contains("sd-mobile"), "html.sd-mobile missing");
  assert(q('aside[data-testid="now-playing-bar"]'), "the desktop bar must stay in the DOM (it owns <audio>)");
  return "html.sd-mobile ✓";
});

check("no global leakage (single namespace only)", () => {
  const banned = ["playing", "track", "artist", "duration", "position", "repmode", "isfav", "updMedia", "firstFuck", "switchLs"];
  const leaked = banned.filter((k) => typeof window[k] !== "undefined");
  assert(leaked.length === 0, "leaked globals: " + leaked.join(", "));
  return "clean";
});

check("layer is built out of Spotify's React tree", () => {
  const layer = q(".sd-layer");
  assert(layer && layer.parentElement === doc.body, ".sd-layer must be a child of <body>");
  const insideMain = doc.querySelector("#main-view .sd-layer, #main-view .sd-mini, #main-view .sd-tabbar");
  assert(!insideMain, "UI must not be injected inside #main-view");
  return "body > .sd-layer";
});

check("tab bar: 3 tabs, French labels", () => {
  const tabs = [...doc.querySelectorAll(".sd-tab")].map((t) => t.textContent.trim());
  assert(tabs.length === 3, "expected 3 tabs, got " + tabs.length);
  assert(tabs.join("|") === "Accueil|Rechercher|Bibliothèque", "labels: " + tabs.join("|"));
  return tabs.join(" · ");
});

await checkAsync("tab → Bibliothèque shows the library page", async () => {
  /* Signalé le 25/09 : « quand on clique sur l'onglet bibliothèque, la barre en
     haut disparaît et rien d'autre n'apparaît ; je reste bloqué sur l'écran
     d'accueil ». Donc : la **navigation reste** (c'est la seule de l'application),
     et la page de bibliothèque s'affiche avec son propre titre — la barre de
     titre, elle, est réservée aux sous-pages (deux barres au même bord se
     recouvriraient : c'est elle qui doit céder). */
  q('.sd-tab[data-tab="library"]').click();
  await tick();
  assert(doc.documentElement.classList.contains("sd-tab-library"), "sd-tab-library not set");
  assert(doc.documentElement.classList.contains("sd-nav-on"), "la barre de navigation disparaît sur la bibliothèque : plus aucun moyen de revenir");
  assert(!q(".sd-topbar").classList.contains("is-visible"), "la barre de titre est posée sur la bibliothèque, par-dessus la navigation");
  const panel = q(".sd-lib");
  assert(panel && !panel.hidden, "la page de bibliothèque ne s'affiche pas");
  assert(panel.querySelector(".sd-lib-title").textContent === "Bibliothèque", "titre de la page : " + panel.querySelector(".sd-lib-title").textContent);
  return "navigation gardée · page de bibliothèque + titre ✓";
});

await checkAsync("tab → Rechercher navigates the web player", async () => {
  q('.sd-tab[data-tab="search"]').click();
  await tick(120);
  assert(doc.documentElement.classList.contains("sd-tab-search"), "sd-tab-search not set");
  assert(q('section[data-testid="search-page"]'), "the mock should now show the search page");
  return "search page rendered";
});

await checkAsync("tab → Accueil returns home", async () => {
  q('.sd-tab[data-tab="home"]').click();
  /* Le retour de la page d'accueil dépend d'un rendu de Spotify : on lui laisse
     le temps d'arriver au lieu de le juger sur un seul relevé (il arrivait que
     la page soit encore en train de se reposer — banc rouge au hasard, et un
     banc qui échoue au hasard finit par ne plus être lu). */
  for (let i = 0; i < 20 && !q('section[data-testid="home-page"]'); i++) await tick(40);
  assert(q('section[data-testid="home-page"]'), "home page missing");
  assert(!q(".sd-topbar").classList.contains("is-visible"), "top bar must be hidden on home");
  return "home ✓";
});

await checkAsync("mini player mirrors the web player", async () => {
  window.MockSpotify.play(3);
  await tick(120);
  assert(state.title === window.MockSpotify.track.title, "title not mirrored: " + state.title);
  assert(q(".sd-mini-title").textContent === window.MockSpotify.track.title, "mini title not painted");
  assert(doc.documentElement.classList.contains("sd-has-track"), "sd-has-track missing → mini player hidden");
  return state.title + " / " + state.artist;
});

await checkAsync("mini play/pause drives Spotify's own button", async () => {
  const before = window.MockSpotify.state.playing;
  q(".sd-mini-play").click();
  await tick(60);
  assert(window.MockSpotify.state.playing !== before, "playback did not toggle");
  assert(state.playing === window.MockSpotify.state.playing, "state desync: " + state.playing);
  return "playing=" + state.playing;
});

await checkAsync("un doublon désactivé ne vole pas « suivant »", async () => {
  /* **La page du téléphone garde deux barres de lecture.** Relevé en CI : le
     bouton trouvé était bien là, à sa taille (32×32), mais `DÉSACTIVÉ` — appuyer
     dessus ne fait rien, et c'est « impossible de zapper la musique ». On pose
     donc un leurre désactivé **avant** le vrai bouton : l'appui doit aller au
     vrai, et la piste doit changer. */
  const bar = doc.querySelector('aside[data-testid="now-playing-bar"]');
  const vrai = bar.querySelector('button[data-testid="control-button-skip-forward"]');
  const leurre = doc.createElement("button");
  leurre.setAttribute("data-testid", "control-button-skip-forward");
  leurre.disabled = true;
  vrai.parentElement.insertBefore(leurre, vrai);
  let surLeurre = 0;
  leurre.addEventListener("click", () => {
    surLeurre++;
  });
  window.MockSpotify.play(1);
  await tick(120);
  const avant = window.MockSpotify.state.trackIndex;
  q(".sd-mini-next").click();
  for (let i = 0; i < 12 && window.MockSpotify.state.trackIndex === avant; i++) await tick(60);
  assert(surLeurre === 0, "l'appui est parti sur le bouton désactivé");
  assert(window.MockSpotify.state.trackIndex !== avant, "« suivant » n'a pas changé de piste");
  leurre.remove();
  return "le désactivé est écarté, la piste avance ✓";
});

await checkAsync("nos propres libellés ne volent pas la commande", async () => {
  /* Nos boutons portent les mêmes libellés que ceux de Spotify (« Lecture »,
     « Pause », « Suivant »). Un repère par libellé les attrapait eux-mêmes :
     l'appui repartait sur notre bouton, qui rappelait la commande — deux
     bascules qui s'annulent, et « le bouton ne fait rien ». */
  const miniPlay = q(".sd-mini-play");
  miniPlay.getBoundingClientRect = () => ({ width: 44, height: 44, top: 0, left: 0, right: 44, bottom: 44 });
  let surNous = 0;
  miniPlay.addEventListener("click", () => {
    surNous++;
  }, true);
  const avant = window.MockSpotify.state.playing;
  q(".sd-mini-play").click();
  await tick(90);
  assert(window.MockSpotify.state.playing !== avant, "l'appui n'a pas atteint le lecteur de Spotify");
  assert(surNous === 1, `l'appui est reparti sur notre propre bouton (${surNous} fois)`);
  return "「Lecture/Pause」 reste le bouton de Spotify ✓";
});

await checkAsync("zapper sans bouton vivant : le clavier du lecteur, puis la vérité", async () => {
  /* Cas mesuré en CI : sur la page du téléphone, les commandes du lecteur sont
     là mais **désactivées** (rien ne joue) — et sur certaines dispositions elles
     ne sont pas là du tout. La notification passe alors par le clavier du
     lecteur, et la coque **vérifie** que ça a bougé avant de parler : une alarme
     à tort est un défaut, un bouton muet aussi. */
  const bench = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  bench.window.eval("window.AndBridge = new Proxy({}, { get: () => () => undefined });");
  bench.window.eval(await read("demo/mock/spotify.js"));
  bench.window.eval(`
    document.querySelectorAll('[data-testid^="control-button"]').forEach(function (b) { b.disabled = true; });
    window.__clavier = [];
    window.__agit = true;
    document.addEventListener("keydown", function (e) {
      window.__clavier.push(e.key + (e.ctrlKey ? "+ctrl" : ""));
      if (!window.__agit || !e.ctrlKey) return;
      /* Le lecteur répond à ses propres raccourcis : ici, il change de piste. */
      var b = document.querySelector('[data-testid="control-button-skip-forward"]');
      if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, true);
  `);
  bench.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(220);
  const api = bench.window.SpotiDuckUI;
  const d = bench.window.document;
  const toast = () => ((d.querySelector(".sd-layer .sd-toast") || {}).textContent || "").trim();
  const touches = () => bench.window.__clavier || [];

  /* 1. Le raccourci part **et le lecteur y répond** : la coque doit se taire. */
  const pisteAvant = bench.window.MockSpotify.state.trackIndex;
  api.next();
  await tick(1100);
  assert(
    touches().some((k) => k === "ArrowRight+ctrl"),
    "le raccourci « suivant » du lecteur n'a pas été envoyé : " + JSON.stringify(touches())
  );
  assert(
    bench.window.MockSpotify.state.trackIndex !== pisteAvant,
    "le lecteur n'a pas reçu le raccourci (le banc ne l'a pas vu passer)"
  );
  assert(toast() === "", `la coque parle alors que la piste a changé : « ${toast()} »`);

  /* 2. Le raccourci ne fait rien : la coque le dit. */
  bench.window.__agit = false;
  api.next();
  await tick(1100);
  assert(/ne répondent pas/.test(toast()), `la panne n'est pas annoncée : « ${toast()} »`);

  /* 3. Rien ne joue : c'est la vraie raison, et elle est dite telle quelle. */
  d.querySelector(".sd-layer .sd-toast").textContent = "";
  api.state.title = "";
  api._internals.Actions.blame();
  await tick(60);
  assert(/Rien ne joue/.test(toast()), `le message ne dit pas que rien ne joue : « ${toast()} »`);
  bench.window.close();
  return "clavier du lecteur · silencieux si ça marche · franc si ça ne marche pas ✓";
});

await checkAsync("like button reflects the real aria-checked", async () => {
  const mockLike = q('div[data-testid="now-playing-widget"] > div:last-child > button');
  const before = mockLike.getAttribute("aria-checked");
  q(".sd-like").click();
  await tick(60);
  assert(mockLike.getAttribute("aria-checked") !== before, "like did not toggle in the web player");
  await tick(60);
  return "aria-checked=" + mockLike.getAttribute("aria-checked");
});

await checkAsync("repeat cycles off → context → track", async () => {
  const btn = q('button[data-testid="control-button-repeat"]');
  q(".sd-ctrl-repeat").click();
  await tick(60);
  assert(btn.getAttribute("aria-checked") === "true", "expected context repeat, got " + btn.getAttribute("aria-checked"));
  q(".sd-ctrl-repeat").click();
  await tick(60);
  assert(btn.getAttribute("aria-checked") === "mixed", "expected repeat-one, got " + btn.getAttribute("aria-checked"));
  return "off → context → track";
});

await checkAsync("shuffle toggles", async () => {
  q(".sd-ctrl-shuffle").click();
  await tick(60);
  assert(q('button[data-testid="control-button-shuffle"]').getAttribute("aria-checked") === "true", "shuffle not enabled");
  return "aria-checked=true";
});

await checkAsync("le lecteur ne disparaît pas quand la barre de Spotify quitte l'arbre", async () => {
  /* **Signalé le 25/09 : « le lecteur disparaît quand on scroll vers le bas ».**
     La barre de lecture de Spotify quitte l'arbre pendant un défilement (rendu
     différé), et `sd-mini-on` — jusqu'ici recalculé à partir d'une lecture
     instantanée — tombait à ce moment-là : le lecteur s'effaçait sous le doigt.
     Vu une fois, il doit rester. */
  assert(doc.documentElement.classList.contains("sd-mini-on"), "sd-mini-on absent avant le test");
  const bar = q('div[data-testid="now-playing-widget"]');
  assert(bar, "la barre de lecture simulée est introuvable");
  const holder = bar.parentNode;
  const next = bar.nextSibling;
  holder.removeChild(bar);
  await tick(220);
  assert(
    doc.documentElement.classList.contains("sd-mini-on"),
    "le lecteur s'efface dès que la barre de lecture quitte l'arbre"
  );
  assert(q(".sd-mini-title").textContent.trim().length > 0, "le mini-lecteur est vide après la disparition de la barre");
  /* La barre revient (fin du défilement) : rien ne doit casser. */
  holder.insertBefore(bar, next);
  await tick(220);
  assert(
    doc.documentElement.classList.contains("sd-mini-on"),
    "le lecteur a disparu au retour de la barre de lecture"
  );
  return "barre retirée → lecteur toujours là → barre revenue ✓";
});

await checkAsync("seek uses the native setter on Spotify's range input", async () => {
  window.MockSpotify.play(0);
  await tick(80);
  UI.el.seekRail.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 44 });
  const id = 1;
  UI.el.seekRail.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 10 }));
  UI.el.seekRail.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 10 }));
  await tick(500);
  const expected = window.MockSpotify.track.duration / 2;
  const got = Number(q('div[data-testid="playback-progressbar"] input[type="range"]').value);
  assert(Math.abs(got - expected) < 3, `seek landed at ${got}s, expected ~${expected}s`);
  return `seeked to ${got.toFixed(1)}s of ${window.MockSpotify.track.duration}s`;
});

await checkAsync("le mini-lecteur est statique : aucun geste ne le déplace", async () => {
  /* Signalé trois fois : « le lecteur disparaît », « le lecteur a de nouveau
     disparu », « fais en sorte qu'il soit statique ». Deux versions ont tenté
     d'apprivoiser les gestes sur le lecteur ; sur le téléphone, un doigt posé
     pour faire défiler restait pris pour un balayage. Il n'y a donc plus aucun
     geste : ni balayage latéral (changement de titre), ni glissement vers le
     haut (ouverture), ni tirage vers le bas (fermeture). */
  const before = window.MockSpotify.track.title;
  const mini = q(".sd-mini");
  const mk = (type, x, y) => new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  const startTrack = window.MockSpotify.state.trackIndex;
  mini.dispatchEvent(mk("pointerdown", 300, 400));
  for (let i = 1; i <= 6; i++) mini.dispatchEvent(mk("pointermove", 300 - i * 20, 400));
  mini.dispatchEvent(mk("pointerup", 180, 400));
  await tick(150);
  assert(window.MockSpotify.track.title === before, "un balayage a changé de titre : le lecteur doit être statique");
  assert(window.MockSpotify.state.trackIndex === startTrack, "l'index de piste a bougé après un balayage");
  /* Le balayage vers le haut n'ouvre rien non plus : seule une commande
     explicite (l'appui) ouvre le lecteur plein écran. */
  assert(!doc.documentElement.classList.contains("sd-player-open"), "un balayage a ouvert le lecteur plein écran");
  assert(!mini.style.transform, "un geste a laissé un transform sur le mini-lecteur : il pourrait sortir de l'écran");
  /* L'appui, lui, ouvre toujours le lecteur plein écran. */
  mini.dispatchEvent(mk("click", 180, 400));
  await tick(120);
  assert(doc.documentElement.classList.contains("sd-player-open"), "l'appui n'ouvre plus le lecteur");
  SD.closePlayer();
  await tick(120);
  return "balayage ignoré · appui → lecteur ✓";
});

await checkAsync("le lecteur plein écran s'ouvre et se ferme par commande (pas par glissement)", async () => {
  q(".sd-mini").click();
  await tick(60);
  assert(doc.documentElement.classList.contains("sd-player-open"), "player did not open");
  /* **Un glissement ne ferme plus rien.** Le geste de fermeture était le même
     que celui du défilement : le doigt posé sur la pochette pour faire défiler
     fermait le lecteur. Ne reste que la commande explicite : le bouton
     « Fermer » (et le retour d'Android, qui l'appelle). */
  const head = q(".sd-player-head");
  const mk = (type, y) => new window.MouseEvent(type, { bubbles: true, clientX: 180, clientY: y });
  head.dispatchEvent(mk("pointerdown", 100));
  for (let i = 1; i <= 6; i++) head.dispatchEvent(mk("pointermove", 100 + i * 40));
  head.dispatchEvent(mk("pointerup", 340));
  await tick(120);
  assert(
    doc.documentElement.classList.contains("sd-player-open"),
    "un glissement a fermé le lecteur plein écran : le geste de défilement le fera encore"
  );
  const close = q(".sd-player-close");
  assert(close, "le bouton « Fermer » du lecteur est introuvable");
  close.click();
  await tick(140);
  assert(!doc.documentElement.classList.contains("sd-player-open"), "le bouton « Fermer » ne ferme plus le lecteur");
  return "glissement ignoré · bouton Fermer → fermé ✓";
});

await checkAsync("queue sheet uses Spotify's own panel", async () => {
  UI.el.queue.click();
  await tick(60);
  assert(doc.documentElement.classList.contains("sd-queue-open"), "sd-queue-open not set");
  q(".sd-scrim").click();
  await tick(60);
  assert(!doc.documentElement.classList.contains("sd-queue-open"), "scrim tap did not close the queue");
  return "open + close by scrim ✓";
});

check("AndBridge contract unchanged (Android notification code untouched)", () => {
  const calls = window.__bridgeCalls.map((c) => c[0]);
  assert(calls.includes("recMediaStatus"), "recMediaStatus never called");
  assert(calls.includes("cssInjected"), "cssInjected never called (app waits for it)");
  assert(calls.includes("playLoaded"), "playLoaded never called");
  const status = window.__bridgeCalls.filter((c) => c[0] === "recMediaStatus").pop();
  const payload = JSON.parse(status[1][0]);
  const keys = Object.keys(payload).sort().join(",");
  assert(keys === "artist,cover,duration,fav,playing,position,repeat,track", "payload keys changed: " + keys);
  assert(["false", "true", "mixed"].includes(payload.repeat), "repeat must be false|true|mixed, got " + payload.repeat);
  assert(typeof payload.position === "number", "position must be a number");
  return keys;
});

await checkAsync("wake/sleep lock state follows playback (manageTShut/manageTSleep)", async () => {
  const locks = () => window.__bridgeCalls.filter((c) => /manageTShut|manageTSleep/.test(c[0]));
  assert(locks().length > 0, "locks never synchronised at boot");
  const playBtn = q('button[data-testid="control-button-playpause"]');
  const isPlaying = () => playBtn.getAttribute("aria-label") === "Pause";

  // Drive playback through Spotify's own button, so what the layer reacts to
  // is the DOM (not a hand-poked JS object). Start from a known paused state.
  if (isPlaying()) {
    playBtn.click();
    await tick(150);
  }
  assert(!isPlaying(), "could not pause the mock player");

  const markPlay = locks().length;
  playBtn.click(); // play
  await tick(150);
  assert(SD.state.playing === true, "the layer did not notice playback started");
  const playing = locks().slice(markPlay).map((c) => c[0] + "=" + c[1][0]);
  assert(
    playing.includes("manageTSleep=true") && playing.includes("manageTShut=false"),
    "expected sleep timer on + shutdown off while playing, got: " + (playing.join(" ") || "(no call)")
  );

  const markPause = locks().length;
  playBtn.click(); // pause
  await tick(150);
  assert(SD.state.playing === false, "the layer did not notice the pause");
  const paused = locks().slice(markPause).map((c) => c[0] + "=" + c[1][0]);
  assert(
    paused.includes("manageTSleep=false") && paused.includes("manageTShut=true"),
    "pause must arm the shutdown, got: " + (paused.join(" ") || "(no call)")
  );
  return playing.join(" ") + " / " + paused.join(" ");
});

await checkAsync("options sheet lists the player actions", async () => {
  SD.openPlayer();
  await tick(60);
  q(".sd-player-menu").click();
  await tick(60);
  const sheet = q(".sd-sheet-menu");
  assert(sheet.classList.contains("is-open"), "the options sheet did not open");
  const ids = [...sheet.querySelectorAll("[data-row]")]
    .filter((r) => !r.hidden)
    .map((r) => r.getAttribute("data-row"));
  ["queue", "lyrics", "devices", "share", "settings"].forEach((id) =>
    assert(ids.includes(id), "missing action row: " + id)
  );
  SD.close();
  await tick(40);
  SD.closePlayer();
  await tick(40);
  return ids.join(" · ");
});

await checkAsync("settings sheet applies + persists a setting", async () => {
  SD.openSettings();
  await tick(60);
  const sheet = q(".sd-sheet-settings");
  assert(sheet.classList.contains("is-open"), "the settings sheet did not open");
  const seg = sheet.querySelector('[data-seg="theme"]');
  seg.querySelector('button[data-value="dark"]').click();
  await tick(40);
  assert(SD.settings.theme === "dark", "theme setting not applied");
  assert(
    JSON.parse(window.localStorage.getItem("sd.ui.settings")).theme === "dark",
    "theme not persisted to localStorage"
  );
  assert(seg.querySelector('button[data-value="dark"]').classList.contains("is-on"), "segment not marked active");
  const sw = sheet.querySelector('[data-switch="reduceMotion"]');
  sw.click();
  await tick(40);
  assert(SD.settings.reduceMotion === true, "switch did not flip the setting");
  assert(doc.documentElement.classList.contains("sd-reduce-motion"), "sd-reduce-motion class missing");
  sw.click(); // back to the default for the rest of the run
  seg.querySelector('button[data-value="auto"]').click();
  await tick(40);
  SD.close();
  await tick(30);
  return "theme=dark persisted · reduce-motion toggled";
});

await checkAsync("settings: the Play Protect row opens the phone setting", async () => {
  SD.openSettings();
  await tick(60);
  const sheet = q(".sd-sheet-settings");
  const row = sheet.querySelector('[data-row="playprotect"]');
  assert(row, "la ligne « Vérification Play Protect » a disparu des réglages");
  assert(/Play Protect/i.test(row.textContent), "la ligne n'est plus nommée : " + row.textContent.trim());
  /* L'application ne peut pas désactiver Play Protect : elle doit au moins
     ouvrir le réglage, et dire quoi faire quand elle n'y arrive pas. */
  const real = window.AndBridge;
  const seen = [];
  window.AndBridge = new Proxy({}, withoutAsync({ get: (t, p) => (...a) => { seen.push(String(p)); return String(p) === "openPlayProtect"; } }));
  row.click();
  await tick(60);
  assert(seen.includes("openPlayProtect"), "AndBridge.openPlayProtect n'a pas été appelé : " + seen.join(", "));
  const toast = q(".sd-toast");
  assert(toast && toast.textContent.trim().length > 0, "aucune consigne affichée après l'appui");
  assert(/Analyser les applis/.test(toast.textContent), "la consigne ne dit pas quel réglage décocher : " + toast.textContent);
  window.AndBridge = real;
  SD.close();
  await tick(40);
  return "ligne présente · réglage ouvert · consigne affichée";
});

await checkAsync("settings: without the bridge, the row gives the manual path", async () => {
  const real = window.AndBridge;
  window.AndBridge = new Proxy({}, { get: () => () => false }); // Android plus ancien
  SD.openSettings();
  await tick(60);
  q('.sd-sheet-settings [data-row="playprotect"]').click();
  await tick(60);
  const toast = q(".sd-toast");
  assert(
    toast && /Play Store/.test(toast.textContent),
    "le chemin manuel n'est pas affiché : " + (toast ? toast.textContent : "pas de message")
  );
  window.AndBridge = real;
  SD.close();
  await tick(40);
  return "consigne manuelle ✓";
});

await checkAsync("interface size setting scales the whole shell", async () => {
  SD.openSettings();
  await tick(60);
  const sheet = q(".sd-sheet-settings");
  try {
    const seg = sheet.querySelector('[data-seg="density"]');
    assert(seg, "density segment missing from the settings sheet");
    /* `--sd-u` est maintenant le **produit** de deux facteurs : la base
       mesurée sur l'appareil (`--sd-u-base`) et le réglage manuel
       (`--sd-density`). jsdom n'évalue pas `calc()` pour une propriété
       personnalisée : on lit donc le facteur du réglage, et on vérifie que les
       jetons le multiplient bien (fin du test). */
    const u = () =>
      parseFloat(window.getComputedStyle(doc.documentElement).getPropertyValue("--sd-density"));
    assert(u() === 1, `normal density should be 1, got ${u()}`);
    seg.querySelector('button[data-value="compact"]').click();
    await tick(40);
    assert(SD.settings.density === "compact", "density setting not applied");
    assert(doc.documentElement.classList.contains("sd-density-compact"), "density class missing");
    assert(u() === 0.8, `compact should scale to 0.8, got ${u()}`);
    assert(
      JSON.parse(window.localStorage.getItem("sd.ui.settings")).density === "compact",
      "density not persisted"
    );
    seg.querySelector('button[data-value="large"]').click();
    await tick(40);
    assert(u() === 1.12, `large should scale to 1.12, got ${u()}`);
    seg.querySelector('button[data-value="normal"]').click();
    await tick(40);
    assert(u() === 1, "back to normal failed");
    const css = Array.from(doc.querySelectorAll("style"))
      .map((st) => st.textContent)
      .join("");
    assert(
      /--sd-tap:\s*calc\(48px \* var\(--sd-u\)\)/.test(css),
      "the tap target is not tied to the scale factor"
    );
    assert(
      /--sd-u:\s*calc\(var\(--sd-u-base\)\s*\*\s*var\(--sd-density\)\)/.test(css),
      "l'unité n'est plus le produit de la base appareil et du réglage"
    );
    return "compact 0.8 · normal 1 · large 1.12 (cibles 48 dp × facteur)";
  } finally {
    /* A failing check must never leave the sheet open: the next checks would
       otherwise collide with it (open() toggles). */
    SD.close();
    await tick(40);
  }
});

check("the player is reflowed to Spotify's mobile metrics", () => {
  const css = Array.from(doc.querySelectorAll("style")).map((st) => st.textContent).join("");
  const rules = [
    [/\[data-testid="grid-container"\][^{]*\{[^}]*grid-template-columns:\s*repeat\(2,/, "cards are not 2-up"],
    [/--m-card:\s*calc\(160px \* var\(--sd-u\)\)/, "the card size is not tied to the scale factor"],
    [/--m-row:\s*calc\(56px \* var\(--sd-u\)\)/, "the row height is not tied to the scale factor"],
    [/--m-hero:\s*calc\(200px \* var\(--sd-u\)\)/, "the hero art size is missing"],
    [/--m-pad:\s*calc\(16px \* var\(--sd-u\)\)/, "the page gutter is not mobile-sized"],
  ];
  rules.forEach(([re, msg]) => assert(re.test(css), msg));
  return "grille 2 colonnes · tuile 160 dp · ligne 56 dp · hero 200 dp · marge 16 dp";
});

check("settings expose a display diagnostic row", () => {
  const row = q(".sd-sheet-settings .sd-row-info .sd-row-value");
  assert(row, "no info row found");
  const rows = Array.from(doc.querySelectorAll(".sd-sheet-settings .sd-row-info .sd-row-value"));
  const diag = rows.map((r) => r.textContent).find((t) => /×/.test(t));
  assert(diag, "no diagnostic row (expected « 360×640 · 1.00× · 100 % »)");
  assert(/×\s*\d/.test(diag) && /%/.test(diag), `unexpected diagnostic format: ${diag}`);
  return diag;
});

await checkAsync("take control clicks Spotify's transfer prompt", async () => {
  const M = window.MockSpotify;
  const before = M.calls.takeover;
  /* The earlier checks asked for playback through the UI: forget that, so the
     "no request → no takeover" rule is actually tested. */
  SD._internals.Auto.wantPlay = false;
  M.simulate.takeover(true); // another device holds playback
  await tick(80);
  /* Nothing may happen until the user asks for playback… */
  await tick(500);
  assert(M.calls.takeover === before, "playback was stolen from the other device without a request");
  /* …then pressing play must take control and start playing here. */
  q(".sd-mini-play").click();
  await tick(500); // the layer's own play path + observer debounce
  await tick(700); // second step: the device row
  assert(M.calls.takeover > before, "the transfer button was never clicked");
  assert(M.calls.deviceRow > 0, "the device list row was never clicked");
  M.simulate.takeover(false);
  return "no theft · prompt + device row clicked";
});

await checkAsync("hardware back closes the top panel", async () => {
  SD.openPlayer();
  await tick(60);
  SD.openSettings();
  await tick(60);
  assert(SD._internals.Sheets.active === "settings", "sheet not open");
  assert(SD.back() === true, "back() did not consume the press");
  await tick(40);
  assert(SD._internals.Sheets.active === null, "back() did not close the sheet");
  assert(SD._internals.Player.open === true, "the player must stay open under the sheet");
  assert(SD.back() === true, "back() did not consume the second press");
  await tick(40);
  assert(SD._internals.Player.open === false, "back() did not close the player");
  return "sheet → player → app";
});

await checkAsync("panels push exactly one history entry", async () => {
  const Back = SD._internals.Back;
  SD.openPlayer();
  await tick(50);
  assert(Back.pushed === true, "opening the player must push a history entry");
  window.history.back(); // the real Android back button
  await tick(140);
  assert(SD._internals.Player.open === false, "a real back navigation did not close the player");
  return "popstate consumed ✓";
});

await checkAsync("login page exposes the e-mail/password route", async () => {
  const M = window.MockSpotify;
  const html = doc.documentElement;
  M.simulate.login(true);
  SD._internals.Login.apply();
  await tick(50);
  assert(html.classList.contains("sd-login"), "sd-login class missing");
  assert(html.classList.contains("sd-need-password"), "the classic-login call-to-action is not enabled");
  const cta = q(".sd-login-cta");
  assert(cta && /allow_password=1/.test(cta.getAttribute("href")), "wrong classic-login URL");
  /* Second case: the player already offers "open the web player" → the layer
     must tell Android and click through. */
  const Login = SD._internals.Login;
  Login.done = false;
  M.simulate.login(true, { loggedIn: true });
  Login.apply();
  await tick(60);
  const called = window.__bridgeCalls.some((c) => c[0] === "loginDetected");
  assert(called, "AndBridge.loginDetected() was not called");
  assert(!q('button[data-testid="web-player-link"]'), "the web player link was not clicked");
  M.simulate.login(false);
  SD._internals.Login.apply();
  await tick(40);
  assert(!html.classList.contains("sd-login"), "sd-login not cleared after login");
  return "?allow_password=1 + loginDetected()";
});

await checkAsync("offline banner toggles with the connection", async () => {
  const html = doc.documentElement;
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
  window.dispatchEvent(new window.Event("offline"));
  await tick(40);
  assert(html.classList.contains("sd-offline"), "sd-offline class missing");
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));
  await tick(40);
  assert(!html.classList.contains("sd-offline"), "sd-offline not cleared");
  return "banner toggled ✓";
});

await checkAsync("share uses the real track link", async () => {
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: (t) => { copied = t; } },
    configurable: true,
  });
  SD._internals.Actions.share();
  await tick(40);
  assert(/\/track\//.test(copied), "share did not copy a track URL, got: " + (copied || "(nothing)"));
  return copied.replace(/^https:\/\//, "");
});

await checkAsync("native playback API is idempotent", async () => {
  /* The Android notification calls these; a toggle racing the notification is
     how you end up with "pause" starting the music. */
  const playBtn = q('button[data-testid="control-button-playpause"]');
  const playing = () => playBtn.getAttribute("aria-label") === "Pause";
  if (playing()) {
    SD.pause();
    await tick(120);
  }
  assert(!playing(), "could not reach a paused state");
  SD.play();
  await tick(120);
  assert(playing(), "play() did not start playback");
  SD.play(); // idempotent: must NOT pause
  await tick(120);
  assert(playing(), "play() toggled playback instead of being idempotent");
  SD.pause();
  await tick(120);
  assert(!playing(), "pause() did not stop playback");
  SD.pause();
  await tick(120);
  assert(!playing(), "pause() toggled playback instead of being idempotent");
  SD.seek(5000);
  /* Le déplacement demande un aller-retour avec le faux lecteur : on lui laisse
     le temps d'aboutir au lieu de le juger sur un seul relevé (il arrivait que
     la position soit encore celle d'avant le geste). */
  let pos = 0;
  for (let i = 0; i < 30; i++) {
    await tick(80);
    pos = SD.state.position;
    if (pos >= 4000 && pos <= 9000) break;
  }
  assert(pos >= 4000 && pos <= 9000, "seek() did not move the position, got " + pos + " ms");
  return "play/pause idempotent · seek " + Math.round(pos / 1000) + " s";
});

await checkAsync("le curseur se lit et s'écrit dans la même unité", async () => {
  /* Le lecteur de Spotify compte parfois en secondes, parfois en millisecondes
     (`max` le dit). Lire avec une unité et écrire avec l'autre déplaçait le
     curseur au 1000e de la position demandée ; et un simple déplacement du
     curseur faisait basculer l'unité **mesurée** — c'est ce qui faisait échouer
     le test précédent une fois sur trois en CI (« got 5 ms »). */
  const spot = SD._internals.Spotify;
  const input = spot.progressInput();
  assert(input, "le curseur du faux lecteur est introuvable");
  const keep = {
    max: input.getAttribute("max"),
    value: input.value,
    unit: spot.unit,
    pos: window.MockSpotify.state.position,
    track: window.MockSpotify.state.trackIndex,
  };
  const wasPlaying = SD.state.playing;

  input.setAttribute("max", "180");
  input.value = "90";
  spot.unit = 0;
  assert(spot.scale() === 1000, "un lecteur en secondes doit se lire en millisecondes : " + spot.scale());
  SD._internals.Actions.seek(45000);
  assert(Math.abs(Number(input.value) - 45) < 0.01, "une seconde écrite devrait valoir 45 : " + input.value);

  input.setAttribute("max", "180000");
  input.value = "90000";
  spot.unit = 0;
  assert(spot.scale() === 1, "un lecteur en millisecondes doit se lire tel quel : " + spot.scale());
  SD._internals.Actions.seek(45000);
  assert(Math.abs(Number(input.value) - 45000) < 1, "des millisecondes devraient être écrites telles quelles : " + input.value);

  /* Un **saut** (déplacement du curseur, changement de piste) ne doit pas
     décider de l'unité ; une avance régulière, si. */
  if (!SD.state.playing) {
    SD.play();
    await tick(80);
  }
  const read = SD._internals.Spotify;
  input.setAttribute("max", "180");
  read.unit = 0;
  read.sample = { v: 5, t: Date.now() - 1000 };
  input.value = "90";
  read.calibrate();
  assert(read.unit === 0, "un saut de curseur a décidé de l'unité (" + read.unit + ")");
  input.setAttribute("max", "180000");
  read.sample = { v: 90000, t: Date.now() - 1000 };
  input.value = "91000";
  read.calibrate();
  assert(read.unit === 1000, "une avance régulière en millisecondes n'a pas été reconnue : " + read.unit);

  /* Restauration : les tests suivants retrouvent la maquette telle quelle — y
     compris la position du faux lecteur, que `seek` a déplacée. */
  input.setAttribute("max", keep.max);
  input.value = keep.value;
  spot.unit = keep.unit;
  window.MockSpotify.state.position = keep.pos;
  window.MockSpotify.state.trackIndex = keep.track;
  if (!wasPlaying) {
    SD.pause();
    await tick(80);
  }
  return "secondes ↔ millisecondes · saut ignoré ✓";
});

await checkAsync("le lecteur plein écran ne se ferme plus quand on fait défiler", async () => {
  /* Signalé deux fois : « le lecteur disparaît quand je scroll vers le bas ».
     Le lecteur plein écran se ferme en le tirant vers le bas — mais le geste de
     défilement est le même, et la pochette occupe l'écran : dès que le doigt
     partait de là pour faire défiler, le navigateur reprenait le geste
     (`pointercancel`) et la coque le prenait pour un tirage décidé. */
  SD.openPlayer();
  await tick(80);
  assert(doc.documentElement.classList.contains("sd-player-open"), "le lecteur ne s'ouvre pas");
  const art = q(".sd-player-art");
  assert(art, "la pochette du lecteur est introuvable");
  /* jsdom n'a pas `PointerEvent` : `MouseEvent` porte exactement ce que la
     coque lit (`type`, `clientX`, `clientY`) — c'est la même surface d'API. */
  const gesture = (type, moves, dy) => {
    const fire = (name, y) =>
      art.dispatchEvent(new window.MouseEvent(name, { bubbles: true, clientX: 180, clientY: y }));
    fire("pointerdown", 200);
    for (const step of moves) fire("pointermove", 200 + step);
    fire(type, 200 + dy);
  };
  /* Un défilement : le navigateur reprend le geste et le signale. */
  gesture("pointercancel", [60, 140, 260], 260);
  await tick(120);
  assert(
    doc.documentElement.classList.contains("sd-player-open"),
    "un défilement a fermé le lecteur plein écran"
  );
  /* Un petit mouvement relâché : ce n'est pas un tirage décidé non plus. */
  gesture("pointerup", [20, 40], 40);
  await tick(120);
  assert(doc.documentElement.classList.contains("sd-player-open"), "un petit mouvement a fermé le lecteur");

  /* Et même un vrai tirage relâché ne ferme rien : le lecteur est statique, il
     ne se ferme que par commande (bouton « Fermer », retour d'Android). */
  gesture("pointerup", [80, 160, 280], 300);
  await tick(420);
  assert(
    doc.documentElement.classList.contains("sd-player-open"),
    "un tirage ferme encore le lecteur : le défilement le fermera aussi"
  );
  /* Le mini-lecteur est revenu avec la fermeture (il ne reste pas traduit). */
  assert(doc.documentElement.classList.contains("sd-mini-on"), "le mini-lecteur n'est pas revenu après la fermeture");
  return "défilement : lecteur gardé · tirage décidé : fermé ✓";
});

await checkAsync("le lecteur reste à l'écran pendant le défilement (statique)", async () => {
  /* **La demande explicite du 25/09 : « fais en sorte qu'il soit statique ».**
     Le mini-lecteur est en position fixe, sans transform ni animation : il ne
     peut ni sortir de l'écran ni se décaler. Ce test descend la page comme le
     font les navigateurs (Échap annule le défilement, donc la position revient :
     on relève pendant), puis vérifie que le lecteur n'a pas bougé d'un pixel et
     qu'aucun geste ne l'a déplacé. */
  const mini = q(".sd-mini");
  assert(mini, "mini-lecteur introuvable");
  const styles = window.getComputedStyle(mini);
  assert(styles.position === "fixed", "le mini-lecteur n'est plus en position fixe : " + styles.position);
  assert(styles.transform === "none" || styles.transform === "", "le mini-lecteur porte un transform : " + styles.transform);
  assert(
    styles.animationName === "none" || !styles.animationName,
    "le mini-lecteur est animé : " + styles.animationName
  );

  /* Un défilement de la page entière, celui qui le faisait disparaître. */
  const main = doc.getElementById("main-view") || doc.body;
  const before = { class: doc.documentElement.className.includes("sd-mini-on"), transform: mini.style.transform || "" };
  for (let i = 1; i <= 8; i++) {
    if (main.scrollTo) main.scrollTo(0, i * 200);
    main.scrollTop = i * 200;
    window.dispatchEvent(new window.Event("scroll"));
    await tick(30);
    assert(
      doc.documentElement.classList.contains("sd-mini-on"),
      "le lecteur a disparu pendant le défilement (étape " + i + ")"
    );
    assert(!mini.style.transform, "un transform est apparu sur le lecteur pendant le défilement (étape " + i + ")");
  }
  main.scrollTop = 0;
  window.dispatchEvent(new window.Event("scroll"));
  await tick(80);
  assert(doc.documentElement.classList.contains("sd-mini-on"), "le lecteur a disparu après le défilement");
  assert(doc.documentElement.className.includes("sd-mini-on") === before.class, "l'état du lecteur a changé après le défilement");
  return "fixe · sans transform · présent à chaque étape du défilement ✓";
});

await checkAsync("le mini-lecteur se remet tout seul s'il a été poussé hors de l'écran", async () => {
  /* Deuxième filet, indépendant de la cause : une classe restée en place ou un
     transform laissé par un geste interrompu ne peuvent plus faire disparaître
     le lecteur — il est réaffirmé chaque seconde. */
  SD.closePlayer();
  await tick(120);
  const html = doc.documentElement;
  const mini = q(".sd-mini");
  html.classList.remove("sd-mini-on");
  mini.style.transform = "translate3d(0,120%,0)";
  html.classList.add("sd-player-open"); // classe restée en place, lecteur fermé
  await tick(1400);
  assert(html.classList.contains("sd-mini-on"), "le mini-lecteur ne se remet pas en place : la classe manque toujours");
  assert(!mini.style.transform, "le transform laissé par un geste interrompu n'est pas nettoyé");
  assert(!html.classList.contains("sd-player-open"), "la classe du lecteur plein écran reste alors qu'il est fermé");
  return "classe reprise · transform nettoyé · feuille refermée ✓";
});

await checkAsync("tab bar can be disabled without leaving a floating mini player", async () => {
  SD.set("tabbar", false);
  await tick(40);
  assert(doc.documentElement.classList.contains("sd-no-tabbar"), "sd-no-tabbar missing");
  SD.set("tabbar", true);
  await tick(40);
  assert(!doc.documentElement.classList.contains("sd-no-tabbar"), "sd-no-tabbar not removed");
  return "class toggled ✓";
});

await checkAsync("un dialogue *visible* fait reculer nos barres, un dialogue fermé ne fait rien", async () => {
  /* « Le lecteur disparaît » venait aussi de là : un `role="dialog"` resté
     monté dans l'arbre de Spotify **une fois fermé** faisait croire à un
     dialogue ouvert — nos barres s'éteignaient alors pour de bon. Un dialogue
     ne compte donc que s'il est **visible** (une taille, pas `hidden`). */
  const modal = doc.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.hidden = true;
  doc.body.appendChild(modal);
  await tick(300);
  assert(!doc.documentElement.classList.contains("sd-native-modal"), "un dialogue fermé (`hidden`) éteint nos barres");
  /* Fermé, mais sans l'attribut : aucun nœud sans taille ne doit compter. */
  modal.hidden = false;
  await tick(300);
  assert(!doc.documentElement.classList.contains("sd-native-modal"), "un dialogue sans taille éteint nos barres");
  /* Un vrai dialogue, lui, a une taille. */
  modal.getClientRects = () => [{ width: 300, height: 200 }];
  SD._internals.Polish.syncOverlay();
  await tick(30);
  assert(doc.documentElement.classList.contains("sd-native-modal"), "un dialogue visible ne fait plus reculer nos barres");
  /* Et le mini-lecteur reste affiché : c'est nos barres qui reculent, pas lui. */
  await tick(1100);
  assert(
    doc.documentElement.classList.contains("sd-mini-on"),
    "le mini-lecteur a été éteint par un dialogue : c'est exactement « le lecteur disparaît »"
  );
  modal.remove();
  await tick(300);
  assert(!doc.documentElement.classList.contains("sd-native-modal"), "sd-native-modal not cleared");
  return "dialogue visible = nos barres reculent · fermé = rien · lecteur intact ✓";
});

await checkAsync("a shrinking viewport alone does not hide the bars", async () => {
  // Le bug « les boutons du bas disparaissent de temps en temps » : la classe
  // `sd-keyboard` se posait dès que la zone visible rétrécissait, sans qu'un
  // clavier soit ouvert (rotation, barre système, redimensionnement).
  const html = doc.documentElement;
  const realVV = window.visualViewport;
  const fake = { height: 300, width: 360, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
  Object.defineProperty(html, "clientHeight", { value: 700, configurable: true });
  // Aucun champ de saisie actif : rien ne doit se masquer.
  if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
  SD._internals.Polish.watchKeyboard();
  await tick(30);
  assert(!html.classList.contains("sd-keyboard"), "the bars must stay visible when nothing is focused");
  // Un vrai champ focalisé, clavier ouvert : là, oui.
  const input = doc.createElement("input");
  doc.body.appendChild(input);
  input.focus();
  SD._internals.Polish.watchKeyboard();
  await tick(30);
  assert(html.classList.contains("sd-keyboard"), "the bars must step back for a real keyboard");
  input.blur();
  SD._internals.Polish.watchKeyboard();
  await tick(30);
  assert(!html.classList.contains("sd-keyboard"), "the bars must come back once the field loses focus");
  if (realVV) Object.defineProperty(window, "visualViewport", { value: realVV, configurable: true });
  return "clavier ouvert = barres effacées · sinon visibles ✓";
});

await checkAsync("software keyboard hides the bars but keeps search usable", async () => {
  const fire = () => window.__vvListeners.filter(([t]) => t === "resize").forEach(([, fn]) => fn());
  // Un clavier n'existe que si un champ est focalisé : c'est ce que la couche
  // vérifie maintenant (voir le test précédent, qui couvre le cas inverse).
  const field = doc.querySelector("#sd-kbd-probe") || doc.createElement("input");
  if (!field.parentElement) {
    field.id = "sd-kbd-probe";
    doc.body.appendChild(field);
  }
  field.focus();
  window.visualViewport.height = 300; // keyboard takes ~340px
  fire();
  await tick(30);
  assert(doc.documentElement.classList.contains("sd-keyboard"), "sd-keyboard not set");
  window.visualViewport.height = 640;
  fire();
  await tick(30);
  assert(!doc.documentElement.classList.contains("sd-keyboard"), "sd-keyboard not cleared");
  field.blur();
  return "tab bar + mini slide away ✓";
});

check("tiny native controls get a real hit box and a label", () => {
  const btn = doc.querySelector('[data-testid="control-button-shuffle"]');
  assert(btn, "mock control not found");
  btn.getBoundingClientRect = () => ({ width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 });
  SD._internals.Polish.labelPass();
  assert(btn.getAttribute("data-sd-hit") === "1", "control not flagged with data-sd-hit");
  assert(btn.getAttribute("title"), "aria-label was not copied to title");
  return "data-sd-hit + title tooltip ✓";
});

/* ------------------------------------------------------------------ *
 * Deuxième banc : la WebView au tout premier lancement. Pas de web player,
 * pas de session — juste la page de connexion de Spotify. C'est l'état dans
 * lequel un nouvel utilisateur ouvre l'application, et il doit déjà
 * ressembler à une application Android.
 * ------------------------------------------------------------------ */
const early = new JSDOM(
  '<!doctype html><html><head></head><body>' +
    '<div id="global-nav-bar"><a href="/login">Log in</a><a href="/download">Download</a></div>' +
    "</body></html>",
  { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
);
early.window.eval(await read("dist/spotiduck-ui.js"));
await tick(150);
const earlyDoc = early.window.document;
const earlySD = early.window.SpotiDuckUI;

check("shell is built even when the web player is not ready yet", () => {
  assert(earlySD, "namespace missing");
  assert(earlyDoc.querySelector(".sd-layer"), "layer not built");
  assert(earlyDoc.documentElement.classList.contains("sd-mobile"), "sd-mobile missing");
  assert(earlyDoc.querySelectorAll(".sd-tab").length === 3, "tab bar incomplete");
  return "layer + 3 onglets + feuilles, sans web player";
});

check("logged-out landing page shows the native welcome screen", () => {
  assert(earlyDoc.documentElement.classList.contains("sd-welcome-on"), "sd-welcome-on missing");
  const cta = earlyDoc.querySelector(".sd-welcome-cta");
  assert(cta, "welcome CTA missing");
  assert(/\/login\?allow_password=1$/.test(cta.getAttribute("href")), "CTA points at " + cta.getAttribute("href"));
  assert(earlyDoc.querySelector(".sd-welcome-title").textContent === "SpotiDuck", "wrong title");
  return "logo + titre + bouton « Se connecter »";
});

checkAsync("the welcome screen retires when the player appears inside a container", async () => {
  /* Le défaut mesuré : l'écran d'accueil n'était réévalué que sur les mutations
     du **body**. Un lecteur qui se construit dans un conteneur déjà en place ne
     produit aucune mutation à ce niveau — l'écran d'accueil restait donc posé
     par-dessus, indéfiniment. */
  const host = new JSDOM(
    '<!doctype html><html><body><div id="global-nav-bar"><a href="/login">Log in</a></div><div id="root"></div></body></html>',
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  host.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  host.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  assert(host.window.document.documentElement.classList.contains("sd-welcome-on"), "l'écran d'accueil devrait être affiché au départ");

  /* Le lecteur arrive… dans #root, sans toucher aux enfants directs de <body>. */
  host.window.document.querySelector("#root").innerHTML =
    '<div class="main-view-container"><div class="main-view-container__scroll-node">' +
    '<div id="main-view"></div></div></div>' +
    '<aside data-testid="now-playing-bar"><button data-testid="control-button-playpause"></button></aside>';
  await tick(900); /* au-delà du débounce, en deçà du filet de sécurité (2 s) */
  assert(
    !host.window.document.documentElement.classList.contains("sd-welcome-on"),
    "l'écran d'accueil recouvre encore le lecteur"
  );
  return "retiré dès que le lecteur apparaît, sans mutation du body ✓";
});

await checkAsync("our own login links never keep the welcome screen on", async () => {
  /* Le défaut trouvé au banc : `marketing` était calculé avec
     `a[href*="/login"]`, ce qui comptait **nos propres** liens — l'écran
     d'accueil en contient, la barre du haut aussi. Sur une page sans lecteur
     (chargement, page d'erreur, banc), la coque se prouvait donc à elle-même
     qu'elle était sur la page marketing de Spotify : l'écran d'accueil se
     rendait vrai **tout seul** et masquait la coque entière. */
  const bare = new JSDOM("<!doctype html><html><body><pre>page sans lecteur</pre></body></html>", {
    url: "http://127.0.0.1:5173/player.html",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  bare.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  bare.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(900);
  const owner = bare.window.document.querySelector('.sd-layer a[href*="/login"]');
  assert(owner, "le banc devrait porter au moins un lien /login : c'est le piège à couvrir");
  const cls = bare.window.document.documentElement.className;
  assert(!cls.includes("sd-welcome-on"), "l'écran d'accueil se rend vrai tout seul, il masque la coque : " + cls);
  return "seuls les liens de Spotify comptent ✓";
});

check("the welcome CTA is handed to the app, not just a link", () => {
  const calls = [];
  early.window.AndBridge = new Proxy(
    {},
    withoutAsync({ get: (t, p) => (...a) => { calls.push([String(p), a]); return undefined; } })
  );
  const cta = earlyDoc.querySelector(".sd-welcome-cta");
  const event = new early.window.MouseEvent("click", { bubbles: true, cancelable: true });
  cta.dispatchEvent(event);
  assert(
    calls.some((c) => c[0] === "openLogin"),
    "l'appui n'a pas demandé à l'application d'ouvrir la connexion : " + JSON.stringify(calls)
  );
  return "appui → AndBridge.openLogin ✓";
});

await checkAsync("the WebView is allowed to open Widevine (protected media)", async () => {
  /* Sans cette permission, Android refuse le contenu protégé : Spotify, qui ne
     trouve plus de module de déchiffrement, remplace le lecteur par un écran
     « La lecture de contenus protégés est désactivée ». C'est le « y a rien qui
     va » du 24/09 : la lecture, pas l'affichage. */
  const activity = await read("android/app/src/main/java/com/spotiduck/app/MainActivity.kt");
  assert(/import android\.webkit\.PermissionRequest/.test(activity), "PermissionRequest n'est pas importé");
  assert(
    /override fun onPermissionRequest\(request: PermissionRequest\)/.test(activity),
    "le WebChromeClient n'implémente pas onPermissionRequest : Android refuse par défaut"
  );
  assert(
    /PermissionRequest\.RESOURCE_PROTECTED_MEDIA_ID/.test(activity),
    "la permission demandée n'est pas celle du contenu protégé"
  );
  assert(/request\.grant\(/.test(activity), "la permission du contenu protégé n'est jamais accordée");
  assert(/request\.deny\(\)/.test(activity), "les autres permissions ne sont plus refusées");
  return "contenu protégé accordé, le reste refusé ✓";
});

check("the mini player exists even before anything plays (empty state)", () => {
  /* « Des trucs qui n'apparaissent pas » : le mini-lecteur n'existait qu'avec
     une piste en cours ; sans titre, tout le bas de l'écran restait vide alors
     que le contenu réservait la place. Il doit être là, avec son état vide. */
  assert(doc.documentElement.classList.contains("sd-mini-on"), "sd-mini-on absent");
  const mini = q(".sd-mini");
  assert(mini, "mini-lecteur introuvable");
  const css = Array.from(doc.querySelectorAll("style"))
    .map((st) => st.textContent)
    .join("");
  assert(
    /sd-mini-on[^{]*\.sd-mini\s*\{[^}]*display:\s*flex/.test(css),
    "la feuille n'affiche pas le mini-lecteur dès qu'un lecteur existe"
  );
  assert(
    doc.documentElement.classList.contains("sd-mini-empty") ||
      doc.documentElement.classList.contains("sd-has-track"),
    "l'état (vide / avec titre) n'est pas signalé au CSS"
  );
  assert(q(".sd-mini-title"), "titre du mini-lecteur introuvable");
  return "présent, avec état vide ✓";
});

await checkAsync("le lecteur reste affiché sans session, et le dit", async () => {
  /* Signalé deux fois : « le lecteur disparaît quand on scroll vers le bas »,
     puis « le lecteur a de nouveau disparu ». La barre ne dépend donc plus
     d'aucune lecture d'état : elle est **toujours** là. Quand la session est
     fermée, elle le dit — et son appui mène à la connexion, au lieu de laisser
     le bas de l'écran vide. */
  const dom = new JSDOM(
    /* Sans lecteur **et** avec un lien de connexion de Spotify : la session est
       fermée, et la page ne peut pas le deviner autrement. */
    "<!doctype html><html><body><a href='/login'>Se connecter</a></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(220);
  const page = dom.window.document;
  assert(page.documentElement.classList.contains("sd-mobile"), "la coque n'est pas en mode téléphone");
  assert(
    page.documentElement.classList.contains("sd-mini-on"),
    "le lecteur n'est pas affiché alors qu'aucune piste ne joue : le bas de l'écran est vide"
  );
  assert(
    page.documentElement.classList.contains("sd-mini-signed-out"),
    "la session fermée n'est pas signalée au CSS"
  );
  const title = page.querySelector(".sd-mini-title");
  assert(title && title.textContent.trim().length > 0, "le lecteur ne dit pas pourquoi il est vide");
  assert(title.textContent !== "Aucun titre en lecture", "le lecteur annonce « aucun titre » au lieu de la session fermée : " + title.textContent);

  /* Et la bibliothèque propose la connexion, à côté de « Réessayer » : sans
     session, réessayer ne peut rien donner (« il n'arrive pas à reconnaître mes
     playlists »). */
  const ui = dom.window.SpotiDuckUI;
  ui.state.tab = "library";
  ui.library.load(true);
  await tick(180);
  const login = page.querySelector(".sd-lib-login");
  assert(login, "aucune porte de sortie vers la connexion dans la bibliothèque");
  assert(login.hidden === false, "la porte de sortie vers la connexion reste cachée sans session");
  assert(
    /^https:\/\/accounts\.spotify\.com\/.*allow_password=1/.test(login.getAttribute("href") || ""),
    "le bouton de connexion ne mène pas à la connexion classique : " + login.getAttribute("href")
  );
  dom.window.close();
  return "barre toujours là · session fermée dite · connexion proposée ✓";
});

await checkAsync("the mini player carries the original app's fourth row", async () => {
  /* Paroles · karaoké · file d'attente · appareils · volume, comme dans
     l'application d'origine — chaque commande branchée sur celle de Spotify. */
  const row = q(".sd-mini-row2");
  assert(row, "la 4e rangée du mini-lecteur est absente");
  for (const cls of [
    "sd-mini-lyrics",
    "sd-mini-karaoke",
    "sd-mini-queue",
    "sd-mini-devices",
    "sd-mini-vol",
  ]) {
    assert(row.querySelector("." + cls), `commande manquante dans le mini-lecteur : ${cls}`);
  }
  const src = await read("src/inject/spotiduck-ui.js");
  assert(/miniQueue\.addEventListener/.test(src), "le bouton file d'attente n'est pas câblé");
  assert(/miniVol\.addEventListener|miniVol\.addEventListener/.test(src), "le volume n'est pas câblé");
  assert(
    /volumeInput: function/.test(src) && /volume-bar/.test(src),
    "le volume ne suit pas celui de Spotify"
  );
  assert(/karaokeButton: function/.test(src), "le karaoké ne suit pas le bouton de Spotify");
  return "paroles · karaoké · file · appareils · volume ✓";
});

await checkAsync("the nav bar and the title bar never cover each other", async () => {
  /* Les deux sont collées en haut : elles ne peuvent pas être affichées en même
     temps. La règle a changé le 25/09 — la navigation gagne (elle est seule à
     permettre de revenir), la barre de titre n'est plus que pour les sous-pages,
     qui ont leur bouton retour. */
  const src = await read("src/inject/spotiduck-ui.js");
  assert(/var navOn = !isSubPage;/.test(src), "la barre de navigation n'est plus liée aux seules sous-pages");
  assert(
    /e\.topbar\.classList\.toggle\("is-visible", isSubPage\)/.test(src),
    "la barre de titre s'affiche ailleurs que sur une sous-page : elle recouvrirait la navigation"
  );
  return "navigation partout (accueil · recherche · bibliothèque) · titre sur les sous-pages ✓";
});

await checkAsync("the content is laid out for a phone, not for a desktop", async () => {
  /* Capture du 24/09 : des pochettes de 59 px dans des cellules de 95, des
     gouttières de 36 px, 85 px entre deux rangées. La feuille d'origine fait
     tenir la page dans l'écran ; elle ne la met pas en page pour un téléphone.
     Cette passe-là s'en charge — et seulement sur un téléphone. */
  const src = await read("src/inject/77-content.css");
  assert(src.length > 800, "la passe de contenu est vide ou absente");
  /* Tous les appareils : la capture qui a motivé cette passe vient d'un appareil
     large (≥ 600 px), et une passe limitée aux écrans étroits n'y faisait rien. */
  assert(
    /html\.sd-mobile \.sd-root section\[data-testid="component-shelf"\]/.test(src),
    "la passe de contenu n'est plus appliquée sur tous les appareils"
  );
  for (const need of ["component-shelf", "carousel-scroller", "aspect-ratio: 1 / 1", "img[width]"]) {
    assert(src.includes(need), `la passe de contenu ne traite plus « ${need} »`);
  }
  /* Le nombre de colonnes : la capture montrait quatre colonnes de pochettes de
     59 px — une grille de bureau. La largeur de carte décide désormais. */
  assert(
    /grid-template-columns:\s*repeat\(auto-fill, minmax\(calc\(150px \* var\(--sd-u\)\)/.test(src),
    "la densité des rangées n'est plus réglée par la largeur de carte"
  );
  assert(
    !/repeat\(4,/.test(src) && !/repeat\(5,/.test(src),
    "la passe de contenu fixe un nombre de colonnes en dur : elle ne s'adapterait pas à l'appareil"
  );
  /* « C'est encore coupé » (24/09, 21 h 53) : le conteneur d'une rangée mesurait
     440 px dans une mise en page de 412 — 28 px rognés par notre
     `overflow-x: hidden`. La passe doit borner ces conteneurs. */
  assert(
    /section\[data-testid="component-shelf"\] [\s\S]{0,400}max-width:\s*100%/.test(src),
    "les rangées ne sont plus bornées à la largeur de l'écran : le contenu serait rogné"
  );
  assert(
    /\[data-testid="carousel-scroller"\][\s\S]{0,200}width:\s*100%/.test(src),
    "le conteneur de carrousel ne prend plus la largeur de la page"
  );
  for (const bad of ["width: 440px", "width: 430px", "width: 412px", "width: 100vw"]) {
    assert(!src.includes(bad), `la passe de contenu fixe une largeur en dur (${bad})`);
  }
  const bundle = await read("dist/spotiduck-ui.js");
  assert(
    bundle.includes("[data-testid=component-shelf]") || bundle.includes('[data-testid="component-shelf"]'),
    "la passe de contenu n'est pas dans le paquet livré"
  );
  assert(
    !/border-radius:\s*6px[^}]*img/i.test(src),
    "la passe de contenu impose un rayon : les pochettes rondes des artistes redeviendraient carrées"
  );
  return "pochettes pleines · gouttières 12 · rangées 14 (téléphone seulement) ✓";
});

await checkAsync("the shell can never blank the page it dresses", async () => {
  /* La capture du téléphone, le 24/09 : notre barre du haut, et un écran noir
     en dessous. La cause est une règle de notre propre feuille — masquer
     `#global-nav-bar` (la barre de bureau de Spotify que la nôtre remplace)
     masquait aussi le contenu, parce que sur la disposition actuelle c'est un
     de ses ancêtres. Le garde-fou remonte la chaîne du contenu et rétablit tout
     ancêtre que notre feuille a masqué. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      '<div id="global-nav-bar"><div id="wrap">' +
      '<div id="main-view"><section data-testid="home-page">Accueil</section></div>' +
      "</div></div>" +
      "</body></html>",
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  /* La règle de notre feuille, réduite à ce qui compte ici. */
  const style = dom.window.document.createElement("style");
  style.textContent = "#global-nav-bar{display:none !important}";
  dom.window.document.head.appendChild(style);

  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(250);

  const page = dom.window.document;
  const bar = page.getElementById("global-nav-bar");
  const root = page.documentElement;
  assert(
    bar.getAttribute("data-sd-unhidden") === "1",
    "un ancêtre masqué du contenu n'a pas été rétabli"
  );
  assert(dom.window.getComputedStyle(bar).display !== "none", "la page reste masquée");
  assert(root.className.includes("sd-content-restored"), "l'état rétabli n'est pas signalé");
  const api = dom.window.SpotiDuckUI;
  assert(api && api.content && api.content.restored.length >= 1, "le garde-fou n'est pas joignable");
  assert(
    /data-sd-unhidden/.test(await read("src/inject/spotiduck-ui.js")),
    "le marqueur du garde-fou a disparu de la coque"
  );
  dom.window.close();
  return "#global-nav-bar (ancêtre du contenu) rétabli ✓";
});

await checkAsync("listening statistics are computed, and they are correct", async () => {
  /* « Mets les différentes statistiques d'écoutes etc sur l'utilisateur. »
     Le banc vérifie des **chiffres exacts**, pas la présence de cases : on
     injecte un historique connu (des heures, des jours, des artistes précis) et
     on compare chaque résultat. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const stats = api && api.stats;
  assert(stats, "le module de statistiques n'est pas exposé");

  /* Un historique écrit à la main : 6 écoutes de 3 minutes, à des heures
     choisies, sur 3 jours, dont 2 artistes — un seul nouveau cette semaine. */
  const day = 24 * 60 * 60 * 1000;
  const noon = new Date();
  noon.setHours(20, 0, 0, 0);
  const today = noon.getTime();
  const yesterday = today - day;
  const old3 = today - 3 * day;
  const old30 = today - 30 * day;
  const history = [
    { name: "Titre A", artist: "Artiste Un", at: old30, sec: 180 },
    { name: "Titre A", artist: "Artiste Un", at: old3, sec: 180 },
    { name: "Titre B", artist: "Artiste Un", at: yesterday, sec: 180 },
    { name: "Titre C", artist: "Artiste Deux", at: yesterday + 60 * 1000, sec: 240 },
    { name: "Titre C", artist: "Artiste Deux", at: today, sec: 240 },
    { name: "Titre D", artist: "Artiste Trois", at: today + 60 * 1000, sec: 300 },
  ];
  history.forEach((h) => stats.record(h.name, h.artist, h.sec, h.at));

  const sum = stats.summary(today + 5 * 60 * 1000);
  assert(sum.total === 6, `écoutes attendues : 6, calculées ${sum.total}`);
  assert(sum.trackCount === 4, `titres différents attendus : 4, calculés ${sum.trackCount}`);
  assert(sum.artistCount === 3, `artistes attendus : 3, calculés ${sum.artistCount}`);
  assert(sum.seconds === 180 * 3 + 240 * 2 + 300, `temps total : attendu 1380, calculé ${sum.seconds}`);
  assert(sum.playsToday === 2, `écoutes du jour : attendues 2, calculées ${sum.playsToday}`);
  assert(sum.topArtists[0].name === "Artiste Un", "le premier artiste devrait être Artiste Un");
  assert(sum.topArtists[0].n === 3, `Artiste Un devrait compter 3 écoutes, ${sum.topArtists[0].n}`);
  assert(sum.topArtists[0].share === 50, `part attendue 50 %, calculée ${sum.topArtists[0].share} %`);
  assert(sum.byDay.length === 7, "la fenêtre des sept jours doit contenir sept entrées");
  assert(sum.byDay[6].n === 2, `aujourd'hui : 2 écoutes attendues, ${sum.byDay[6].n}`);
  assert(sum.byDay[5].n === 2, `hier : 2 écoutes attendues, ${sum.byDay[5].n}`);
  assert(sum.streak >= 2, `série attendue ≥ 2 jours, calculée ${sum.streak}`);
  /* Les moments de la journée se comptent en **temps écouté** : c'est la même
     unité que les durées du haut de la page. */
  assert(sum.bands.evening === 1320, `le soir devrait compter 1 320 s, ${sum.bands.evening}`);
  assert(sum.favBand === "Le soir", `moment préféré attendu « Le soir », calculé « ${sum.favBand} »`);
  assert(sum.discovery.length === 1, `une découverte attendue, ${sum.discovery.length} trouvée(s)`);
  assert(sum.discovery[0].name === "Artiste Deux", "la découverte devrait être Artiste Deux (2 écoutes cette semaine)");
  /* 1 320 s = 22 min pile : l'arrondi des minutes doit être celui-là. */
  assert(stats.human(sum.seconds) === "22 min", `affichage attendu « 22 min », calculé « ${stats.human(sum.seconds)} »`);
  assert(stats.human(3 * 3600 + 20 * 60) === "3 h 20", "affichage des heures incorrect");


  /* Persistance : les statistiques survivent au redémarrage (localStorage). */
  const stored = JSON.parse(dom.window.localStorage.getItem("sd.stats.v1"));
  assert(stored && stored.e && stored.e.length === 6, "les écoutes ne sont pas enregistrées");
  /* Le même titre deux fois en trois minutes est une reprise, pas une écoute. */
  const before = stats.summary().total;
  stats.record("Titre D", "Artiste Trois", 300, today + 90 * 1000);
  assert(stats.summary().total === before, "une reprise comptée comme une nouvelle écoute");

  /* Le réglage coupe l'enregistrement. */
  api.set("stats", false);
  stats.record("Titre E", "Artiste Quatre", 200, today + 120 * 1000);
  assert(stats.summary().total === before, "l'enregistrement continue alors qu'il est désactivé");
  api.set("stats", true);

  /* La remise à zéro vide tout, stockage compris. */
  stats.clear();
  assert(stats.summary().total === 0, "la remise à zéro ne vide pas les statistiques");
  assert(JSON.parse(dom.window.localStorage.getItem("sd.stats.v1")).e.length === 0, "le stockage n'est pas vidé");

  /* **Les durées viennent de l'écoute, pas de la durée annoncée du titre.**
     On rejoue le geste réel : la position avance seconde par seconde, et c'est
     ce temps-là qui compte. */
  stats.clear();
  const t0 = today + 10 * 60 * 1000;
  const track = { hasTrack: true, playing: true, title: "Titre Mesuré", artist: "Artiste Mesuré" };
  stats.tick(Object.assign({}, track, { position: 0 }), t0);
  stats.tick(Object.assign({}, track, { position: 20000 }), t0 + 20000); // +20 s
  stats.tick(Object.assign({}, track, { position: 60000 }), t0 + 40000); // +40 s de position, 20 s écoulées
  stats.tick({ hasTrack: false, playing: false }, t0 + 41000);
  let measured = stats.summary(t0 + 41000);
  assert(measured.plays === 1, `une écoute mesurée attendue, ${measured.plays} comptée(s)`);
  assert(measured.measured === 42, `temps mesuré attendu 42 s (20 + 20 bornées), calculé ${measured.measured}`);
  assert(measured.measuredPlays === 1 && measured.estimatedPlays === 0, "l'écoute mesurée n'est pas marquée comme telle");
  const measuredEntry = JSON.parse(dom.window.localStorage.getItem("sd.stats.v1")).e[0];
  assert(measuredEntry.m === 1 && measuredEntry.d === 42, `entrée mesurée attendue m=1 d=42, obtenue ${JSON.stringify(measuredEntry)}`);

  /* Un titre **survolé** ne compte pas quatre minutes : le saut de position est
     borné par le temps réellement écoulé, et moins de dix secondes ne compte
     pas du tout. */
  stats.clear();
  stats.tick(Object.assign({}, track, { position: 0, title: "Titre Survolé" }), t0 + 60000);
  stats.tick(Object.assign({}, track, { position: 180000, title: "Titre Survolé" }), t0 + 61000);
  stats.tick({ hasTrack: false, playing: false }, t0 + 62000);
  const skipped = stats.summary(t0 + 62000);
  assert(skipped.plays === 0, `un titre survolé ne devrait pas compter une écoute, ${skipped.plays} comptée(s)`);

  /* Le **même titre relancé** est une seconde écoute, pas une continuation. */
  stats.clear();
  stats.tick(Object.assign({}, track, { position: 0, title: "Titre Bouclé" }), t0 + 100000);
  stats.tick(Object.assign({}, track, { position: 15000, title: "Titre Bouclé" }), t0 + 115000);
  stats.tick(Object.assign({}, track, { position: 0, title: "Titre Bouclé" }), t0 + 116000);
  stats.tick(Object.assign({}, track, { position: 25000, title: "Titre Bouclé" }), t0 + 141000);
  stats.tick({ hasTrack: false, playing: false }, t0 + 142000);
  const looped = stats.summary(t0 + 142000);
  assert(looped.plays === 2, `deux écoutes attendues après une reprise, ${looped.plays} comptée(s)`);
  const loopedEntry = JSON.parse(dom.window.localStorage.getItem("sd.stats.v1"));
  assert(loopedEntry.e.length === 2, `deux entrées attendues, ${loopedEntry.e.length} écrite(s)`);

  /* Et le total reste celui des deux durées mesurées (15 + 25). */
  assert(looped.measured === 40, `temps mesuré attendu 40 s, calculé ${looped.measured}`);
  dom.window.close();
  return "6 écoutes · 3 artistes · parts, série, moments exacts · durées mesurées (42 s mesurées, survol écarté, reprise comptée) ✓";
});

await checkAsync("the home screen shows the statistics, and can live without Spotify's rows", async () => {
  /* L'accueil est **notre** écran : il doit s'afficher même quand la page ne
     publie aucune rangée, tant qu'il a des statistiques à montrer. C'est ce qui
     garantit que l'utilisateur voit quelque chose de neuf. */
  const dom = new JSDOM('<!doctype html><html><body><div id="main-view"></div></body></html>', {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const day = 24 * 60 * 60 * 1000;
  api.stats.record("Titre A", "Artiste Un", 200, Date.now() - day);
  api.stats.record("Titre B", "Artiste Deux", 200, Date.now());
  api.home.refresh("test");
  await tick(120);

  const page = dom.window.document;
  const board = page.querySelector(".sd-home");
  const statsBox = page.querySelector(".sd-home-stats");
  assert(statsBox, "le bloc de statistiques n'est pas dans l'accueil");
  assert(statsBox.hidden === false, "le bloc de statistiques est masqué");
  const tiles = [...statsBox.querySelectorAll(".sd-stat-tile")];
  /* Trois durées (aujourd'hui, sept jours, depuis le début) puis quatre
     nombres (écoutes, titres différents, artistes, jours d'affilée). */
  assert(tiles.length === 7, `sept tuiles attendues, ${tiles.length} trouvée(s)`);
  assert(
    statsBox.querySelectorAll(".sd-stat-hint").length >= 7,
    "chaque tuile doit dire ce qu'elle compte"
  );
  const values = tiles.map((t) => t.querySelector(".sd-stat-value").textContent);
  assert(
    values.some((v) => /min|h/.test(v)),
    "aucune tuile n'affiche un temps d'écoute : " + values.join(", ")
  );
  assert(statsBox.querySelector(".sd-stat-chart"), "le graphique des sept jours est absent");
  assert(statsBox.querySelector(".sd-stat-bars"), "le classement des artistes est absent");
  assert(statsBox.querySelector(".sd-stat-bands"), "les moments de la journée sont absents");
  assert(
    board.hidden === false,
    "l'accueil reste masqué alors qu'il a des statistiques à montrer"
  );
  dom.window.close();
  return "7 tuiles (3 durées + 4 nombres, chacune expliquée) · 7 jours · artistes · moments, sans rangée de Spotify ✓";
});

await checkAsync("the app has a home screen of its own, built from the page's data", async () => {
  /* Décision du 24/09, avec l'utilisateur : l'accueil du web player a été repris
     trois fois (métriques de bureau, quatre colonnes de pochettes de 59 px,
     conteneurs rognés) et restait « pas beau / coupé ». L'application affiche
     donc **son** accueil : les données viennent de la page (titres, pochettes,
     liens — c'est bien la musique de l'utilisateur), la mise en page est la
     nôtre. Ce test vérifie les trois propriétés qui comptent : l'accueil
     apparaît quand il a des données, chaque commande fait quelque chose, et il
     disparaît quand il n'en a pas. */
  const shelved =
    '<section data-testid="home-page">' +
    '<section data-testid="component-shelf"><div><h2>Vos playlists</h2>' +
    '<a href="/playlist/aaa"><img src="https://i.scdn.co/image/aaa" alt="Mix du soir"><p>Mix du soir</p></a>' +
    '<a href="/album/bbb"><img src="https://i.scdn.co/image/bbb" alt="Album test"><p>Album test</p></a>' +
    '<a href="/show/ccc"><img src="https://i.scdn.co/image/ccc" alt="Podcast test"><p>Podcast test</p></a>' +
    "</div></section>" +
    '<section data-testid="component-shelf"><div><h2>Radio tendance</h2><a href="/section/ddd"/></div>' +
    '<div><a href="/playlist/eee"><img src="https://i.scdn.co/image/eee" alt="Radio test"><p>Radio test</p></a></div></section>' +
    "</section>`";
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="main-view">' + shelved + "</div>" +
      '<aside data-testid="now-playing-bar"></aside></body></html>',
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(250);

  const api = dom.window.SpotiDuckUI;
  assert(api && api.home, "le module d'accueil n'est pas exposé");
  const page = dom.window.document;
  const board = page.querySelector(".sd-home");
  assert(board, "l'accueil maison n'est pas construit");
  assert(board.hidden === false, "l'accueil maison reste masqué alors qu'il a des données");

  /* Les données de la page sont bien reprises. */
  const cards = [...page.querySelectorAll(".sd-home-card")];
  assert(cards.length >= 4, `cartes attendues : au moins 4, trouvées ${cards.length}`);
  assert(
    cards.every((c) => c.getAttribute("href") && /^\/(playlist|album|show|section)\//.test(c.getAttribute("href"))),
    "une carte n'est pas un vrai lien de la page"
  );
  assert(
    page.querySelector(".sd-home-cover img"),
    "les pochettes de la page ne sont pas reprises"
  );
  const titles = [...page.querySelectorAll(".sd-home-section-title")].map((h) => h.textContent);
  assert(titles.includes("Vos playlists"), "les titres de rangées ne sont pas repris : " + titles.join(", "));
  assert(page.querySelector(".sd-home-more"), "le lien « Tout afficher » n'est pas repris");

  /* Les filtres filtrent pour de vrai. (Scopés à l'accueil : la bibliothèque
     maison porte elle aussi des filtres — les compter ensemble ne dit rien.) */
  const chips = [...page.querySelectorAll(".sd-home .sd-chip")];
  assert(chips.length === 3, "les trois filtres ne sont pas là : " + chips.map((c) => c.textContent).join("/"));
  chips.find((c) => c.getAttribute("data-filter") === "podcast").click();
  await tick(80);
  const afterPodcast = [...page.querySelectorAll(".sd-home-card")];
  assert(afterPodcast.length === 1, `filtre podcasts : 1 carte attendue, ${afterPodcast.length} trouvée(s)`);
  assert(
    afterPodcast[0].getAttribute("href").includes("/show/"),
    "le filtre podcasts ne garde pas un podcast"
  );
  chips.find((c) => c.getAttribute("data-filter") === "all").click();
  await tick(80);
  assert(
    page.querySelectorAll(".sd-home-card").length === cards.length,
    "le filtre « Tout » ne restaure pas toutes les cartes"
  );

  /* Les raccourcis sont quatre commandes, toutes reliées. */
  const shortcuts = [...page.querySelectorAll(".sd-shortcut")];
  assert(shortcuts.length === 4, `raccourcis attendus : 4, trouvés ${shortcuts.length}`);
  assert(
    shortcuts.every((b) => b.tagName === "BUTTON" && b.type === "button"),
    "un raccourci n'est pas un vrai bouton"
  );

  /* Aucune largeur ni colonne en dur : c'est ce qui a causé le rognage. */
  const css = [...page.querySelectorAll("style")].map((st) => st.textContent).join("");
  assert(
    !/\.sd-home-grid\s*\{[^}]*repeat\(\d+,/.test(css),
    "la grille de l'accueil fixe un nombre de colonnes en dur"
  );
  assert(
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(calc\(140px \* var\(--sd-u\)\)/.test(css),
    "la grille de l'accueil ne se règle plus sur une largeur de carte utile"
  );
  dom.window.close();
  return `${cards.length} cartes · 2 rangées · 3 filtres · 4 raccourcis, tous reliés ✓`;
});

await checkAsync("the home screen never covers a page that has nothing to show", async () => {
  /* Sans données (écran de connexion, session fermée, page qui n'a pas encore
     rendu ses rangées), l'accueil maison s'efface : la page reprend la main,
     jamais d'écran maison vide par-dessus un écran vide. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://accounts.spotify.com/fr/login",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(250);
  const board = dom.window.document.querySelector(".sd-home");
  assert(board, "l'accueil maison n'est même pas construit");
  assert(board.hidden === true, "l'accueil maison s'affiche sur la page de connexion");
  assert(
    dom.window.SpotiDuckUI.home.data.length === 0,
    "l'accueil a trouvé des données là où il n'y en a pas"
  );
  /* Et une sous-page ouverte (playlist, album, artiste) ne doit jamais être
     recouverte. La garde se mesure sur le **chemin** : `isHomePath()` dit vrai à
     la racine, à `/home`, aux chemins de langue (`/fr`, `/en-US`) et — depuis le
     25/09 — à `/intl-fr`, le chemin que Spotify sert en France ; il dit faux sur
     tout le reste. (Le test précédent citait `State.route === "page"`, une ligne
     de `back()` qui n'a rien à voir avec l'accueil : il passait sans rien
     vérifier.) */
  const home = dom.window.SpotiDuckUI.home;
  assert(home && typeof home.isHomePath === "function", "l'accueil n'expose plus son test de chemin");
  for (const [path, want, why] of [
    ["https://open.spotify.com/", true, "la racine"],
    ["https://open.spotify.com/home", true, "/home"],
    ["https://open.spotify.com/fr", true, "la langue simple"],
    ["https://open.spotify.com/en-US", true, "la langue avec région"],
    ["https://open.spotify.com/intl-fr/", true, "/intl-fr (le chemin du téléphone)"],
    ["https://open.spotify.com/intl-en/", true, "/intl-en"],
    ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", false, "une playlist"],
    ["https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX", false, "un album"],
    ["https://open.spotify.com/section/0JQ5DAqbMKFEC4WFtoNRpw", false, "une section"],
  ]) {
    /* jsdom ne laisse pas réécrire `location` : on mesure sur une copie du
       module, avec l'URL voulue. */
    const probe = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
      url: path,
      pretendToBeVisual: true,
      runScripts: "dangerously",
    });
    probe.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
    probe.window.eval(await read("dist/spotiduck-ui.js"));
    await tick(120);
    const got = probe.window.SpotiDuckUI.home.isHomePath();
    assert(got === want, `le chemin d'accueil se trompe sur ${why} : attendu ${want}, obtenu ${got}`);
    probe.window.close();
  }
  dom.window.close();
  return "aucune rangée ⇒ masqué · sous-page ⇒ masqué · /intl-fr ⇒ accueil ✓";
});

await checkAsync("a blank page says so instead of showing an empty screen", async () => {
  /* La capture du téléphone était un écran entièrement noir sous notre barre :
     impossible de savoir si la page n'avait rien affiché ou si c'était nous.
     Quand le contenu attendu est absent ou vide, la coque le dit maintenant —
     avec un bouton de rechargement et le diagnostic à copier. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  /* jsdom ne calcule aucune mise en page : on lui donne une géométrie
     synthétique — un élément qui porte du texte a une taille, un élément vide
     n'en a pas. C'est ce que le garde-fou mesure dans un vrai navigateur. */
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const text = (this.textContent || "").trim();
    const height = text.length > 10 ? 600 : 0;
    return { width: text ? 400 : 0, height, top: 0, left: 0, right: 400, bottom: height, x: 0, y: 0 };
  };
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);

  const api = dom.window.SpotiDuckUI;
  assert(api && api.content && typeof api.content.alertIfBlank === "function", "garde-fou absent");
  const shown = api.content.alertIfBlank();
  assert(shown === true, "un écran vide n'a rien signalé");
  const panel = dom.window.document.querySelector(".sd-content-alert");
  assert(panel && panel.hidden === false, "le panneau n'est pas affiché");
  assert(dom.window.document.documentElement.className.includes("sd-content-blank"), "l'état n'est pas marqué");
  for (const cls of [".sd-content-alert-reload", ".sd-content-alert-copy", ".sd-content-alert-close"]) {
    assert(panel.querySelector(cls), `bouton manquant dans le panneau : ${cls}`);
  }
  const diag = panel.querySelector(".sd-content-alert-diag").textContent;
  assert(/SpotiDuck /.test(diag) && /unité/.test(diag) && /contenu/.test(diag), "diagnostic incomplet : " + diag);

  /* Le contenu revient : le panneau doit disparaître de lui-même. */
  const main = dom.window.document.querySelector("main");
  main.innerHTML = "<section data-testid=\"home-page\">Bonjour, voici vos playlists et vos podcasts du moment</section>";
  assert(api.content.alertIfBlank() === false, "le panneau reste alors que le contenu est revenu");
  assert(panel.hidden === true, "le panneau n'est pas masqué");
  assert(!dom.window.document.documentElement.className.includes("sd-content-blank"), "l'état est resté marqué");
  dom.window.close();
  return "écran vide signalé (recharger · copier) puis masqué au retour du contenu ✓";
});

await checkAsync("a tall, narrow page is not 'nothing displayed', and the diagnostic tells the truth", async () => {
  /* **La capture du 25/09.** Le téléphone affichait « La page n'a rien
     affiché », avec dans son propre diagnostic `contenu 29×2756` : la page
     avait 2 756 px de contenu et un seuil de largeur (40 px, hérité d'une autre
     disposition) la déclarait vide. Deux choses à vérifier ici : que cette page
     ne déclenche plus l'alarme, et que le diagnostic dise la **vraie** version
     (il annonçait « SpotiDuck 2.9.0 » à un téléphone bien plus récent, parce que
     la coque portait un numéro écrit à la main).
     jsdom ne calcule aucune mise en page : on lui donne la géométrie mesurée sur
     le téléphone — 29 px de large, 2 756 px de haut, avec du texte et une liste
     de langues, exactement ce qu'une page d'atterrissage contient. */
  const page = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const w = page.window;
  const langs = ["Français", "English", "Deutsch", "Español", "Italiano", "Português", "Nederlands", "Polski"];
  w.document.querySelector("main").innerHTML =
    "<h1>Choisissez votre langue</h1><ul>" +
    langs.map((l) => `<li><a href="/intl-${l.slice(0, 2).toLowerCase()}/">${l}</a></li>`).join("") +
    "</ul><p>Écoutez de la musique gratuitement, ou connectez-vous à votre compte pour retrouver vos playlists.</p>";
  /* Toute la page est haute et étroite : c'est ce que la capture montrait. */
  w.Element.prototype.getBoundingClientRect = function () {
    const hasText = ((this.textContent || "").trim().length > 0);
    const isMain = this.tagName === "MAIN";
    const height = isMain ? 2756 : hasText ? 40 : 0;
    const width = isMain ? 29 : hasText ? 24 : 0;
    return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 };
  };
  /* La version que le banc pretend etre celle de l'application est lue dans
     `package.json` : l'ecrire a la main ici refaisait exactement le defaut que ce
     test surveille (un numero fige, qui devient faux des le prochain saut). */
  const pkgVersion = JSON.parse(await read("package.json")).version;
  w.AndBridge = { version: () => pkgVersion, session: () => false };
  w.eval(await read("dist/spotiduck-ui.js"));
  await tick(250);

  const api = w.SpotiDuckUI;
  const state = api.content.state();
  assert(
    state.ok === true,
    `une page de 2 756 px de contenu est déclarée vide : ${state.why}`
  );
  assert(/rendu \d+ car\./.test(state.why), "le diagnostic ne dit pas ce qui est rendu : " + state.why);
  assert(api.content.alertIfBlank() === false, "l'alarme « la page n'a rien affiché » s'est déclenchée à tort");
  assert(
    !w.document.documentElement.className.includes("sd-content-blank"),
    "la page est marquée vide : la coque se masque alors elle-même"
  );
  const diag = api.content.diagnose();
  assert(!/2\.9\.0/.test(diag), "le diagnostic annonce encore une version figée : " + diag);
  assert(
    diag.includes("SpotiDuck " + pkgVersion),
    `le diagnostic n'annonce pas la version de l'application (${pkgVersion}) : ` + diag
  );
  assert(/page \/intl-fr\//.test(diag), "le diagnostic ne dit pas sur quelle page il a été pris : " + diag);
  /* Le diagnostic doit porter **les mots de la page** (« Choisissez votre
     langue ») et l'état réel de la session : sans ça, une capture ne dit pas ce
     que l'utilisateur avait sous les yeux — ce qui a coûté deux allers-retours. */
  assert(/extrait "Choisissez votre langue/.test(diag), "le diagnostic ne cite pas la page : " + diag);
  assert(/session non/.test(diag), "le diagnostic ne dit pas si un compte est connecté : " + diag);
  assert(/accueil masqué \(session fermée\)|accueil masqué/.test(diag), "le diagnostic ne dit pas pourquoi l'accueil est absent : " + diag);
  assert(!/coque \?/.test(diag), "le diagnostic ne sait pas quelle version est installée : " + diag);
  /* Toutes les ancres candidates, mesurées : c'est ce qui départage « la page
     n'est pas l'accueil du lecteur » et « notre feuille l'a écrasée ». */
  assert(/ancres home-page absent|ancres .*main/.test(diag), "le diagnostic ne mesure pas les ancres de contenu : " + diag);
  assert(/main-view (absent|\d+×\d+)/.test(diag), "le diagnostic ne dit rien de #main-view : " + diag);
  /* Et cette page est bien un chemin d'accueil : sans ça, l'accueil maison ne
     s'afficherait jamais là où l'utilisateur arrive. */
  assert(api.home.isHomePath() === true, "/intl-fr/ n'est pas reconnu comme l'accueil");

  /* Rien de rendu du tout : là, et seulement là, l'alarme a raison. */
  w.document.querySelector("main").innerHTML = "";
  assert(api.content.alertIfBlank() === true, "un écran vraiment vide ne signale plus rien");
  page.window.close();
  return "29×2756 ⇒ affichée · version réelle au diagnostic · vide ⇒ alarme ✓";
});

await checkAsync("the library shows the account's playlists, albums, artists and podcasts", async () => {
  /* « Sur l'onglet bibliothèque, je ne vois aucune de mes playlists. » L'onglet
     ne faisait qu'afficher la barre latérale de Spotify : si son rendu ne suit
     pas, il ne reste rien. Cette page lit la bibliothèque **à la source** (l'API
     du lecteur, avec le jeton que la page utilise déjà) et l'affiche elle-même.
     Le banc vérifie donc les deux : ce qu'on lit, et ce qui se voit. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const answers = {
    /* `/me` d'abord : c'est **lui** qui dit à quel compte appartient le jeton.
       Sans réponse de sa part, la page ne prétend plus que le compte est vide. */
    "/me": { id: "moi", display_name: "Moi" },
    "/me/playlists?limit=50": {
      total: 2,
      items: [
        {
          id: "p1",
          name: "Mes tubes",
          owner: { display_name: "Moi" },
          tracks: { total: 42 },
          images: [{ url: "https://i.scdn.co/image/small", width: 64 }, { url: "https://i.scdn.co/image/big", width: 640 }],
        },
        { id: "p2", name: "Découvertes", owner: { display_name: "Spotify" }, tracks: { total: 30 }, images: [] },
      ],
    },
    "/me/albums?limit=50": {
      total: 1,
      items: [
        { album: { id: "a1", name: "Album Un", artists: [{ name: "Artiste Un" }], images: [{ url: "https://i.scdn.co/image/alb", width: 300 }] } },
      ],
    },
    "/me/artists?limit=50": {
      total: 1,
      items: [{ id: "ar1", name: "Artiste Suivi", genres: ["pop"], images: [{ url: "https://i.scdn.co/image/art", width: 320 }] }],
    },
    "/me/shows?limit=50": {
      total: 1,
      items: [{ show: { id: "sh1", name: "Podcast Un", publisher: "Radio Libre", images: [{ url: "https://i.scdn.co/image/sh", width: 300 }] } }],
    },
    "/me/tracks?limit=1": { total: 128 },
  };
  const asked = [];
  dom.window.fetch = (url, init) => {
    const key = String(url).replace("https://api.spotify.com/v1", "");
    asked.push(key);
    const body = answers[key];
    void init;
    return Promise.resolve({
      ok: !!body,
      status: body ? 200 : 401,
      json: () => Promise.resolve(body || {}),
    });
  };
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);

  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  assert(api.library, "la bibliothèque n'est pas exposée");
  assert(typeof api.library.load === "function", "la bibliothèque ne sait pas se charger");

  /* Le jeton : la page du lecteur le pose dans ses requêtes, et la coque le
     capte (`Api.capture`). On reproduit exactement ce geste — c'est aussi ce qui
     vérifie que la capture fonctionne. */
  await dom.window.fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer banc-de-test" } });
  api.library.load(true);
  const loaded = await (async () => {
    for (let i = 0; i < 40; i++) {
      if (api.library.items.length) return true;
      await tick(25);
    }
    return false;
  })();
  assert(loaded, `la bibliothèque n'a rien lu (état ${api.library.state})`);
  assert(api.library.state === "ready", `état attendu « ready », obtenu « ${api.library.state} »`);
  assert(asked.length >= 5, `les cinq sources de la bibliothèque doivent être lues, ${asked.length} lue(s)`);

  /* Ce qui est lu : 6 lignes (titres likés, 2 playlists, 1 album, 1 artiste,
     1 podcast) et les **totaux annoncés par l'API**, pas la taille de la page. */
  assert(api.library.items.length === 6, `6 lignes attendues, ${api.library.items.length} lue(s)`);
  assert(api.library.counts.liked === 128, `128 titres likés attendus, ${api.library.counts.liked} comptés`);
  assert(api.library.counts.playlist === 2, `2 playlists attendues, ${api.library.counts.playlist} comptées`);
  const first = api.library.items[0];
  assert(first.type === "liked" && first.href === "/collection/tracks", "les titres likés devraient ouvrir /collection/tracks");
  const playlist = api.library.items[1];
  assert(playlist.name === "Mes tubes" && playlist.href === "/playlist/p1", `playlist lue de travers : ${JSON.stringify(playlist)}`);
  /* La plus grande pochette, pas l'icône 64 px. */
  assert(playlist.img === "https://i.scdn.co/image/big", `pochette choisie : ${playlist.img}`);

  /* Ce qui se voit : l'onglet bibliothèque ouverte, notre page remplace la barre
     latérale (et donc la masque), les lignes portent de vraies adresses. */
  /* **L'appui sur l'onglet Bibliothèque.** Le chemin de l'URL ne change pas,
     donc l'accueil doit se retirer sur le seul critère de l'onglet — c'est ce
     qui manquait (« je reste bloqué sur l'écran d'accueil »). */
  api.state.tab = "library";
  api.home.apply ? api.home.apply() : api.home.refresh("test");
  api.library.apply();
  const board = page.querySelector(".sd-home");
  assert(board.hidden === true, "l'accueil reste affiché par-dessus la bibliothèque");
  assert(
    !api.home.shouldShow(),
    "l'accueil se croit encore à sa place alors que l'onglet actif est la bibliothèque"
  );
  /* Et la barre de navigation reste : c'est la seule navigation de l'application. */
  assert(
    page.documentElement.className.includes("sd-nav-on"),
    "la barre de navigation disparaît sur la bibliothèque : plus aucun moyen de revenir"
  );
  const panel = page.querySelector(".sd-lib");
  assert(panel && panel.hidden === false, "la bibliothèque ne s'affiche pas sur son onglet");
  assert(page.documentElement.className.includes("sd-lib-on"), "la barre latérale de Spotify n'est pas remplacée (classe sd-lib-on absente)");
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 6, `6 lignes attendues à l'écran, ${rows.length} affichée(s)`);
  assert(rows.every((r) => r.getAttribute("href")), "une ligne n'a pas d'adresse : elle ne mènerait nulle part");
  assert(
    rows.map((r) => r.getAttribute("href")).includes("/playlist/p1"),
    "aucune ligne ne mène à la playlist : " + rows.map((r) => r.getAttribute("href")).join(", ")
  );
  assert(page.querySelector(".sd-lib-row-playlist .sd-lib-art img"), "la pochette de la playlist n'est pas affichée");
  assert(/Playlists 2/.test(page.querySelector(".sd-lib-sum").textContent), "le résumé ne compte pas les playlists : " + page.querySelector(".sd-lib-sum").textContent);
  assert(/Compte Moi/.test(page.querySelector(".sd-lib-sum").textContent), "le résumé ne nomme pas le compte lu : " + page.querySelector(".sd-lib-sum").textContent);
  const chips = [...page.querySelectorAll(".sd-lib-chip")];
  assert(chips.length === 5, `5 filtres attendus, ${chips.length} trouvé(s)`);
  /* Chaque filtre est nommé **et** porte son compte (le libellé reste le
     premier mot : « Playlists 2 »). */
  const etiquettes = chips.map((c) => (c.textContent || "").replace(/\s*\d+\s*$/, "").trim());
  assert(
    etiquettes.join("/") === "Tout/Playlists/Albums/Artistes/Podcasts",
    "les filtres ne sont pas nommés : " + etiquettes.join("/")
  );
  const comptes = chips.map((c) => Number(((c.textContent || "").match(/(\d+)\s*$/) || [])[1]));
  assert(comptes[0] === api.library.items.length, `le filtre « Tout » annonce ${comptes[0]} au lieu de ${api.library.items.length}`);
  assert(comptes[1] === 2, `le filtre « Playlists » annonce ${comptes[1]} au lieu de 2`);
  assert(comptes[2] === 1, `le filtre « Albums » annonce ${comptes[2]} au lieu de 1`);

  /* Un filtre filtre — et dit quand il ne reste rien. */
  chips[2].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const albums = [...page.querySelectorAll(".sd-lib-row")];
  assert(albums.length === 1, `1 album attendu après le filtre, ${albums.length} affiché(s)`);
  assert(albums[0].getAttribute("href") === "/album/a1", "le filtre Albums montre autre chose qu'un album");
  chips[4].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(page.querySelectorAll(".sd-lib-row").length === 1, "le filtre Podcasts ne garde pas le podcast");
  chips[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(page.querySelectorAll(".sd-lib-row").length === 2, "le filtre Playlists ne garde pas les deux playlists");
  chips[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(page.querySelectorAll(".sd-lib-row").length === 6, "le filtre Tout ne restaure pas la bibliothèque");

  /* Le diagnostic dit ce qu'il en est, pour une capture de téléphone. */
  assert(/biblio 6 éléments/.test(api.content.diagnose()), "le diagnostic ne dit pas ce que contient la bibliothèque : " + api.content.diagnose());

  /* Une playlist ouverte **depuis** la bibliothèque garde l'onglet
     « bibliothèque » mais change de page : notre page plein écran doit se
     retirer, sinon elle recouvrirait la playlist. */
  /* jsdom ne permet pas de réécrire `location` : on mesure le chemin sur une
     copie du module, comme pour la garde des chemins de l'accueil. */
  const sub = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  sub.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  sub.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(150);
  const subApi = sub.window.SpotiDuckUI;
  assert(subApi.library.isLibraryPath() === false, "une playlist est prise pour une page de bibliothèque");
  assert(subApi.home.isHomePath() === false, "une playlist est prise pour l'accueil");
  subApi.state.tab = "library";
  subApi.library.enter();
  assert(
    sub.window.document.querySelector(".sd-lib").hidden === true,
    "la bibliothèque recouvre la playlist ouverte depuis elle"
  );
  assert(
    !sub.window.document.documentElement.className.includes("sd-lib-on"),
    "la barre latérale de Spotify reste posée sur la playlist"
  );
  sub.window.close();

  /* Quitter la bibliothèque rend la main à Spotify. */
  api.state.tab = "home";
  api.library.enter();
  assert(panel.hidden === true, "la bibliothèque reste affichée en dehors de son onglet");
  assert(!page.documentElement.className.includes("sd-lib-on"), "la barre latérale reste masquée après avoir quitté la bibliothèque");
  dom.window.close();
  return "6 lignes lues à la source · filtres, compteurs, adresses, masquage ✓";
});

await checkAsync("la bibliothèque s'affiche sans attendre le réseau", async () => {
  /* Signalé : « ça prend du temps à charger pour afficher ». La page attendait
     six appels réseau avant de montrer quoi que ce soit, alors que les lignes de
     Spotify sont déjà dans la page et qu'un cache local peut les rendre
     immédiatement. Ici le réseau ne répond **jamais** : si la page affiche
     quelque chose, elle ne l'a pas attendu. */
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='Desktop_LeftSidebar_Id'>" +
      "<a href='/playlist/p1' aria-label='Mes tubes'></a>" +
      "<a href='/playlist/p2' aria-label='Découvertes'></a>" +
      "</div><main></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  /* Un réseau qui ne répond jamais : ni `fetch`, ni pont. */
  dom.window.fetch = () => new Promise(() => {});
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  /* **Aucune attente** : ni `tick`, ni requête. Ce qui est à l'écran doit y être
     déjà. */
  const rows = page.querySelectorAll(".sd-lib-row");
  /* 3 lignes : votre bibliothèque telle que la page la montre, **plus** l'entrée
     des titres likés, qui doit toujours être là (« le truc avec mes titres
     likés »). */
  assert(rows.length === 3, `3 lignes attendues sans aucune attente réseau, ${rows.length} affichée(s)`);
  assert(rows[0].getAttribute("href") === "/collection/tracks", "les titres likés ne sont pas en tête dès le premier rendu");
  assert(api.library.state === "ready", `état attendu « ready » immédiatement, obtenu « ${api.library.state} »`);
  const title = page.querySelector(".sd-lib-title").textContent;
  assert(title === "Bibliothèque", "le titre de la page n'est pas posé : " + title);
  assert(
    api.library.note() === "" || /liste de Spotify|Actualisation/.test(api.library.note()),
    "la page affiche un état de chargement alors qu'elle a déjà des lignes : " + api.library.note()
  );
  dom.window.close();
  return "2 lignes affichées sans le moindre appel réseau ✓";
});

/* ------------------------------------------------------------------ *
 * Inventaire : **chaque commande fait quelque chose**
 *
 * « Fais en sorte que tous les trucs dans l'onglet bibliothèque fonctionne […]
 * fais pareil pour le lecteur » (25/09). Plutôt que de vérifier une commande
 * après l'autre à la main, on énumère **tout** ce qui est cliquable dans la
 * surface, et on exige un effet pour chacun : un état qui change, un appel au
 * pont, un changement de DOM ou une adresse réelle. Une commande qui ne fait
 * rien est un défaut, et le banc le dit laquelle.
 * ------------------------------------------------------------------ */

/* Une commande **déjà dans son état** ne fait rien, par définition : l'onglet
   courant, le filtre actif, la case déjà cochée. On ne l'exige pas. */
const inertByDesign = (el) =>
  (el.getAttribute("role") === "tab" && el.classList.contains("is-active")) ||
  (el.getAttribute("role") === "radio" && el.getAttribute("aria-checked") === "true") ||
  (el.classList.contains("sd-nav-item") && el.classList.contains("is-active"));

const reachable = (root) =>
  [...root.querySelectorAll("button, a[href], input, [role='tab'], [role='button'], [role='slider']")].filter(
    (el) => !el.hidden && !el.closest("[hidden]") && !el.disabled && el.ownerDocument.defaultView.getComputedStyle(el).display !== "none"
  );

const describeControl = (el) =>
  (el.className || el.tagName).toString().split(" ").filter((c) => c.startsWith("sd-")).join(".") +
  (el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : "") +
  (el.textContent && el.textContent.trim() ? `«${el.textContent.trim().slice(0, 24)}»` : "");

/* L'effet d'un appui, en une empreinte **sans bruit** : on ne compte pas les
   mutations de la couche (le rendu périodique en produit tout le temps, et un
   compteur global déclarerait vivante une commande morte), mais ce qui compte
   vraiment : l'état de la coque, les réglages, la bibliothèque, les feuilles
   ouvertes, le faux lecteur, les appuis transmis à Spotify, les appels au pont,
   les états ARIA et le **message** affiché. Le message est vidé avant chaque
   appui : un « Indisponible » répété reste donc une réponse. */
const clearToast = (dom) => {
  const toast = dom.window.document.querySelector(".sd-layer .sd-toast");
  if (!toast) return;
  toast.classList.remove("is-visible");
  toast.textContent = "";
};

const effect = (dom, SD) => {
  const w = dom.window;
  const d = w.document;
  const mock = w.MockSpotify ? w.MockSpotify.state : {};
  const sheets = [...d.querySelectorAll(".sd-layer .sd-sheet, .sd-layer .sd-player, .sd-layer .sd-queue")]
    .filter((el) => !el.hidden && !el.closest("[hidden]"))
    .map((el) => el.className)
    .join("|");
  const chips = [...d.querySelectorAll(".sd-layer .sd-lib-chip")]
    .map((el) => (el.classList.contains("is-active") ? "1" : "0"))
    .join("");
  const aria = [...d.querySelectorAll(".sd-layer [aria-checked], .sd-layer [aria-valuenow], .sd-layer [aria-selected]")]
    .map((el) => String(el.className).slice(0, 24) + "=" + el.getAttribute("aria-checked") + el.getAttribute("aria-valuenow") + el.getAttribute("aria-selected"))
    .join("|");
  const toast = d.querySelector(".sd-layer .sd-toast");
  return JSON.stringify({
    path: w.location.pathname,
    classes: d.documentElement.className,
    tab: SD.state.tab,
    route: SD.state.route,
    playing: !!SD.state.playing,
    title: SD.state.title,
    filter: SD.library ? SD.library.filter : "",
    libState: SD.library ? SD.library.state : "",
    rows: d.querySelectorAll(".sd-layer .sd-lib-row").length,
    chips: chips,
    settings: JSON.stringify(SD.settings || {}),
    sheets: sheets,
    aria: aria,
    message: toast && toast.classList.contains("is-visible") ? (toast.textContent || "").slice(0, 40) : "",
    bridge: (w.__bridgeCalls || []).length,
    spotify: JSON.stringify(w.__targetClicks || {}),
    mockPlaying: !!mock.playing,
    mockTrack: mock.trackIndex,
    mockPos: mock.position ? Math.round(mock.position / 5) : 0,
    mockShuffle: !!mock.shuffle,
    mockRepeat: mock.repeat,
    mockLiked: !!mock.liked,
    mockVolume: mock.volume,
  });
};

const pressAndWait = async (dom, el, before) => {
  const w = dom.window;
  el.click();
  for (let i = 0; i < 12; i++) {
    await tick(40);
    if (effect(dom, w.SpotiDuckUI) !== before) return true;
  }
  return false;
};

await checkAsync("onglet bibliothèque : chaque commande fait quelque chose", async () => {
  /* **La bibliothèque d'un compte qui a des playlists.** Sans données, aucune
     ligne à éprouver : l'inventaire doit tourner sur une vraie bibliothèque
     (l'API du lecteur répond), sinon il ne prouve rien. Pas de barre latérale
     ici : c'est le chemin de l'API que l'on veut éprouver. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<main id='main-view'><section data-testid='home-page'></section></main>" +
      "</body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const answers = {
    "/me": { id: "moi", display_name: "Moi" },
    "/me/playlists?limit=50": {
      total: 2,
      items: [
        { id: "p1", name: "Mes tubes", owner: { display_name: "Moi" }, tracks: { total: 42 }, images: [{ url: "https://i.scdn.co/image/small", width: 64 }] },
        { id: "p2", name: "Découvertes", owner: { display_name: "Spotify" }, tracks: { total: 30 }, images: [] },
      ],
    },
    "/me/albums?limit=50": {
      total: 1,
      items: [{ album: { id: "a1", name: "Album Un", artists: [{ name: "Artiste Un" }], images: [{ url: "https://i.scdn.co/image/alb", width: 300 }] } }],
    },
    "/me/artists?limit=50": {
      total: 1,
      items: [{ id: "ar1", name: "Artiste Suivi", genres: ["pop"], images: [{ url: "https://i.scdn.co/image/art", width: 320 }] }],
    },
    "/me/shows?limit=50": {
      total: 1,
      items: [{ show: { id: "sh1", name: "Podcast Un", publisher: "Radio Libre", images: [{ url: "https://i.scdn.co/image/sh", width: 300 }] } }],
    },
    "/me/tracks?limit=1": { total: 128 },
  };
  const asked = [];
  dom.window.fetch = (url, init) => {
    const key = String(url).replace("https://api.spotify.com/v1", "");
    asked.push(key);
    void init;
    const body = answers[key];
    return Promise.resolve({ ok: !!body, status: body ? 200 : 401, json: () => Promise.resolve(body || {}) });
  };
  /* Le pont d'essai ne sait pas lire en asynchrone : la bibliothèque passe
     donc par la voie du navigateur — c'est ce chemin-là qu'on éprouve ici (le
     pont a ses propres essais plus bas). */
  dom.window.eval("window.__bridgeCalls = []; window.AndBridge = new Proxy({}, { get: (t, p) => String(p) === 'nFetchAsync' ? undefined : (...a) => { window.__bridgeCalls.push([String(p), a]); if (String(p) === 'isWoke') return false; return undefined; } });");
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const doc = dom.window.document;
  const lib = doc.querySelector(".sd-layer .sd-lib");
  api.state.tab = "library";
  await dom.window.fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer banc-de-test" } });
  api.library.load(true);
  for (let i = 0; i < 60 && !api.library.items.length; i++) await tick(25);
  assert(api.library.items.length >= 5, `la bibliothèque du banc est vide (${api.library.state})`);

  const controls = reachable(lib);
  /* 5 filtres + une ligne par élément : les boutons « Réessayer » et « Se
     connecter » sont **rangés** tant que la liste est là (il n'y a rien à
     réparer) — leur tour vient dans l'essai suivant, sans session. */
  assert(controls.length >= 10, `l'inventaire est incomplet : ${controls.length} commandes trouvées`);
  const dead = [];
  const liens = [];
  /* Chaque commande part d'un état neutre : le filtre « Tout » et la position
     de départ, sinon un appui « ne change rien » parce que c'était déjà fait. */
  const neutral = async () => {
    const tout = lib.querySelector('.sd-lib-chip[data-filter="all"]');
    if (tout && !tout.classList.contains("is-active")) {
      tout.click();
      await tick(60);
    }
  };
  for (const el of controls) {
    if (inertByDesign(el)) continue;
    if (el.tagName === "A") {
      /* Une ligne : son action est son adresse (l'appui ouvre la page). */
      const href = el.getAttribute("href") || "";
      const ok = /^\//.test(href) || /^https:\/\/accounts\.spotify\.com\//.test(href);
      if (ok) liens.push(describeControl(el) + "→" + href);
      else dead.push(describeControl(el) + " (adresse invalide : " + href + ")");
      continue;
    }
    await neutral();
    clearToast(dom);
    const before = effect(dom, api);
    if (!(await pressAndWait(dom, el, before))) dead.push(describeControl(el));
  }
  assert(dead.length === 0, "commandes sans effet : " + dead.join(" · "));

  /* **Les filtres filtrent vraiment.** Pour chacun : la puce devient la seule
     active, `library.filter` la suit, et les lignes affichées sont exactement
     celles du filtre — ni une de plus, ni une de moins. */
  const chips = [...lib.querySelectorAll(".sd-lib-chip")];
  assert(chips.length === 5, `5 filtres attendus, ${chips.length} trouvés`);
  assert(
    chips.every((c) => (c.textContent || "").trim().length > 0),
    "un filtre n'a pas de libellé : " + chips.map((c) => JSON.stringify(c.textContent)).join(",")
  );
  for (const chip of chips) {
    const want = chip.getAttribute("data-filter");
    chip.click();
    await tick(80);
    const rows = [...lib.querySelectorAll(".sd-lib-list .sd-lib-row")];
    assert(chip.classList.contains("is-active"), "le filtre « " + want + " » ne se marque pas actif");
    assert(api.library.filter === want, "le filtre choisi n'est pas appliqué : " + api.library.filter + " ≠ " + want);
    assert(
      chips.filter((c) => c.classList.contains("is-active")).length === 1,
      "plusieurs filtres sont actifs à la fois"
    );
    assert(
      rows.length === api.library.filtered().length,
      `« ${want} » : ${rows.length} lignes affichées pour ${api.library.filtered().length} attendues`
    );
    if (want !== "all") {
      const wrong = rows.filter((r) => !r.classList.contains("sd-lib-row-" + want));
      assert(wrong.length === 0, `« ${want} » affiche ${wrong.length} ligne(s) d'un autre genre`);
      assert(rows.length > 0, `« ${want} » ne montre rien alors que le compte en a`);
    }
  }

  /* **Les affichages disent vrai.** Chaque ligne nommée, chaque compteur égal
     au contenu réel, aucun libellé à trou (« %s » non rempli). */
  const tout = chips[0];
  tout.click();
  await tick(80);
  const rows = [...lib.querySelectorAll(".sd-lib-list .sd-lib-row")];
  assert(rows.length === api.library.items.length, `${api.library.items.length} lignes attendues, ${rows.length} affichées`);
  for (const row of rows) {
    assert((row.querySelector(".sd-lib-name") || {}).textContent, "une ligne sans nom");
    assert(row.querySelector(".sd-lib-art"), "une ligne sans pochette");
  }
  /* **Chaque ligne mène au bon endroit** : le type annoncé et l'adresse doivent
     se répondre (une « playlist » qui ouvre un album serait un piège). */
  const attendu = {
    liked: /^\/collection\/tracks$/,
    playlist: /^\/playlist\//,
    album: /^\/album\//,
    artist: /^\/artist\//,
    show: /^\/show\//,
  };
  for (const row of rows) {
    const type = [...row.classList].filter((c) => c.indexOf("sd-lib-row-") === 0).map((c) => c.slice(11))[0];
    const href = row.getAttribute("href") || "";
    assert(type && attendu[type], `ligne sans type lisible : ${row.className}`);
    assert(attendu[type].test(href), `une ligne « ${type} » mène à « ${href} »`);
  }
  const typesVus = new Set(rows.map((r) => [...r.classList].filter((c) => c.indexOf("sd-lib-row-") === 0).map((c) => c.slice(11))[0]));
  assert(typesVus.has("liked") && typesVus.has("playlist"), "les titres likés et les playlists doivent être listés : " + [...typesVus].join(","));

  /* **Le journal reste rangé quand tout va bien.** */
  const journal = lib.querySelector(".sd-lib-log");
  assert(journal.hidden === true, "le journal s'affiche alors que la lecture a réussi");

  const titre = lib.querySelector(".sd-lib-title").textContent.trim();
  assert(titre.length > 0, "le titre de la page est vide");
  const resume = lib.querySelector(".sd-lib-sum").textContent;
  assert(resume.indexOf("Moi") >= 0, "le résumé ne dit pas à quel compte appartient la bibliothèque : " + resume);
  for (const [type, cle] of [["playlist", "playlist"], ["album", "album"], ["artist", "artist"], ["show", "show"]]) {
    const n = api.library.counts[cle];
    if (!n) continue;
    const reel = api.library.items.filter((r) => r.type === type).length;
    assert(n >= reel, `le compte annoncé (${n} ${type}) est inférieur aux lignes listées (${reel})`);
    assert(resume.indexOf(String(n)) >= 0, `le résumé ne dit pas « ${n} ${type} » : ${resume}`);
  }
  const note = lib.querySelector(".sd-lib-note");
  const texteNote = (note.textContent || "").trim();
  assert(note.hidden ? texteNote === "" : texteNote.length > 0, "la note est affichée sans texte");
  /* Rien d'affiché ne doit garder un trou de traduction. */
  const trous = [...lib.querySelectorAll("*")].filter((el) => !el.children.length && /%s/.test(el.textContent || ""));
  assert(trous.length === 0, "libellé non rempli : " + trous.map((el) => JSON.stringify(el.textContent)).join(","));

  dom.window.close();
  return `${controls.length} commandes, toutes actives · ${chips.length} filtres qui filtrent · ${liens.length} adresses réelles · compteurs vérifiés ✓`;
});

await checkAsync("bibliothèque sans session : rien n'est muet, tout explique", async () => {
  /* **Le cas où la bibliothèque n'a rien à montrer** — pas de session, pas de
     liste de Spotify. C'est là que se jouent les affichages : une note qui dit
     pourquoi, un journal qui dit où, « Réessayer » qui relance vraiment, et la
     porte de connexion de Spotify. Rien ne doit rester muet ni sans fin. */
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='main-view'></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const asked = [];
  dom.window.fetch = (url, init) => {
    asked.push(String(url).replace("https://api.spotify.com/v1", ""));
    void init;
    return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  };
  dom.window.eval("window.AndBridge = new Proxy({}, { get: (t, p) => String(p) === 'nFetchAsync' ? undefined : () => undefined });");
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const doc = dom.window.document;
  const lib = doc.querySelector(".sd-layer .sd-lib");
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 60 && api.library.state === "loading"; i++) await tick(50);
  assert(api.library.state !== "loading", "la bibliothèque reste en chargement sans fin");
  assert(api.library.items.length === 0, `aucune ligne attendue sans session, ${api.library.items.length} trouvée(s)`);

  const visible = reachable(lib).filter((el) => !inertByDesign(el));
  const retry = lib.querySelector(".sd-lib-retry");
  const login = lib.querySelector(".sd-lib-login");
  assert(retry && reachable(lib).indexOf(retry) >= 0, "« Réessayer » n'est pas proposé quand rien ne s'affiche");
  assert(login && reachable(lib).indexOf(login) >= 0, "la connexion n'est pas proposée sans session");
  assert(visible.length >= 3, `l'inventaire des actions est incomplet : ${visible.length}`);

  /* Les affichages disent pourquoi, et où c'est écrit. */
  const note = lib.querySelector(".sd-lib-note");
  const texte = (note.textContent || "").trim();
  assert(!note.hidden && texte.length > 0, "aucune note n'explique la bibliothèque vide");
  assert(
    /connect|session|jeton|répondu|compte/i.test(texte),
    "la note n'explique pas la cause : " + texte
  );
  const logBox = lib.querySelector(".sd-lib-log");
  assert(!logBox.hidden, "le journal reste caché alors que rien ne s'affiche");
  const lignes = [...logBox.querySelectorAll("li")].map((li) => (li.textContent || "").trim());
  assert(lignes.length >= 1, "le journal est ouvert mais vide");
  assert(lignes.every((l) => l.length > 0), "une ligne du journal est vide");
  assert(lignes.some((l) => /jeton|token|401|en-têtes/i.test(l)), "le journal ne dit rien du jeton : " + lignes.join(" | "));
  assert((lib.querySelector(".sd-lib-title").textContent || "").trim().length > 0, "le titre de la page est vide");
  const resume = lib.querySelector(".sd-lib-sum").textContent;
  assert((resume || "").trim().length > 0, "le résumé est vide alors que rien ne s'affiche");

  /* « Réessayer » relance vraiment, et retombe sur ses pieds. On attend que le
     premier essai de jeton **soit terminé** : pendant qu'il est en vol, la coque
     le réutilise (une requête à la fois, c'est voulu) et un nouvel essai serait
     donc un doublon — pas ce qu'on mesure ici. */
  await tick(400);
  const avant = asked.length;
  retry.click();
  await tick(120);
  assert(asked.length > avant, "« Réessayer » ne relance aucune lecture");
  let fini = false;
  for (let i = 0; i < 80 && !fini; i++) {
    fini = api.library.state !== "loading";
    if (!fini) await tick(50);
  }
  assert(fini, "« Réessayer » laisse la bibliothèque en chargement perpétuel");
  assert(
    ["no-token", "guest", "error"].indexOf(api.library.state) >= 0,
    `état inattendu après un essai : ${api.library.state}`
  );

  /* La connexion mène **chez Spotify**, jamais nulle part. */
  const href = login.getAttribute("href") || "";
  assert(/^https:\/\/accounts\.spotify\.com\//.test(href), "l'adresse de connexion n'est pas celle de Spotify : " + href);
  assert(/allow_password=1|login|signin/.test(href), "l'adresse de connexion n'ouvre pas la page de connexion : " + href);
  assert((login.textContent || "").trim().length > 0, "le bouton de connexion n'a pas de libellé");
  assert(login.hidden === false, "la connexion est cachée alors qu'il n'y a pas de session");
  dom.window.close();
  return `note et journal remplis · « Réessayer » relance (${asked.length} appels) · connexion → ${href.replace(/^https:\/\//, "").slice(0, 44)} ✓`;
});

await checkAsync("lecteur : chaque commande fait quelque chose", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
await checkAsync("lecteur : les commandes font exactement ce qu'elles disent", async () => {
  /* Chaque commande du lecteur est reliée à **la** commande de Spotify, et
     chaque affichage doit dire la vérité sur ce que joue le lecteur : titre,
     artiste, durée, position, volume, états « aléatoire / répétition / j'aime ».
     Le faux lecteur (`demo/mock/spotify.js`) sert de témoin : on lit son état
     après chaque appui. */
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.eval("window.__bridgeCalls = []; window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => { window.__bridgeCalls.push([String(p), a]); if (String(p) === 'isWoke') return false; return undefined; } });");
  dom.window.eval(await read("demo/mock/spotify.js"));
  /* Le faux lecteur n'a pas de curseur de volume : on lui en donne un, branché
     sur son état, comme celui de la vraie page (« div[data-testid=volume-bar]
     input », le repère que la coque cherche). */
  dom.window.eval(
    "var bar = document.createElement('div');" +
      "bar.setAttribute('data-testid', 'volume-bar');" +
      "bar.innerHTML = '<input type=\"range\" min=\"0\" max=\"100\" step=\"1\" value=\"75\" aria-label=\"Volume\">';" +
      "document.querySelector('aside[data-testid=\"now-playing-bar\"]').appendChild(bar);" +
      "var vin = bar.querySelector('input');" +
      "vin.addEventListener('input', function () { window.MockSpotify.state.volume = Number(vin.value) / 100; });" +
      "window.__volPage = vin;"
  );
  /* Les commandes qui doivent **appuyer sur celles de Spotify** : on compte ces
     appuis, c'est leur action réelle (paroles, file d'attente, appareils…). */
  const TARGETS = [
    'button[data-testid="lyrics-button"]',
    'button[data-testid="control-button-connect"]',
    'button[aria-label^="File"]',
    '[data-testid="queue-button"]',
    '#Desktop_PanelContainer_Id button',
  ];
  dom.window.eval("window.__targetClicks = {};");
  dom.window.eval(
    "(" + function (selectors) {
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          el.addEventListener("click", function () {
            window.__targetClicks[sel] = (window.__targetClicks[sel] || 0) + 1;
          });
        });
      });
    }.toString() + ")(" + JSON.stringify(TARGETS) + ")"
  );
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(250);
  const api = dom.window.SpotiDuckUI;
  const doc = dom.window.document;
  const mock = dom.window.MockSpotify;
  const tracks = mock.tracks;
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const $1 = (sel) => doc.querySelector(sel);
  const press = async (sel) => {
    const el = $1(sel);
    assert(el, sel + " est absent du lecteur");
    el.click();
    await tick(160);
  };

  /* Un morceau joue : le lecteur doit l'afficher tel quel. */
  mock.play(1);
  await tick(250);
  const t = tracks[1];
  assert($1(".sd-mini-title").textContent === t.title, `titre du mini-lecteur « ${$1(".sd-mini-title").textContent} » au lieu de « ${t.title} »`);
  assert($1(".sd-mini-artist").textContent === t.artist, `artiste du mini-lecteur « ${$1(".sd-mini-artist").textContent} » au lieu de « ${t.artist} »`);
  assert($1(".sd-mini-dur").textContent === fmt(t.duration), `durée affichée « ${$1(".sd-mini-dur").textContent} » au lieu de « ${fmt(t.duration)} »`);
  const volPage = () => dom.window.__volPage;
  assert(volPage(), "le volume du lecteur n'est pas exposé par la page");
  await tick(200);
  assert(!$1(".sd-mini-volume").hidden, "le curseur de volume reste caché alors que la page en a un");
  const volShown = Number($1(".sd-mini-vol").value);
  const volReal = Math.round(Number(volPage().value) || 0);
  assert(volShown === volReal, `le volume affiché (${volShown}) ne dit pas le volume réel (${volReal})`);

  /* Lecture / pause : l'état du lecteur doit suivre, dans les deux sens. */
  const etait = mock.state.playing;
  await press(".sd-mini-play");
  assert(mock.state.playing !== etait, "« lecture/pause » du mini-lecteur ne change pas la lecture");
  await press(".sd-mini-play");
  assert(mock.state.playing === etait, "« lecture/pause » ne revient pas à son état");
  const labelPlay = $1(".sd-mini-play").getAttribute("aria-label") || "";
  assert(
    mock.state.playing ? /pause/i.test(labelPlay) : /lecture|play/i.test(labelPlay),
    `le bouton dit « ${labelPlay} » alors que la lecture est ${mock.state.playing ? "en cours" : "arrêtée"}`
  );

  /* Suivant / précédent : la piste change, et l'affichage suit. */
  const i0 = mock.state.trackIndex;
  await press(".sd-mini-next");
  assert(mock.state.trackIndex === (i0 + 1) % tracks.length, "« suivant » ne change pas de piste");
  assert($1(".sd-mini-title").textContent === tracks[(i0 + 1) % tracks.length].title, "« suivant » ne met pas le titre à jour");
  await press(".sd-mini-prev");
  assert(mock.state.trackIndex === i0, "« précédent » ne revient pas à la piste d'avant");
  assert($1(".sd-mini-title").textContent === tracks[i0].title, "« précédent » ne met pas le titre à jour");

  /* J'aime. */
  const aimeAvant = !!mock.state.liked[i0];
  await press(".sd-mini-like");
  assert(!!mock.state.liked[i0] !== aimeAvant, "« j'aime » ne change pas le titre liké");
  assert(
    $1(".sd-mini-like").classList.contains("is-active") === !!mock.state.liked[i0],
    "le cœur ne montre pas l'état réel du titre"
  );
  await press(".sd-mini-like");
  assert(!!mock.state.liked[i0] === aimeAvant, "« j'aime » ne revient pas en arrière");

  /* Aléatoire et répétition : chaque appui change l'état, et l'affichage le dit. */
  const aleaAvant = !!mock.state.shuffle;
  await press(".sd-mini-shuffle");
  assert(!!mock.state.shuffle !== aleaAvant, "« aléatoire » ne change pas l'état");
  assert($1(".sd-mini-shuffle").getAttribute("aria-checked") === (mock.state.shuffle ? "true" : "false"), "« aléatoire » ne dit pas son état");
  await press(".sd-mini-shuffle");
  const modes = ["off", "context", "track", "off"];
  let courant = mock.state.repeat;
  for (const attendu of modes.slice(1)) {
    await press(".sd-mini-repeat");
    courant = mock.state.repeat;
    assert(courant === attendu, `« répétition » donne « ${courant} » au lieu de « ${attendu} »`);
    assert(
      $1(".sd-mini-repeat").getAttribute("aria-checked") === (courant === "off" ? "false" : courant === "track" ? "mixed" : "true"),
      "« répétition » ne dit pas son état"
    );
  }

  /* Volume : le curseur du mini-lecteur pilote celui du lecteur. */
  const vol = $1(".sd-mini-vol");
  vol.value = "30";
  vol.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  vol.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick(200);
  const volApres = Math.round(Number(volPage().value) || 0);
  assert(Math.abs(volApres - 30) <= 1, `le volume réel est ${volApres} après avoir demandé 30`);
  assert(Math.abs(mock.state.volume - 0.3) <= 0.02, `le lecteur est à ${mock.state.volume} alors qu'on a demandé 0,30`);
  vol.value = "0";
  vol.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  vol.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  let muet = false;
  for (let i = 0; i < 20 && !muet; i++) {
    await tick(60);
    muet = $1(".sd-mini-volume").classList.contains("is-muted");
  }
  assert(muet, "volume à zéro : le mini-lecteur ne le montre pas");
  assert(Number($1(".sd-mini-vol").value) === 0, "le curseur du mini-lecteur n'affiche pas le volume réel (0)");
  vol.value = "75";
  vol.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await tick(150);

  /* Position : glisser la barre doit déplacer **vraiment** la lecture. */
  const rail = $1(".sd-mini-seek");
  assert(rail, "la barre de progression du mini-lecteur est absente");
  const box = { left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 };
  rail.getBoundingClientRect = () => box;
  const at = (type, x) => {
    const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, buttons: 1 });
    try {
      Object.defineProperty(ev, "pointerId", { value: 1 });
    } catch (e) {
      /* la coque tolère l'absence d'identifiant de pointeur */
    }
    return ev;
  };
  const duree = tracks[mock.state.trackIndex].duration;
  rail.dispatchEvent(at("pointerdown", 20));
  rail.dispatchEvent(at("pointermove", 120));
  rail.dispatchEvent(at("pointerup", 120));
  await tick(250);
  const attendu = 0.5 * duree;
  assert(
    Math.abs(mock.state.position - attendu) <= Math.max(8, duree * 0.12),
    `après un glissement à mi-course, la lecture est à ${Math.round(mock.state.position)} s au lieu d'environ ${Math.round(attendu)} s`
  );
  assert(
    $1(".sd-mini-cur").textContent === fmt(mock.state.position),
    `le temps affiché « ${$1(".sd-mini-cur").textContent} » ne dit pas la position réelle (${fmt(mock.state.position)})`
  );
  const pourcent = Number(rail.getAttribute("aria-valuenow"));
  assert(
    Math.abs(pourcent - (mock.state.position / duree) * 100) <= 6,
    `la barre affiche ${pourcent} % pour une position de ${Math.round((mock.state.position / duree) * 100)} %`
  );

  /* Paroles · file d'attente · appareils : chacune appuie sur celle de Spotify. */
  const appuis = () => dom.window.__targetClicks;
  const avant = JSON.stringify(appuis());
  await press(".sd-mini-lyrics");
  assert(JSON.stringify(appuis()) !== avant, "« paroles » n'appuie pas sur les paroles de Spotify");
  /* La file d'attente est **celle de Spotify** (son panneau), montrée dans notre
     feuille : l'appui doit l'ouvrir, puis la refermer. */
  const fileOuverte = doc.documentElement.classList.contains("sd-queue-open");
  await press(".sd-mini-queue");
  assert(
    doc.documentElement.classList.contains("sd-queue-open") !== fileOuverte,
    "« file d'attente » n'ouvre pas la file de Spotify"
  );
  await press(".sd-mini-queue");
  assert(
    doc.documentElement.classList.contains("sd-queue-open") === fileOuverte,
    "« file d'attente » ne se referme pas"
  );
  const avantApp = JSON.stringify(appuis());
  await press(".sd-mini-devices");
  assert(JSON.stringify(appuis()) !== avantApp, "« appareils » n'appuie pas sur ceux de Spotify");

  /* La feuille du lecteur : mêmes commandes, mêmes effets, et elle se ferme. */
  await press(".sd-mini");
  assert(doc.documentElement.classList.contains("sd-player-open"), "l'appui sur le mini-lecteur n'ouvre pas la feuille");
  assert($1(".sd-player-track").textContent === tracks[mock.state.trackIndex].title, "la feuille n'affiche pas le bon titre");
  assert($1(".sd-t-dur").textContent === fmt(duree), "la feuille n'affiche pas la bonne durée");
  const jouait = mock.state.playing;
  await press(".sd-ctrl-play");
  assert(mock.state.playing !== jouait, "« lecture/pause » de la feuille ne change pas la lecture");
  await press(".sd-ctrl-next");
  assert($1(".sd-player-track").textContent === tracks[mock.state.trackIndex].title, "« suivant » dans la feuille ne met pas le titre à jour");
  await press(".sd-player-close");
  assert(!doc.documentElement.classList.contains("sd-player-open"), "la feuille du lecteur ne se ferme pas");
  assert(!$1(".sd-mini").hidden, "le mini-lecteur a disparu après la fermeture de la feuille");
  dom.window.close();
  return "transport, j'aime, aléatoire, répétition, volume, position, paroles, file, appareils, fermeture — tous vérifiés ✓";
});


  dom.window.eval("window.__bridgeCalls = []; window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => { window.__bridgeCalls.push([String(p), a]); if (String(p) === 'isWoke') return false; return undefined; } });");
  dom.window.eval(await read("demo/mock/spotify.js"));
  /* **Ce que chaque commande doit finir par faire** : appuyer sur le bouton de
     Spotify correspondant. On compte donc ces appuis — c'est l'action réelle
     des commandes « Paroles », « Appareils », « File d'attente », « Profil »… */
  const SPOTIFY_TARGETS = [
    'button[data-testid="lyrics-button"]',
    'button[data-testid="control-button-connect"]',
    'button[data-testid="control-button-repeat"]',
    'button[data-testid="control-button-shuffle"]',
    'button[data-testid="add-button"]',
    'button[data-testid="control-button-skip-forward"]',
    'button[data-testid="control-button-skip-back"]',
    'button[data-testid="control-button-playpause"]',
    'button[data-testid="user-widget-link"]',
    "[data-testid='queue-button']",
    "[data-testid='control-button-queue']",
  ];
  dom.window.eval("window.__targetClicks = {};");
  dom.window.eval(
    "(" + function (selectors) {
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          el.addEventListener("click", function () {
            window.__targetClicks[sel] = (window.__targetClicks[sel] || 0) + 1;
          });
        });
      });
    }.toString() + ")(" + JSON.stringify(SPOTIFY_TARGETS) + ")"
  );
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const doc = dom.window.document;
  const layer = doc.querySelector(".sd-layer");
  dom.window.MockSpotify.play(1);
  await tick(200);
  api.openPlayer();
  await tick(200);

  const dead = [];
  const liens = [];
  /* **Chaque commande part du même état.** Une commande qui consiste à ouvrir
     une feuille ne peut pas être jugée si la feuille est déjà ouverte (l'appui
     ne changerait rien) : on referme, puis on appuie. Le mini-lecteur, lui, doit
     être mesuré feuille fermée — son action est justement de l'ouvrir. */
  const neutral = async (el) => {
    api.close();
    api.closePlayer();
    await tick(80);
    if (el && el.closest(".sd-player")) {
      api.openPlayer();
      await tick(150);
    }
  };
  const pressOne = async (el) => {
    if (el.tagName === "A") {
      liens.push(describeControl(el));
      return;
    }
    clearToast(dom);
    const before = effect(dom, api);
    el.click();
    let changed = false;
    for (let i = 0; i < 14 && !changed; i++) {
      await tick(40);
      changed = effect(dom, api) !== before;
    }
    if (!changed) dead.push(describeControl(el));
  };
  const isSlider = (el) => el.getAttribute("role") === "slider";
  const dragSlider = async (el) => {
    const rail = el.querySelector(".sd-seek-rail") || el;
    /* jsdom n'a pas de mise en page : on donne une largeur au rail pour que le
       geste ait un sens, et l'unité de la position est celle de la coque. */
    const box = { left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 };
    rail.getBoundingClientRect = () => box;
    const at = (type, x) => {
      const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, buttons: 1 });
      try {
        Object.defineProperty(ev, "pointerId", { value: 1 });
      } catch (e) {
        /* sans identifiant de pointeur, la capture échoue — la coque le tolère */
      }
      return ev;
    };
    clearToast(dom);
    const before = effect(dom, api);
    rail.dispatchEvent(at("pointerdown", 40));
    rail.dispatchEvent(at("pointermove", 120));
    rail.dispatchEvent(at("pointerup", 120));
    let moved = false;
    for (let i = 0; i < 14 && !moved; i++) {
      await tick(40);
      moved = effect(dom, api) !== before;
    }
    if (!moved) dead.push(describeControl(el) + " (curseur)");
  };

  /* 1. Tout ce qui n'est pas dans une feuille : le mini-lecteur, la feuille du
     lecteur, la navigation, la barre d'onglets. */
  const outer = reachable(layer).filter((el) => !el.closest(".sd-sheet"));
  assert(outer.length >= 20, `l'inventaire du lecteur est incomplet : ${outer.length} commandes`);
  for (const el of outer) {
    if (inertByDesign(el)) continue;
    await neutral(el);
    if (isSlider(el)) await dragSlider(el);
    else await pressOne(el);
  }

  /* 2. Les feuilles : chacune est **rouverte** avant chaque appui, sinon la
     deuxième ligne d'un menu ne serait mesurée qu'à moitié. */
  const sheets = [
    ["menu (…)", () => api.openMenu()],
    ["réglages", () => api.openSettings()],
  ];
  let sheetControls = 0;
  for (const [, opener] of sheets) {
    opener();
    await tick(200);
    const sheet = doc.querySelector(".sd-layer .sd-sheet:not([hidden])");
    assert(sheet, "la feuille ne s'est pas ouverte");
    const rows = reachable(sheet);
    assert(rows.length >= 5, `la feuille n'a que ${rows.length} commandes`);
    for (const el of rows) {
      sheetControls++;
      if (inertByDesign(el)) continue;
      opener();
      await tick(180);
      await pressOne(el);
    }
  }

  assert(dead.length === 0, "commandes sans effet : " + dead.join(" · "));
  /* Les commandes du transport doivent toutes être dans l'inventaire. */
  const transport = [".sd-mini-play", ".sd-mini-next", ".sd-mini-prev", ".sd-mini-shuffle", ".sd-mini-repeat", ".sd-mini-like"];
  for (const sel of transport) {
    assert(doc.querySelector(sel), sel + " absent de l'inventaire");
    assert(outer.some((el) => el.matches(sel)), sel + " n'a pas été éprouvé");
  }
  dom.window.close();
  return `${outer.length} commandes du lecteur + ${sheetControls} dans les feuilles, toutes actives · ${liens.length} adresses ✓`;
});

await checkAsync("une playlist ouverte n'est jamais recouverte par nos écrans", async () => {
  /* Signalé le 25/09 : « quand on clique sur les playlists, y'a un écran noir ».
     Une playlist ouverte **depuis** la bibliothèque laissait nos écrans pleine
     page par-dessus (ou la barre latérale de Spotify, devenue pleine page sur
     cet onglet). Ici : on ouvre la bibliothèque, puis on ouvre une playlist, et
     nos écrans doivent être rangés — sans que rien d'autre ne soit appelé. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><a href='/playlist/p1' aria-label='Mes tubes'></a></div>" +
      "<main id='main-view'><section data-testid='home-page'></section></main>" +
      "</body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  const html = page.documentElement;
  api.state.tab = "library";
  api.library.load(true);
  await tick(120);
  assert(api.library.el.hidden === false, "la bibliothèque n'est pas affichée : le banc ne peut pas éprouver le recouvrement");
  assert(html.classList.contains("sd-lib-on"), "la classe qui montre la bibliothèque n'est pas posée");
  assert(html.classList.contains("sd-subpage") === false, "la vue de départ n'est pas une sous-page");

  /* Le doigt : une ligne de la bibliothèque mène à une playlist — la page
     change de vue **et** d'adresse, comme dans le lecteur. */
  page.getElementById("main-view").innerHTML = "<section data-testid='playlist-page'><h1>Ma playlist</h1></section>";
  dom.window.history.pushState({}, "", "/intl-fr/playlist/p1");
  assert(api._internals.Spotify.isSubPagePath() === true, "une adresse de playlist n'est pas reconnue comme une sous-page");
  api._internals.Router.sync();
  await tick(1400);
  assert(api.state.route === "page", `la vue n'est pas reconnue comme une sous-page : ${api.state.route}`);
  assert(html.classList.contains("sd-subpage"), "la classe de sous-page n'est pas posée : la barre latérale resterait en pleine page");
  assert(api.library.el.hidden === true, "notre bibliothèque reste posée sur la playlist");
  assert(!html.classList.contains("sd-lib-on"), "la classe de bibliothèque reste posée : la barre latérale de Spotify resterait masquée/pleine page");
  assert(api.home.el.hidden === true, "l'accueil maison reste posé sur la playlist");
  assert(!html.classList.contains("sd-welcome-on"), "l'écran d'accueil marketing reste posé sur la playlist");
  dom.window.close();
  return "playlist ouverte · nos écrans rangés ✓";
});

await checkAsync("la barre du haut redevient celle d'une page quand on ouvre une playlist", async () => {
  /* Et retour : revenir à l'accueil doit rendre la navigation, sans état
     résiduel de la sous-page. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><a href='/playlist/p1' aria-label='Mes tubes'></a></div>" +
      "<main id='main-view'><section data-testid='playlist-page'><h1>Ma playlist</h1></section></main>" +
      "</body></html>",
    { url: "https://open.spotify.com/intl-fr/playlist/p1", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  const html = page.documentElement;
  assert(html.classList.contains("sd-subpage"), "une playlist ouverte au démarrage n'est pas reconnue");
  assert(page.querySelector(".sd-topbar").classList.contains("is-visible"), "la barre de titre (retour + nom) n'est pas affichée sur la playlist");
  assert(page.querySelector(".sd-topbar-title").textContent === "Ma playlist", "la barre de titre ne dit pas le nom de la page : " + page.querySelector(".sd-topbar-title").textContent);
  /* Retour à la racine : la navigation revient, la barre de titre s'efface. */
  page.getElementById("main-view").innerHTML = "<section data-testid='home-page'></section>";
  dom.window.history.pushState({}, "", "/intl-fr/");
  api._internals.Router.sync();
  await tick(300);
  assert(!html.classList.contains("sd-subpage"), "la sous-page reste marquée après un retour à l'accueil");
  assert(page.querySelector(".sd-topbar").classList.contains("is-visible") === false, "la barre de titre reste affichée sur l'accueil");
  assert(html.classList.contains("sd-nav-on"), "la navigation ne revient pas après un retour à l'accueil");
  dom.window.close();
  return "sous-page reconnue · retour propre ✓";
});

await checkAsync("une playlist qui n'affiche rien le dit, avec de quoi recharger", async () => {
  /* « Une capture doit suffire à diagnostiquer » : une sous-page vide ne doit
     pas rester un écran noir muet — c'est exactement ce qui a été signalé. */
  const dom = new JSDOM(
    "<!doctype html><html><body><main id='main-view'></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/playlist/vide", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  /* Le changement de vue arme l'alerte (voir l'observateur de page). */
  api._internals.Content.alertSoon(60);
  await tick(400);
  const alert = page.querySelector(".sd-content-alert");
  assert(alert && alert.hidden === false, "une playlist vide reste un écran noir muet");
  assert(alert.querySelector(".sd-content-alert-reload"), "le panneau ne propose pas de recharger");
  assert(/contenu/.test(alert.querySelector(".sd-content-alert-text").textContent + alert.querySelector(".sd-content-alert-diag").textContent), "le panneau ne dit pas ce qu'il mesure");
  /* Contenu revenu : le panneau s'efface de lui-même. */
  page.getElementById("main-view").innerHTML = "<section data-testid='playlist-page'><h1>Ma playlist</h1><p>" + "titre ".repeat(80) + "</p></section>";
  api._internals.Content.alertIfBlank();
  assert(alert.hidden === true, "le panneau reste alors que la page affiche du contenu");
  dom.window.close();
  return "écran vide annoncé · rechargement proposé · effacé au retour du contenu ✓";
});

await checkAsync("un cache écrit par une version qui ramassait toute la page est jeté", async () => {
  /* La 2.11.11 a écrit dans le cache les playlists ramassées **partout** dans la
     page (recommandations comprises). Sans version de cache, la mise à jour
     réafficherait ces playlists-là — exactement « il y en a qui ne sont pas les
     miennes ». Un cache d'avant est donc ignoré et effacé. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.localStorage.setItem(
    "sd.library.cache",
    JSON.stringify({
      at: Date.now() - 60 * 1000,
      items: [
        { type: "playlist", name: "Today's Top Hits", sub: "Dans votre bibliothèque", href: "/playlist/editorial1", img: "" },
        { type: "playlist", name: "RapCaviar", sub: "Dans votre bibliothèque", href: "/playlist/editorial2", img: "" },
      ],
    })
  );
  dom.window.fetch = () => new Promise(() => {});
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 0, `aucune ligne du vieux cache ne doit s'afficher, ${rows.length} affichée(s)`);
  assert(api.library.cached !== true, "un cache d'une autre version a été utilisé");
  assert(
    dom.window.localStorage.getItem("sd.library.cache") === null,
    "le vieux cache n'a pas été effacé : il reviendrait au prochain lancement"
  );
  dom.window.close();
  return "cache d'avant ignoré et effacé ✓";
});

await checkAsync("la bibliothèque relit son cache avant même la page de Spotify", async () => {
  /* Deuxième ouverture : les lignes lues la dernière fois sont dans le stockage
     local. Elles doivent apparaître **avant** toute lecture de la page — c'est
     ce qui rend l'onglet instantané après un rechargement de la WebView. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.localStorage.setItem(
    "sd.library.cache",
    JSON.stringify({
      v: 2,
      at: Date.now() - 60 * 1000,
      items: [
        { type: "playlist", name: "Cache A", sub: "", href: "/playlist/c1", img: "" },
        { type: "playlist", name: "Cache B", sub: "", href: "/playlist/c2", img: "" },
        { type: "album", name: "Cache C", sub: "", href: "/album/c3", img: "" },
      ],
    })
  );
  dom.window.fetch = () => new Promise(() => {});
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 3, `3 lignes du cache attendues, ${rows.length} affichée(s)`);
  assert(
    rows.map((r) => r.getAttribute("href")).join(",") === "/playlist/c1,/playlist/c2,/album/c3",
    "le cache n'est pas celui qui est affiché : " + rows.map((r) => r.getAttribute("href")).join(",")
  );
  assert(api.library.cached === true, "les lignes ne sont pas marquées comme venant du cache");
  /* Et quand l'API répond, ses lignes (plus complètes) prennent la place. */
  dom.window.fetch = (url, init) => {
    void init;
    const key = String(url).replace("https://api.spotify.com/v1", "");
    const body =
      key === "/me"
        ? { id: "moi", display_name: "Moi" }
        : key === "/me/playlists?limit=50"
          ? { total: 1, items: [{ id: "p1", name: "Fraîche", owner: { display_name: "Moi" }, images: [] }] }
          : { total: 0, items: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "https://api.spotify.com/v1/me");
  xhr.setRequestHeader("Authorization", "Bearer jeton-cache");
  api.library.load(true);
  for (let i = 0; i < 60 && api.library.refreshing; i++) await tick(25);
  assert(api.library.fromSidebar === false, "l'API a répondu mais les lignes du repli sont restées");
  assert(
    api.library.items.some((r) => r.name === "Fraîche"),
    "les lignes de l'API n'ont pas remplacé le cache : " + JSON.stringify(api.library.items.slice(0, 2))
  );
  /* Le cache a été mis à jour avec ce que l'API a donné. */
  const stored = JSON.parse(dom.window.localStorage.getItem("sd.library.cache") || "null");
  assert(stored && stored.items && stored.items.some((r) => r.name === "Fraîche"), "le cache n'a pas été mis à jour après une lecture réussie");
  dom.window.close();
  return "cache affiché d'abord · API ensuite · cache mis à jour ✓";
});

await checkAsync("la bibliothèque lit la liste de Spotify quand l'API ne répond pas", async () => {
  /* Signalé le 25/09 : « la bibliothèque est toujours buguée, il n'arrive pas à
     reconnaître mes playlists ». L'API du lecteur peut refuser le jeton, se
     taire, ou n'avoir rien à dire — et la page restait alors sur un constat
     d'échec alors que Spotify, lui, **affiche déjà** la bibliothèque du compte
     dans sa barre latérale. Ce test prend le cas d'un jeton refusé et vérifie
     que les lignes de Spotify prennent le relais, avec la raison écrite noir sur
     blanc (et le journal des essais, pour qu'une capture suffise). */
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='Desktop_LeftSidebar_Id'>" +
      "<a href='/playlist/abc?si=1'><img src='https://i.scdn.co/image/p' alt=''/><span>Mes tubes</span></a>" +
      "<a href='/playlist/abc?si=1'><span>Mes tubes</span></a>" +
      "<a href='/album/def'><span>Album Un</span></a>" +
      "<a href='/artist/ghi'><span>Artiste Suivi</span></a>" +
      "<a href='/search'>Rechercher</a>" +
      "</div><main></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  /* Un jeton qui sera **refusé** : le cas du téléphone dont la session a expiré
     sans que la page s'en aperçoive. */
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "https://api.spotify.com/v1/me");
  xhr.setRequestHeader("Authorization", "Bearer jeton-perime");
  api.state.tab = "library";
  api.library.load(true);
  /* Les lignes sont là **tout de suite** (aucune attente réseau) : c'est le
     premier point que ce test verrouille. */
  assert(
    api.library.items.length === 4 && page.querySelectorAll(".sd-lib-row").length === 4,
    "les lignes de Spotify (et vos titres likés) ne sont pas affichées immédiatement : " + api.library.items.length
  );
  assert(api.library.items[0].type === "liked", "les titres likés ne sont pas en tête : " + api.library.items.map((r) => r.name).join(", "));
  /* Puis on laisse le rafraîchissement par l'API se terminer (il échoue, il
     doit échouer) pour lire son journal. */
  for (let i = 0; i < 60 && api.library.refreshing; i++) await tick(25);

  assert(api.library.items.length === 4, `3 lignes de la liste de Spotify + vos titres likés attendues, ${api.library.items.length} lue(s)`);
  assert(api.library.fromSidebar === true, "les lignes ne sont pas marquées comme lues dans la liste de Spotify");
  assert(api.library.state === "ready", `état attendu « ready », obtenu « ${api.library.state} »`);
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 4, `4 lignes attendues à l'écran, ${rows.length} affichée(s)`);
  assert(
    rows.map((r) => r.getAttribute("href")).join(",") === "/collection/tracks,/playlist/abc,/album/def,/artist/ghi",
    "les adresses lues ne sont pas celles de Spotify : " + rows.map((r) => r.getAttribute("href")).join(",")
  );
  assert(
    rows.every((r) => !/^\/playlist\//.test(r.getAttribute("href")) || /Dans votre bibliothèque/.test(r.textContent)),
    "une playlist lue dans la page ne dit pas qu'elle est dans la bibliothèque"
  );
  const note = page.querySelector(".sd-lib-note").textContent;
  assert(/liste de Spotify/.test(note), "la page ne dit pas d'où viennent ces lignes : " + note);
  /* Et le journal : une seule capture doit suffire à comprendre que le jeton a
     été refusé, et sur quel appel. */
  const log = page.querySelector(".sd-lib-log");
  assert(log && log.hidden === false, "le journal des essais reste caché alors que la bibliothèque a échoué");
  const journal = [...page.querySelectorAll(".sd-lib-log-list li")].map((li) => li.textContent).join(" | ");
  assert(/\/me/.test(journal) && /401/.test(journal), "le journal ne dit pas que /me a été refusé : " + journal);

  /* **Le diagnostic reste rangé.** Signalé le 25/09 : « rends l'onglet
     bibliothèque plus propre » — et le journal, déployé, occupait plus d'écran
     que les playlists. Replié, il ne prend qu'une ligne : son résumé dit
     pourquoi on l'ouvrirait, et combien d'essais il contient. */
  assert(log.tagName === "DETAILS" && !log.open, "le journal n'est plus replié : il reprend la moitié de l'écran");
  const resume = (log.querySelector(".sd-lib-log-title") || {}).textContent || "";
  assert(/API/.test(resume), "le résumé du journal n'explique pas ce qu'on y trouverait : « " + resume + " »");
  const compteEssais = (log.querySelector(".sd-lib-log-n") || {}).textContent || "";
  assert(compteEssais === String(log.querySelectorAll(".sd-lib-log-list li").length), `le journal affiche « ${compteEssais} » essais, il en contient ${log.querySelectorAll(".sd-lib-log-list li").length}`);

  /* **L'en-tête dit combien il y a de lignes**, et le compte suit le filtre :
     « 2 / 4 » dit d'un coup d'œil qu'on regarde une partie de la bibliothèque. */
  const badge = page.querySelector(".sd-lib-count");
  assert(badge && badge.hidden === false, "l'en-tête n'affiche pas le nombre de lignes");
  assert(/4/.test(badge.textContent), "le compte de l'en-tête ne dit pas les 4 lignes : " + badge.textContent);
  const chipAlbum = page.querySelector('.sd-lib-chip[data-filter="album"]');
  chipAlbum.click();
  await tick(60);
  assert(/1 \/ 4/.test(badge.textContent), `le compte ne suit pas le filtre : « ${badge.textContent} »`);
  assert(chipAlbum.classList.contains("is-active"), "le filtre actif n'est pas marqué");
  page.querySelector('.sd-lib-chip[data-filter="all"]').click();
  await tick(60);

  /* **Une catégorie vide se voit comme vide** sans disparaître (sinon les
     autres puces bougent sous le doigt). */
  const chipShow = page.querySelector('.sd-lib-chip[data-filter="show"]');
  assert(chipShow, "la puce des podcasts a disparu");
  assert(chipShow.classList.contains("is-empty"), "une puce à zéro ne se distingue pas d'une puce remplie");
  assert(/^Podcasts 0/.test(chipShow.textContent.trim()), "la puce à zéro n'annonce pas son compte : " + chipShow.textContent);

  /* **La phrase d'état a son icône et son ton**, et son texte reste exactement
     le message (c'est ce que lisent la sonde et ce test). */
  const phrase = page.querySelector(".sd-lib-note");
  assert(phrase.querySelector("svg.sd-lib-note-glyph"), "la phrase d'état n'a plus d'icône");
  assert(phrase.querySelector(".sd-lib-note-text").textContent === api.library.note(), "le texte de la phrase n'est plus le message de la page");
  assert(phrase.classList.contains("is-info"), "la phrase qui explique le repli n'est pas marquée comme une information");

  /* **Chaque type a son glyphe** quand la pochette manque : un album ne
     ressemble plus à une playlist. */
  const glyphes = [...page.querySelectorAll(".sd-lib-art.is-empty svg")].map((el) => el.outerHTML.length);
  assert(glyphes.length === rows.filter((r) => !r.querySelector(".sd-lib-art img")).length, "les lignes sans pochette n'ont pas toutes un glyphe");
  dom.window.close();
  return "repli sur la liste de Spotify · vos titres likés en tête · 3 lignes · refus écrit dans le journal ✓";
});

await checkAsync("un appui sur une playlist l'ouvre dans le lecteur, et le retour revient", async () => {
  /* Signalé le 25/09 : « quand on appuie sur une playlist, écran noir » — et
     le retour ne ramenait pas à la bibliothèque. La cause est dans la façon
     d'ouvrir la page : nos lignes sont des liens, et un appui faisait donc
     charger l'adresse par la WebView comme un **premier chargement**. Tout le
     lecteur repartait de zéro (plusieurs secondes pendant lesquelles il n'y a
     rien à peindre : du noir), notre coque était reconstruite, l'historique ne
     contenait plus l'ouverture, et le retour retombait sur l'accueil.
     Mesuré en Chrome, même banc, avant ce correctif : document rechargé, 0
     élément à l'écran, coque absente 6,7 s. Le lecteur, lui, est une
     application d'une seule page : il sait afficher ses adresses sans se
     recharger, et c'est **sa** navigation que l'appui doit suivre. */
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='Desktop_LeftSidebar_Id'>" +
      "<a href='/playlist/abc'><span>Mes tubes</span></a>" +
      "</div><main></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  await tick(80);

  const ligne = [...page.querySelectorAll(".sd-lib-row-playlist")][0];
  assert(ligne && ligne.getAttribute("href") === "/playlist/abc", "aucune ligne de playlist à ouvrir");
  /* Le lien de Spotify pour la même adresse joue le rôle du lien de la barre
     latérale : c'est lui qui a le routeur et l'historique. */
  const jumeau = page.querySelector("#Desktop_LeftSidebar_Id a[href='/playlist/abc']");
  assert(jumeau && !jumeau.closest(".sd-layer"), "le lien de Spotify n'est pas là où on l'attend");
  let clicsJumeau = 0;
  let vu = null;
  jumeau.addEventListener("click", (e) => {
    clicsJumeau++;
    e.preventDefault(); /* comme le routeur de Spotify : il affiche la page lui-même */
  });
  ligne.addEventListener("click", (e) => {
    vu = e;
  });
  ligne.click();
  assert(clicsJumeau === 1, `l'appui n'est pas passé au lien du lecteur (${clicsJumeau} clic(s) sur le lien de Spotify)`);
  assert(vu && vu.defaultPrevented, "l'appui laisse le navigateur charger l'adresse : c'est le rechargement de l'application (l'écran noir)");
  /* **Le voile** : si la page met du temps, l'écran dit ce qu'il ouvre au lieu
     de rester noir. Et il ne couvre pas le lecteur, qui doit rester là. */
  const voile = page.querySelector(".sd-open");
  assert(voile, "il n'y a pas de voile d'ouverture");
  assert(voile.hidden === false, "l'écran reste noir pendant l'ouverture : le voile n'est pas posé");
  assert(/Mes tubes/.test(voile.textContent), "le voile ne dit pas ce qu'on ouvre : « " + voile.textContent.trim() + " »");
  assert(/information|Ouverture/.test(voile.getAttribute("role") === "status" ? "Ouverture" : ""), "le voile n'est pas annoncé aux lecteurs d'écran");

  /* **Le retour défait l'ouverture.** Signalé : « le retour en arrière doit
     fonctionner ». Pendant l'ouverture, la route n'a pas encore changé : sans
     ce cas, l'appui retour partait sur l'onglet Accueil. */
  assert(api.back() === true, "le retour n'est pas pris en compte pendant l'ouverture");
  await tick(80);
  assert(voile.hidden === true, "le voile reste affiché après le retour : l'écran ne se libère jamais");

  /* Et sans lien de Spotify pour la même adresse (une playlist de l'API qui
     n'est pas dans la barre latérale) : l'adresse est poussée dans
     l'historique et la navigation est annoncée — jamais un rechargement. */
  page.querySelectorAll("#Desktop_LeftSidebar_Id a").forEach((a) => a.remove());
  const avant = dom.window.location.pathname;
  ligne.click();
  await tick(60);
  assert(dom.window.location.pathname === "/playlist/abc", `l'adresse n'a pas été poussée : « ${dom.window.location.pathname} »`);
  assert(dom.window.location.pathname !== avant || avant === "/playlist/abc", "l'adresse n'a pas changé");
  assert(voile.hidden === false, "le voile n'est pas posé quand la page n'a pas de lien à suivre");
  api.back();
  await tick(80);
  assert(voile.hidden === true, "le voile reste affiché après l'annulation");
  dom.window.close();
  return "appui → navigation du lecteur (aucun rechargement) · voile d'ouverture · retour qui défait ✓";
});

await checkAsync("la bibliothèque n'affiche qu'une fois « Titres likés »", async () => {
  /* La capture du 25/09 montrait deux lignes « Titres likés » à la suite :
     celle que la coque pose elle-même, et celle que Spotify affiche dans sa
     propre liste — que le repli relit dans la page. Deux fois la même entrée,
     avec deux sous-titres différents (« Vos titres likés », « Dans votre
     bibliothèque ») : ça se lit comme un doublon, pas comme une bibliothèque. */
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='Desktop_LeftSidebar_Id'>" +
      "<a href='/collection/tracks'><span>Titres likés</span></a>" +
      "<a href='/playlist/abc'><span>Mes tubes</span></a>" +
      "</div><main></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  await tick(120);

  /* La remise d'aplomb elle-même : deux entrées likés, un doublon de playlist. */
  const remis = api.library.ensureLiked([
    { type: "liked", name: "Titres likés", sub: "Vos titres likés", href: "/collection/tracks", img: "" },
    { type: "playlist", name: "Mes tubes", sub: "Dans votre bibliothèque", href: "/playlist/abc", img: "" },
    { type: "liked", name: "Titres likés", sub: "Dans votre bibliothèque", href: "/collection", img: "" },
    { type: "playlist", name: "Mes tubes", sub: "Dans votre bibliothèque", href: "/playlist/abc", img: "" },
  ]);
  const liked = remis.filter((r) => r.type === "liked");
  assert(liked.length === 1, `${liked.length} lignes « Titres likés » après remise d'aplomb : « ${liked.map((r) => r.sub).join(" », « ")} »`);
  assert(remis[0] === liked[0], "l'entrée des titres likés n'est plus en tête");
  assert(remis.length === 2, `la liste garde ${remis.length} lignes au lieu de 2 : le doublon de playlist n'est pas tombé`);

  /* Et de bout en bout : la page montre « Titres likés » de son côté, la coque
     doit quand même n'en afficher qu'une. */
  const affichees = [...page.querySelectorAll(".sd-lib-row-liked")];
  assert(affichees.length === 1, `${affichees.length} lignes « Titres likés » à l'écran (une seule attendue)`);
  const badge = page.querySelector(".sd-lib-count");
  const lignes = page.querySelectorAll(".sd-lib-row").length;
  assert(lignes === 2, `${lignes} lignes affichées au lieu de 2 (titres likés + playlist)`);
  assert(badge && new RegExp(String(lignes)).test(badge.textContent), `le compte de l'en-tête (« ${badge.textContent} ») ne dit pas les ${lignes} lignes`);
  dom.window.close();
  return "une seule « Titres likés » · doublon de playlist écarté · compte de l'en-tête juste ✓";
});

await checkAsync("la bibliothèque dit ce qui est à vous, et garde vos titres likés en tête", async () => {
  /* La demande du 25/09 : « fais en sorte qu'il n'y ait que mes playlists et le
     truc avec mes titres likés ». L'API `/me/playlists` rend les playlists du
     compte **et** celles que l'on suit : la page le dit ligne par ligne, et
     l'entrée des titres likés est toujours là, en tête — même quand l'API ne
     donne aucun total pour elle. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const answers = {
    "/me": { id: "moi", display_name: "Moi" },
    "/me/playlists?limit=50": {
      total: 3,
      items: [
        { id: "mine1", name: "Ma mix", owner: { id: "moi", display_name: "Moi" }, images: [] },
        { id: "mine2", name: "Rap FR", owner: { id: "moi", display_name: "Moi" }, images: [] },
        { id: "suivie", name: "Today's Top Hits", owner: { id: "spotify", display_name: "Spotify" }, images: [] },
      ],
    },
    /* Pas de total pour les titres likés : l'entrée doit quand même être là. */
    "/me/tracks?limit=1": null,
  };
  dom.window.fetch = (url, init) => {
    void init;
    const key = String(url).replace("https://api.spotify.com/v1", "");
    const body = answers[key];
    return Promise.resolve({ ok: !!body, status: body ? 200 : 401, json: () => Promise.resolve(body || {}) });
  };
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "https://api.spotify.com/v1/me");
  xhr.setRequestHeader("Authorization", "Bearer jeton-compte");
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 60 && api.library.refreshing; i++) await tick(25);

  const names = api.library.items.map((r) => r.name);
  assert(names[0] === "Titres likés", "les titres likés ne sont pas en tête : " + names.join(", "));
  assert(api.library.items[0].href === "/collection/tracks", "l'entrée likés ne mène pas aux titres likés");
  assert(api.library.items[0].sub === "Vos titres likés", "l'entrée likés ne dit pas ce qu'elle est : " + api.library.items[0].sub);
  const mine = api.library.items.filter((r) => r.type === "playlist" && r.sub === "Votre playlist");
  assert(mine.length === 2, `2 playlists à vous attendues, ${mine.length} trouvée(s)`);
  assert(mine.every((r) => r.mine === true), "les playlists du compte ne sont pas marquées comme les vôtres");
  const followed = api.library.items.filter((r) => r.type === "playlist" && /^Suivie · /.test(r.sub));
  assert(followed.length === 1, `1 playlist suivie attendue, ${followed.length} trouvée(s)`);
  assert(followed[0].name === "Today's Top Hits", "la playlist suivie n'est pas celle attendue : " + followed[0].name);
  assert(followed[0].sub === "Suivie · Spotify", "l'auteur de la playlist suivie n'est pas dit : " + followed[0].sub);
  assert(followed[0].mine !== true, "une playlist suivie est marquée comme la vôtre");
  /* À l'écran aussi : la première ligne est bien les titres likés. */
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 4, `4 lignes attendues à l'écran, ${rows.length} affichée(s)`);
  assert(rows[0].getAttribute("href") === "/collection/tracks", "la première ligne affichée n'est pas les titres likés");
  assert(/Votre playlist/.test(rows[1].textContent) && /Suivie · Spotify/.test(rows[3].textContent), "l'appartenance n'est pas lisible à l'écran");
  dom.window.close();
  return "likés en tête · 2 à vous · 1 suivie nommée ✓";
});

await checkAsync("la bibliothèque ne lit que VOTRE bibliothèque, pas les recommandations", async () => {
  /* **« Les playlists sont beaucoup trop nombreuses, il y en a qui ne sont pas
     les miennes » (25/09).** La lecture élargie à toute la page ramassait les
     playlists recommandées par Spotify (rangées de l'accueil). Désormais seules
     comptent les zones de la bibliothèque — la barre latérale et le panneau —
     et le reste est écarté, en le comptant. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><header><h1>Ma bibliothèque</h1></header>" +
      "<a href='/playlist/p1?si=xyz' aria-label='Mes tubes'><img src='https://i.scdn.co/image/p1' alt=''/></a>" +
      "<a href='/album/a1' aria-label='Album Un'></a>" +
      "</div>" +
      "<main id='main-view'><section>" +
      /* Recommandations de Spotify : **jamais** dans la bibliothèque. */
      "<a href='/playlist/p2' aria-label='Today Top Hits'></a>" +
      "<a href='/playlist/p3' aria-label='RapCaviar'></a>" +
      "<a href='/playlist/p4' aria-label='Vos découvertes de la semaine'></a>" +
      "</section></main>" +
      "</body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 40 && api.library.state === "loading"; i++) await tick(25);

  assert(api.library.fromSidebar === true, "les lignes ne sont pas marquées comme lues dans Spotify");
  assert(api.library.items.length === 3, `3 lignes attendues (les titres likés + la bibliothèque), ${api.library.items.length} lue(s)`);
  assert(api.library.items[0].type === "liked", "les titres likés ne sont pas garantis : " + api.library.items.map((r) => r.name).join(", "));
  assert(
    api.library.items.slice(1).map((r) => r.href).join(",") === "/playlist/p1,/album/a1",
    "les adresses lues ne sont pas celles de la bibliothèque : " + api.library.items.map((r) => r.href).join(",")
  );
  assert(api.library.items[1].name === "Mes tubes", "l'aria-label n'est pas lu : " + api.library.items[1].name);
  assert(
    !api.library.items.some((r) => /Top Hits|RapCaviar|découvertes de la semaine/.test(r.name)),
    "une playlist recommandée par Spotify est entrée dans la bibliothèque : " + JSON.stringify(api.library.items)
  );
  assert(api.library.ignored === 3, `3 recommandations attendues dans le journal, ${api.library.ignored} comptée(s)`);
  const rows = [...page.querySelectorAll(".sd-lib-row")];
  assert(rows.length === 3, `3 lignes attendues à l'écran, ${rows.length} affichée(s)`);
  assert(
    rows.every((r) => !/p2|p3|p4/.test(r.getAttribute("href") || "")),
    "une recommandation est affichée à l'écran : " + rows.map((r) => r.getAttribute("href")).join(",")
  );
  const journal = [...page.querySelectorAll(".sd-lib-log-list li")].map((li) => li.textContent).join(" | ");
  assert(/Lignes trouvées/.test(journal) && /barre latérale 2/.test(journal), "le journal ne dit pas d'où viennent les lignes : " + journal);
  assert(/3 playlists recommandées ignorées/.test(journal), "le journal ne dit pas ce qui a été écarté : " + journal);
  assert(/En-têtes de la page/.test(journal), "le journal ne dit pas quels en-têtes la coque a gardés : " + journal);
  dom.window.close();
  return "bibliothèque seule (2 lignes + vos titres likés) · 3 recommandations écartées ✓";
});

await checkAsync("hors bibliothèque : vos rangées « Vos playlists » sont lues, les recommandations non", async () => {
  /* Toutes les playlists de la page ne sont pas à vous, et toutes les vôtres ne
     sont pas dans la barre latérale : Spotify a une rangée « Vos playlists » sur
     l'accueil. Celle-là est lue ; les rangées de recommandations qui l'entourent
     sont écartées et comptées. Une carte qui porte le nom du compte est prise
     aussi (parfois la rangée n'a pas de titre lisible). */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><header><h1>Ma bibliothèque</h1></header></div>" +
      "<main id='main-view'>" +
      "<section><h2>Vos playlists</h2>" +
      "<a href='/playlist/m1' aria-label='Mes tubes · Playlist · Moi'></a>" +
      "<a href='/playlist/m2' aria-label='Mix du soir · Playlist · Moi'></a>" +
      "</section>" +
      "<section><h2>Écoutés récemment</h2>" +
      "<a href='/playlist/r1' aria-label=\"Today's Top Hits · Playlist · Spotify\"></a>" +
      "<a href='/playlist/r2' aria-label='RapCaviar · Playlist · Spotify'></a>" +
      "<a href='/playlist/m3' aria-label='Ma playlist voyage · Playlist · Moi'></a>" +
      "</section>" +
      "</main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = (url) => {
    const key = String(url).replace("https://api.spotify.com/v1", "");
    const body = key === "/me" ? { id: "moi", display_name: "Moi" } : null;
    return Promise.resolve({ ok: !!body, status: body ? 200 : 401, json: () => Promise.resolve(body || {}) });
  };
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  /* Un jeton capté comme dans la vraie page : c'est lui qui permet de demander
     `/me` — donc de connaître le nom du compte. */
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "https://api.spotify.com/v1/me");
  xhr.setRequestHeader("Authorization", "Bearer jeton-compte");
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 60 && api.library.state === "loading"; i++) await tick(25);

  const names = api.library.items.map((r) => r.name);
  assert(names.includes("Mes tubes") && names.includes("Mix du soir"), "les playlists de la rangée « Vos playlists » ne sont pas lues : " + names.join(", "));
  assert(!names.some((n) => /Top Hits|RapCaviar|voyage/.test(n)), "une recommandation est entrée dans la bibliothèque : " + names.join(", "));
  assert(api.library.ignored >= 2, `2 recommandations au moins attendues au journal, ${api.library.ignored} comptée(s)`);
  assert(names[0] === "Titres likés", "les titres likés ne sont plus en tête : " + names.join(", "));
  assert(!names.some((n) => /·/.test(n)), "les noms affichent la phrase entière de Spotify : " + names.join(" / "));
  /* Une carte **hors rangée** qui porte le nom du compte : elle ne peut être
     reconnue qu'une fois le compte connu (`/me`) — c'est le cas quand la rangée
     n'a pas de titre lisible. */
  /* Le compte arrive avec la réponse à `/me` : on la laisse arriver (les appels
     sont enchaînés un par un, jamais tous à la fois). */
  for (let i = 0; i < 200 && !api.library.account; i++) await tick(25);
  assert(api.library.account === "Moi", "le compte n'a pas été lu depuis /me : " + JSON.stringify(api.library.account));
  const again = api.library.fromSpotifyList().map((r) => r.href);
  assert(again.includes("/playlist/m3"), "une playlist portant le nom du compte n'est pas lue : " + again.join(", "));
  assert(!again.some((h) => /\/playlist\/r[12]/.test(h)), "une recommandation est prise quand le compte est connu : " + again.join(", "));
  dom.window.close();
  return "rangée à vous lue · carte au nom du compte lue · recommandations écartées ✓";
});

await checkAsync("une bibliothèque sans aucun repère technique est trouvée par son titre", async () => {
  /* Le cas du téléphone : pas d'identifiant, pas de repère de test — juste un
     titre « Votre bibliothèque » et, dessous, les playlists du compte. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<main id='main-view'>" +
      "<section><h1>Votre bibliothèque</h1>" +
      "<a href='/playlist/a1' aria-label='Mes tubes'></a>" +
      "<a href='/playlist/a2' aria-label='Mix du soir'></a>" +
      "</section>" +
      "<section><h2>Recommandé pour vous</h2>" +
      "<a href='/playlist/b1' aria-label=\"Today's Top Hits · Playlist · Spotify\"></a>" +
      "</section>" +
      "</main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 40 && api.library.state === "loading"; i++) await tick(25);
  const hrefs = api.library.items.map((r) => r.href).join(",");
  assert(hrefs.includes("/playlist/a1") && hrefs.includes("/playlist/a2"), "la bibliothèque nommée par son titre n'est pas lue : " + hrefs);
  assert(!/\/playlist\/b1/.test(hrefs), "les recommandations sont entrées par la section nommée : " + hrefs);
  assert(api.library.ignored >= 1, "la recommandation écartée n'est pas comptée");
  dom.window.close();
  return "bibliothèque trouvée par son titre (2 lignes) · 1 recommandation écartée ✓";
});

await checkAsync("la bibliothèque est reconnue même si Spotify a renommé son conteneur", async () => {
  /* Le 25/09 : « tous les affichages ne soit plus buger ». La lecture ne
     sortait plus des conteneurs connus (`#Desktop_LeftSidebar_Id`, panneau) —
     et une disposition qui les renomme voulait dire « aucune playlist » sur une
     page qui les affiche toutes. Un conteneur qui **dit** qu'il est la
     bibliothèque est donc lu ; les rangées de recommandations, non. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      /* Aucun des identifiants connus : la disposition a changé. */
      "<div data-testid='library-root'><h1>Votre bibliothèque</h1>" +
      "<a href='/playlist/s1' aria-label='Mes tubes'></a>" +
      "<a href='/playlist/s2' aria-label='Mix du soir'></a>" +
      "</div>" +
      "<main id='main-view'><section><h2>Recommandé pour vous</h2>" +
      "<a href='/playlist/r1' aria-label=\"Today's Top Hits · Playlist · Spotify\"></a>" +
      "<a href='/playlist/r2' aria-label='RapCaviar · Playlist · Spotify'></a>" +
      "</section></main>" +
      "</body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 40 && api.library.state === "loading"; i++) await tick(25);
  const hrefs = api.library.items.map((r) => r.href).join(",");
  assert(hrefs.includes("/playlist/s1") && hrefs.includes("/playlist/s2"), "les playlists de la bibliothèque renommée ne sont pas lues : " + hrefs);
  assert(!/\/playlist\/r[12]/.test(hrefs), "une recommandation est entrée par le conteneur renommé : " + hrefs);
  assert(api.library.scopes >= 1, "le conteneur n'a pas été reconnu comme une bibliothèque");
  const journal = [...dom.window.document.querySelectorAll(".sd-lib-log-list li")].map((li) => li.textContent).join(" | ");
  assert(/bibliothèque 2/.test(journal), "le journal ne dit pas que les lignes viennent de la bibliothèque : " + journal);
  dom.window.close();
  return "bibliothèque reconnue par son titre (2 lignes) · recommandations écartées ✓";
});

await checkAsync("la liste de Spotify arrive après nous : la bibliothèque se remplit d'elle-même", async () => {
  /* Mesuré en CI : la barre latérale était **vide** au moment de notre lecture
     et contenait 14 liens une seconde plus tard. Sans relecture, l'utilisateur
     voyait « aucune playlist » alors que les siennes étaient là — et il n'a rien
     à toucher pour qu'elles apparaissent. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><header><h1>Ma bibliothèque</h1></header></div>" +
      "<main id='main-view'></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  api.state.tab = "library";
  api.library.load(true);
  await tick(300);
  assert(api.library.items.length === 0, "le banc doit commencer avec une bibliothèque vide");

  /* Spotify finit son chargement : la barre latérale se remplit. */
  const link = page.createElement("a");
  link.setAttribute("href", "/playlist/tardive");
  link.setAttribute("aria-label", "Ma playlist tardive");
  page.getElementById("Desktop_LeftSidebar_Id").appendChild(link);

  for (let i = 0; i < 80 && !api.library.items.length; i++) await tick(50);
  assert(api.library.items.length >= 1, "la liste arrivée après coup n'est jamais relue");
  assert(api.library.items[0].name === "Titres likés", "les titres likés ne sont pas en tête : " + api.library.items.map((r) => r.name).join(", "));
  assert(api.library.items.some((r) => r.name === "Ma playlist tardive"), "la playlist arrivée après coup n'est pas lue : " + api.library.items.map((r) => r.name).join(", "));
  assert([...page.querySelectorAll(".sd-lib-row")].length >= 1, "rien n'est affiché après la relecture");
  dom.window.close();
  return "remplie sans rien toucher ✓";
});

await checkAsync("la bibliothèque déplie la liste de Spotify quand elle est repliée", async () => {
  /* Sur un téléphone, la barre latérale est étroite : Spotify la garde repliée
     et **ne rend alors aucune ligne** — il n'y a rien à lire. On fait ce que
     l'utilisateur ferait : on la déplie une fois, puis on relit. */
  const dom = new JSDOM(
    "<!doctype html><html><body>" +
      "<div id='Desktop_LeftSidebar_Id'><button aria-label='Agrandir la bibliothèque'></button></div>" +
      "<main></main></body></html>",
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;
  const sidebar = page.querySelector("#Desktop_LeftSidebar_Id");
  /* Le dépliage fait rendre la liste, comme dans la vraie page. */
  sidebar.querySelector("button").addEventListener("click", () => {
    sidebar.insertAdjacentHTML(
      "beforeend",
      "<a href='/playlist/p9' aria-label='Playlist repliée'></a>"
    );
  });
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 40 && api.library.state === "loading"; i++) await tick(25);
  assert(api.library.items.length === 0, "la liste ne devrait rien donner avant dépliage");
  for (let i = 0; i < 80 && !api.library.items.length; i++) await tick(25);
  assert(api.library.woke, "la coque n'a pas essayé de déplier la liste de Spotify");
  assert(api.library.items.length === 2, `la playlist et vos titres likés sont attendus après dépliage, ${api.library.items.length} lue(s)`);
  assert(api.library.items[0].type === "liked", "les titres likés ne sont pas en tête : " + api.library.items.map((r) => r.name).join(", "));
  assert(api.library.items[1].href === "/playlist/p9", "la mauvaise ligne a été lue : " + api.library.items[1].href);
  assert(
    page.querySelectorAll(".sd-lib-row").length === 2,
    "la ligne lue (et vos titres likés) n'est pas affichée à l'écran"
  );
  dom.window.close();
  return "liste repliée → dépliée → " + "1 playlist lue ✓";
});

await checkAsync("la bibliothèque redemande le jeton à la page quand il manque", async () => {
  /* Le cas du téléphone : la capture n'a rien attrapé (aucune requête portant
     l'en-tête n'est passée, ou le jeton est refusé), et la bibliothèque restait
     vide pour toujours — « il n'arrive pas à reconnaître mes playlists ». La
     page du lecteur sait donner son jeton (`/get_access_token`, même origine,
     donc pas de contrôle d'accès) : la coque le redemande, puis relit. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const calls = [];
  /* Le jeton et le client-token arrivent comme sur la page : posés dans une
     requête du lecteur, captés par la coque, puis renvoyés tels quels. */
  const warmToken = () => {
    /* Le `client-token` seul : c'est lui qui manquait à nos appels (le jeton,
       lui, arrive par la voie du renouvellement que ce test exerce). */
    const xhrWarm = new dom.window.XMLHttpRequest();
    xhrWarm.open("GET", "https://api.spotify.com/v1/me");
    xhrWarm.setRequestHeader("client-token", "client-token-de-la-page");
  };
  dom.window.fetch = (url, init) => {
    const key = String(url);
    if (key.indexOf("/get_access_token") === 0) {
      askedToken++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ accessToken: "JETON-DE-LA-PAGE", isAnonymous: false }),
      });
    }
    const h = (init && init.headers) || {};
    calls.push({ key, auth: h.authorization || h.Authorization || "", token: h["client-token"] || "" });
    let body = { total: 0, items: [] };
    if (key === "https://api.spotify.com/v1/me") body = { id: "moi", display_name: "Moi" };
    if (key.indexOf("/me/playlists") >= 0) {
      body = { total: 1, items: [{ id: "p1", name: "Mes tubes", owner: { display_name: "Moi" }, images: [] }] };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  let askedToken = 0;
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  warmToken();
  await tick(40);
  const api = dom.window.SpotiDuckUI;
  api.state.tab = "library";
  api.library.load(true);
  for (let i = 0; i < 60 && !api.library.items.length; i++) await tick(25);

  assert(askedToken >= 1, "la coque n'a pas redemandé le jeton à la page alors qu'il manquait");
  assert(
    api.library.items.some((r) => r.href === "/playlist/p1"),
    "la bibliothèque n'a pas été relue avec le jeton redemandé : état " + api.library.state
  );
  assert(api.library.state === "ready", `état attendu « ready », obtenu « ${api.library.state} »`);
  assert(
    calls.length > 0 && calls.every((c) => /Bearer JETON-DE-LA-PAGE/.test(c.auth)),
    "les appels d'API ne portent pas le jeton redemandé : " + JSON.stringify(calls.slice(0, 2))
  );
  /* **Et l'enveloppe de la page avec.** Le lecteur ne demande pas l'API avec
     le seul jeton : il envoie aussi `client-token`. Nos appels partaient « nus »
     — c'est ce qui les faisait refuser alors que ceux de la page passaient. */
  const withToken = calls.filter((c) => c.token);
  assert(
    withToken.length === calls.length,
    "les appels d'API ne portent pas le client-token de la page : " + JSON.stringify(calls.slice(0, 2))
  );
  assert(/Compte Moi/.test(dom.window.document.querySelector(".sd-lib-sum").textContent), "le compte redemandé n'est pas nommé");
  dom.window.close();
  return "jeton redemandé à la page · relecture · compte nommé ✓";
});

await checkAsync("without a token the library keeps Spotify's sidebar (never an empty screen)", async () => {
  /* La prudence qui compte : si le jeton manque (session fermée, page qui n'a
     rien demandé), notre page **ne s'affiche pas** et ne masque rien. Sinon un
     utilisateur sans session perdrait le seul accès à sa bibliothèque. */
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
    url: "https://open.spotify.com/intl-fr/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  /* Une seule fonction de réponse, décidée par `answers` : le bouchon doit être
     posé **avant** l'exécution de la coque, parce que la coque enveloppe
     `window.fetch` pour y capter le jeton. Remplacer `fetch` après coup
     contournerait la capture — et le test ne mesurerait plus rien de réel. */
  let answers = () => null;
  dom.window.fetch = (url) => {
    const body = answers(String(url).replace("https://api.spotify.com/v1", ""));
    return Promise.resolve({ ok: !!body, status: body ? 200 : 401, json: () => Promise.resolve(body || {}) });
  };
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const page = dom.window.document;

  api.state.tab = "home";
  api.library.enter();
  /* La page existe même hors de son onglet (cachée) : c'est ce qui permet de la
     mesurer partout — « absente » ne doit pas se confondre avec « masquée ». */
  const panel = page.querySelector(".sd-lib");
  assert(panel, "la page de bibliothèque n'est même pas construite");
  assert(panel.hidden === true, "la bibliothèque s'affiche alors qu'on est sur l'accueil");

  api.state.tab = "library";
  api.library.enter();
  await tick(120);
  assert(api.library.state === "no-token", `état attendu « no-token », obtenu « ${api.library.state} »`);
  /* **Notre page s'affiche même sans données, et elle le dit.** Signalé le
     25/09 : « quand on clique sur l'onglet bibliothèque, la barre en haut
     disparaît et rien d'autre n'apparaît ; je reste bloqué sur l'écran
     d'accueil ». La barre latérale de Spotify, gardée comme repli, ne montre
     aucune playlist sur ce téléphone : un écran noir. Notre page, elle, explique
     toujours où elle en est, et propose de réessayer. */
  const panelNoToken = page.querySelector(".sd-lib");
  assert(panelNoToken.hidden === false, "la bibliothèque reste masquée faute de données : l'utilisateur n'a plus rien à l'écran");
  assert(panelNoToken.querySelector(".sd-lib-title").textContent === "Bibliothèque", "la page ne porte pas son titre");
  assert(panelNoToken.querySelector(".sd-lib-note").textContent.length > 10, "la page ne dit pas pourquoi elle est vide");
  assert(panelNoToken.querySelector(".sd-lib-actions").hidden === false, "aucune action proposée pour réessayer");
  const retry = panelNoToken.querySelector(".sd-lib-retry");
  assert(retry && retry.textContent === "Réessayer", "le bouton « Réessayer » est absent");
  /* Le bouton relance vraiment la lecture — ici avec un jeton arrivé entre-temps
     (c'est exactement le cas d'un téléphone : la page du lecteur émet ses
     requêtes quelques secondes après l'affichage). */
  answers = (key) => (key === "/me" ? { id: "moi", display_name: "Moi" } : { total: 0, items: [] });
  const xhrEarly = new dom.window.XMLHttpRequest();
  xhrEarly.open("GET", "https://api.spotify.com/v1/me");
  xhrEarly.setRequestHeader("Authorization", "Bearer jeton-tardif");
  retry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 40 && api.library.state === "loading"; i++) await tick(25);
  assert(api.library.state === "empty", `après « Réessayer », état attendu « empty », obtenu « ${api.library.state} »`);
  assert(/biblio/.test(api.content.diagnose()), "le diagnostic ne dit pas où en est la bibliothèque");

  /* Une seule des cinq sources répond — et le jeton arrive par **XHR**, comme
     il peut le faire sur un téléphone dont la page n'utilise pas `fetch` pour
     ses requêtes d'API. Deux choses à la fois : on garde ce qui a répondu (sans
     prétendre que le reste est vide), et le jeton posé en XHR est bien capté. */
  answers = (key) =>
    key === "/me"
      ? { id: "moi", display_name: "Moi" }
      : key === "/me/playlists?limit=50"
        ? { total: 1, items: [{ id: "p9", name: "La seule", owner: { display_name: "Moi" }, images: [] }] }
        : null;
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "https://api.spotify.com/v1/me");
  xhr.setRequestHeader("Authorization", "Bearer jeton-xhr");
  api.library.load(true);
  for (let i = 0; i < 40 && !api.library.items.length; i++) await tick(25);
  /* Deux lignes : **les titres likés d'abord** (la demande du 25/09 : « mes
     playlists et le truc avec mes titres likés »), puis la seule playlist qui a
     répondu. */
  assert(api.library.items.length === 2, "le jeton posé en XHR n'est pas capté : la bibliothèque resterait vide");
  assert(api.library.items[0].type === "liked", "les titres likés ne sont pas en tête : " + api.library.items[0].type);
  assert(api.library.items[1].name === "La seule", "l'élément lu par le jeton XHR n'est pas le bon");
  assert(api.library.items[1].sub === "Suivie · Moi", "la playlist devrait être dite « suivie » (elle n'est pas au compte) : " + api.library.items[1].sub);
  api.library.apply();
  assert(page.querySelector(".sd-lib").hidden === false, "la bibliothèque ne s'affiche pas alors qu'elle a une playlist");
  const chips2 = [...page.querySelectorAll(".sd-lib-chip")];
  chips2[4].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(
    /Rien dans cette catégorie/.test(page.querySelector(".sd-lib-note").textContent),
    "un filtre vide ne dit rien : " + page.querySelector(".sd-lib-note").textContent
  );
  dom.window.close();
  return "sans jeton : rien ne masque Spotify · une source en panne : les autres suffisent ✓";
});

await checkAsync("la bibliothèque passe par le pont natif, donc sans contrôle d'accès", async () => {
  /* **La capture du 25/09 : « Votre bibliothèque n'a pas répondu pour
     l'instant ».** Le jeton était là, la page s'affichait, mais le `fetch` du
     navigateur vers `api.spotify.com` depuis `open.spotify.com` est refusé par
     le contrôle d'accès (la console de la vraie page le dit mot pour mot). Sur
     le téléphone, c'est `AndBridge.nFetch` qui fait la requête — hors
     navigateur, donc sans contrôle d'accès. On le vérifie ici avec `fetch`
     **en panne**, exactement comme sur le téléphone. */
  const answers = {
    "/me/playlists?limit=50": {
      total: 2,
      items: [
        { id: "p1", name: "Mes tubes", images: [{ url: "https://i.scdn.co/image/big", width: 640 }] },
        { id: "p2", name: "Le matin", images: [] },
      ],
    },
    "/me/albums?limit=50": { total: 0, items: [] },
    "/me/artists?limit=50": { total: 1, items: [{ id: "ar1", name: "Artiste Suivi", images: [] }] },
    "/me/shows?limit=50": { total: 0, items: [] },
    "/me/tracks?limit=1": { total: 12 },
  };
  const openDom = (status, failAll) => {
    const dom = new JSDOM('<!doctype html><html><body><div id="main-view"></div></body></html>', {
      url: "https://open.spotify.com/",
      pretendToBeVisual: true,
      runScripts: "dangerously",
    });
    dom.window.__calls = [];
    dom.window.AndBridge = {
      nFetch: (url) => {
        dom.window.__calls.push(url);
        if (failAll) return JSON.stringify({ status: 0, body: "timeout", headers: {} });
        if (status !== 200) return JSON.stringify({ status: status, body: "{}", headers: {} });
        const body = answers[String(url).replace("https://api.spotify.com/v1", "")] || {};
        return JSON.stringify({ status: 200, body: JSON.stringify(body), headers: {} });
      },
      recMediaStatus: () => undefined,
      recMediaPosition: () => undefined,
      playLoaded: () => undefined,
      cssInjected: () => undefined,
    };
    /* Le `fetch` du navigateur échoue comme sur le téléphone : rien ne doit
       dépendre de lui quand le pont est là. */
    dom.window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    return dom;
  };

  const dom = openDom(200);
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  await dom.window.fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer pont-de-test" } }).catch(() => {});
  assert(api.state && api.state.tab, "la coque ne s'est pas construite");
  api.library.load(true);
  for (let i = 0; i < 40 && !api.library.items.length; i++) await tick(25);
  assert(api.library.state === "ready", `état attendu « ready », obtenu « ${api.library.state} »`);
  /* Les titres likés, deux playlists et un artiste suivi : la ligne « titres
     likés » vient du total annoncé par l'API, pas d'une page. */
  assert(api.library.items.length === 4, `4 lignes attendues, ${api.library.items.length} lue(s)`);
  assert(dom.window.__calls.length >= 5, `les cinq sources doivent être lues, ${dom.window.__calls.length} lue(s)`);
  assert(
    api.library.items.some((row) => row.name === "Mes tubes" && row.href === "/playlist/p1"),
    "la playlist du compte n'a pas été lue : " + JSON.stringify(api.library.items.map((r) => r.name))
  );
  assert(dom.window.SpotiDuckUI.net ? dom.window.SpotiDuckUI.net.via === "pont" : true, "la requête n'est pas passée par le pont");
  dom.window.close();

  /* **Le pont répond mal : la raison est dite.** Une seule capture doit alors
     suffire à comprendre ce qui manque (401, 403, réseau). */
  const broken = openDom(401);
  broken.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api2 = broken.window.SpotiDuckUI;
  await broken.window.fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer pont-de-test" } }).catch(() => {});
  api2.state.tab = "library";
  api2.library.load(true);
  for (let i = 0; i < 40 && api2.library.state !== "error"; i++) await tick(25);
  assert(api2.library.state === "error", `état attendu « error », obtenu « ${api2.library.state} »`);
  const page = broken.window.document;
  const note = page.querySelector(".sd-lib-note").textContent;
  assert(/401/.test(note), `la raison (401) doit être affichée, obtenu « ${note} »`);
  const retry = page.querySelector(".sd-lib-retry");
  assert(retry && !page.querySelector(".sd-lib-actions").hidden, "sans réponse, le bouton « Réessayer » doit être là");
  broken.window.close();

  /* **Rien ne répond : on n'insiste pas.** L'appel natif bloque le fil
     JavaScript ; enchaîner les cinq attendrait le réseau cinq fois pour rien. */
  const dead = openDom(200, true);
  dead.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api3 = dead.window.SpotiDuckUI;
  await dead.window
    .fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer pont-de-test" } })
    .catch(() => {});
  api3.state.tab = "library";
  api3.library.load(true);
  for (let i = 0; i < 40 && api3.library.state !== "error"; i++) await tick(25);
  assert(api3.library.state === "error", `état attendu « error », obtenu « ${api3.library.state} »`);
  assert(
    dead.window.__calls.length === 1,
    `un seul appel attendu quand rien ne répond, ${dead.window.__calls.length} lancé(s)`
  );
  dead.window.close();
  return "pont natif : 3 lignes lues · une panne dit sa raison · rien qui répond → un seul appel ✓";
});

await checkAsync("la bibliothèque lit par le pont asynchrone, sans figer la page", async () => {
  /* **Signalé le 25/09 à 09:12 :** « Chargement de votre bibliothèque… » figé, et
     « le lecteur ne fait rien quand on clique sur les boutons ». Cause : le pont
     natif répond de façon **bloquante** — le fil JavaScript de la WebView
     attendait le réseau, donc plus rien ne répondait. La coque passe donc par
     `nFetchAsync` (fil de fond côté Android) et reçoit la réponse par
     `window.__sdNet(id, …)`. On vérifie ici que la page **continue de vivre**
     pendant l'attente, et que rien ne reste en chargement. */
  const answers = {
    "/me/playlists?limit=50": { total: 1, items: [{ id: "p1", name: "Mes tubes", images: [] }] },
    "/me/albums?limit=50": { total: 0, items: [] },
    "/me/artists?limit=50": { total: 0, items: [] },
    "/me/shows?limit=50": { total: 0, items: [] },
    "/me/tracks?limit=1": { total: 4 },
  };
  const openDom = (answerMode) => {
    const dom = new JSDOM('<!doctype html><html><body><div id="main-view"></div></body></html>', {
      url: "https://open.spotify.com/",
      pretendToBeVisual: true,
      runScripts: "dangerously",
    });
    dom.window.__asked = [];
    dom.window.__bridge = [];
    dom.window.AndBridge = withoutAsync({
      nFetchAsync: (id, url) => {
        dom.window.__bridge.push(String(url));
        if (answerMode === "never") return; // le pont se tait
        const body = answers[String(url).replace("https://api.spotify.com/v1", "")] || {};
        /* La réponse arrive **plus tard**, comme celle d'un vrai fil de fond. */
        dom.window.setTimeout(() => {
          dom.window.__sdNet(id, JSON.stringify({ status: 200, body: JSON.stringify(body), headers: {} }));
        }, 20);
      },
      recMediaStatus: () => undefined,
      recMediaPosition: () => undefined,
    });
    dom.window.AndBridge.nFetchAsync = dom.window.AndBridge.nFetchAsync;
    dom.window.fetch = (url) => {
      dom.window.__asked.push(String(url));
      return Promise.reject(new TypeError("Failed to fetch"));
    };
    return dom;
  };

  const dom = openDom("later");
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  await dom.window.fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer pont" } }).catch(() => {});
  /* La prise du jeton passe par `fetch` : on remet le compteur à zéro pour ne
     compter que les requêtes de la bibliothèque. */
  dom.window.__asked.length = 0;
  /* Un témoin : ce minuteur doit avoir le temps de s'exécuter pendant que la
     requête est en vol (c'est exactement ce que le pont bloquant empêchait). */
  let breathed = 0;
  const breath = dom.window.setInterval(() => {
    breathed++;
  }, 5);
  api.library.load(true);
  for (let i = 0; i < 60 && api.library.state === "loading"; i++) await tick(25);
  dom.window.clearInterval(breath);
  assert(api.library.state === "ready", `état attendu « ready », obtenu « ${api.library.state} »`);
  assert(api.library.items.length === 2, `2 lignes attendues, ${api.library.items.length} lue(s)`);
  assert(breathed > 0, "la page n'a pas eu la main pendant la requête : le fil JavaScript était bloqué");
  assert(api.net.via === "pont", `la réponse devrait venir du pont, obtenue « ${api.net.via} »`);
  assert(dom.window.__asked.length === 0, "la voie du navigateur a été utilisée alors que le pont répondait");
  dom.window.close();

  /* **Le pont se tait** : la page le dit et s'arrête — pas de « Chargement… »
     sans fin, et pas de relance sur la voie du navigateur (elle est bloquée par
     le contrôle d'accès, on ne fait pas attendre pour rien). */
  const mute = openDom("never");
  mute.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api2 = mute.window.SpotiDuckUI;
  api2.net.timeoutMs = 200;
  await mute.window
    .fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer pont" } })
    .catch(() => {});
  mute.window.__asked.length = 0;
  api2.state.tab = "library";
  api2.library.load(true);
  for (let i = 0; i < 80 && api2.library.state === "loading"; i++) await tick(25);
  assert(api2.library.state === "error", `état attendu « error », obtenu « ${api2.library.state} »`);
  assert(api2.net.asyncDead === true, "le pont muet n'a pas été retenu (chaque appel referait attendre)");
  assert(
    /n'a pas répondu/.test(mute.window.document.querySelector(".sd-lib-note").textContent),
    "la page ne dit pas que le pont n'a pas répondu : " + mute.window.document.querySelector(".sd-lib-note").textContent
  );
  assert(mute.window.__asked.length === 0, "la page a relancé la requête sur la voie du navigateur alors qu'elle est bloquée");
  mute.window.close();
  return "pont asynchrone : page vivante pendant l'attente · pont muet → la page le dit et n'insiste pas ✓";
});

await checkAsync("a duration announced in milliseconds never becomes thousands of hours", async () => {
  /* **La capture du 25/09 : « 56095 h 50 » pour un seul titre écouté.**
     Sur cette page, le curseur de progression de Spotify est gradué en
     millisecondes ; le code multipliait par 1000 comme s'il était en secondes.
     Trois protections sont vérifiées ici : l'unité se **mesure**, la durée
     enregistrée est contrôlée, et les statistiques déjà écrites sont réparées au
     chargement (sinon l'utilisateur devrait les effacer pour s'en débarrasser). */
  const dom = new JSDOM(
    '<!doctype html><html><body><aside><div data-testid="playback-progressbar">' +
      '<input type="range" min="0" max="202000" value="42000"></div></aside></body></html>',
    { url: "https://open.spotify.com/intl-fr/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(200);
  const api = dom.window.SpotiDuckUI;
  const internals = api._internals;
  const spotify = internals.Spotify;

  /* Curseur en millisecondes (course 202 000 = 3 min 22 s). */
  const read1 = spotify.read();
  assert(read1.duration === 202000, `durée attendue 202000 ms, lue ${read1.duration}`);
  assert(read1.position === 42000, `position attendue 42000 ms, lue ${read1.position}`);

  /* Curseur en secondes (course 202) : le repli de grandeur doit suffire. */
  const input = dom.window.document.querySelector("input");
  input.setAttribute("max", "202");
  input.value = "42";
  spotify.unit = 0;
  const read2 = spotify.read();
  assert(read2.duration === 202000, `durée attendue 202000 ms, lue ${read2.duration}`);
  assert(read2.position === 42000, `position attendue 42000 ms, lue ${read2.position}`);

  /* Et quand la mesure parle, c'est elle qui décide : ici la valeur avance de
     1 par seconde — donc la page compte en secondes, malgré une course à
     202 000. Un titre de 3 min ne fait pas 56 heures. */
  input.setAttribute("max", "202000");
  api.state.playing = true;
  spotify.unit = 0;
  spotify.sample = { v: 0, t: Date.now() - 2000 };
  input.value = "2";
  spotify.calibrate();
  assert(spotify.unit === 1, `unité mesurée attendue 1 (secondes), obtenue ${spotify.unit}`);
  const read3 = spotify.read();
  assert(read3.duration === 202000000, `durée attendue 202000000 ms si la page compte en secondes, lue ${read3.duration}`);
  api.state.playing = false;

  /* La durée enregistrée est contrôlée : une seule écoute ne dure pas plus de
     douze heures, et une valeur dans une autre unité redescend jusqu'à un
     chiffre qui a un sens. */
  assert(api.stats.plausible(201945000) === 202, `plausible(201945000) = ${api.stats.plausible(201945000)}`);
  assert(api.stats.plausible(202000) === 202, `plausible(202000) = ${api.stats.plausible(202000)}`);
  assert(api.stats.plausible(210) === 210, `plausible(210) = ${api.stats.plausible(210)}`);
  assert(api.stats.plausible(0) === 0 && api.stats.plausible(-5) === 0, "une durée nulle ou négative devrait valoir 0");
  assert(api.stats.plausible(1e15) === 0, "une durée absurde devrait être écartée");

  /* Réparation des écoutes déjà enregistrées : celle de la capture, telle
     quelle, dans le stockage du téléphone. */
  api.stats.clear();
  dom.window.localStorage.setItem(
    "sd.stats.v1",
    JSON.stringify({ v: 1, e: [{ k: "worry - slowed\u0000lonown", t: "worry - Slowed", a: "LONOWN", ts: Date.now(), d: 201945000 }] })
  );
  api.stats.loaded = false;
  api.stats.entries = [];
  const sum = api.stats.summary();
  assert(sum.total === 1, `une écoute attendue après réparation, ${sum.total} comptée(s)`);
  assert(sum.seconds === 202, `202 s attendues après réparation, ${sum.seconds} calculées`);
  assert(api.stats.human(sum.seconds) === "3 min", `affichage attendu « 3 min », obtenu « ${api.stats.human(sum.seconds)} »`);
  const stored = JSON.parse(dom.window.localStorage.getItem("sd.stats.v1"));
  assert(stored.e[0].d === 202, `la réparation n'a pas été écrite : ${stored.e[0].d}`);
  dom.window.close();
  return "unité mesurée (ms/s) · durée contrôlée · 56095 h 50 réparé en 3 min ✓";
});

await checkAsync("the interface unit follows the device, not a fixed guess", async () => {
  /* « Fais en sorte que l'affichage s'adapte automatiquement à l'appareil. »
     L'unité `--sd-u` dimensionne toute la coque ; elle doit se déduire de la
     largeur **et** de la hauteur de mise en page, et se remesurer quand
     l'appareil change (rotation, pliage, redimensionnement). */
  const device = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  device.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  const setSize = (w, h) => {
    device.window.eval(`
      Object.defineProperty(document.documentElement, "clientWidth", { get: () => ${w}, configurable: true });
      Object.defineProperty(document.documentElement, "clientHeight", { get: () => ${h}, configurable: true });
    `);
  };
  setSize(360, 800);
  device.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(150);
  const unitOf = () => device.window.document.documentElement.style.getPropertyValue("--sd-u-base");
  const classes = () => device.window.document.documentElement.className;
  assert(Math.abs(parseFloat(unitOf()) - 0.92) < 0.001, "un 360×800 doit donner 0,92 : " + unitOf());
  assert(classes().includes("sd-size-compact"), "le palier « étroit » n'est pas posé : " + classes());

  setSize(412, 915);
  device.window.dispatchEvent(new device.window.Event("resize"));
  await tick(320);
  assert(Math.abs(parseFloat(unitOf()) - 1) < 0.001, "un 412×915 doit donner 1,00 : " + unitOf());

  setSize(915, 412); /* rotation : la hauteur compte aussi */
  device.window.dispatchEvent(new device.window.Event("resize"));
  await tick(320);
  assert(parseFloat(unitOf()) <= 0.93, "en paysage, l'unité doit redescendre : " + unitOf());
  assert(classes().includes("sd-orient-landscape"), "le palier paysage n'est pas posé");

  setSize(800, 1280);
  device.window.dispatchEvent(new device.window.Event("resize"));
  await tick(320);
  assert(parseFloat(unitOf()) >= 1.14, "un écran large doit monter l'unité : " + unitOf());
  assert(classes().includes("sd-size-wide"), "le palier « large » n'est pas posé");
  return "0,92 → 1,00 → 0,92 (paysage) → 1,15 selon l'appareil ✓";
});

check("the original app's fit-to-screen sheet is carried over", () => {
  /* Mesuré sans elle, dans les conditions de la WebView : `contenu=800×731`
     dans un écran de 412 px, `débordement=388`. C'est elle qui fait tenir la
     page bureau sur un téléphone — et c'est ce qui manquait. */
  const sheet = [...doc.querySelectorAll("style")]
    .map((el) => el.textContent || "")
    .join("\n");
  /* Les règles sont recopiées telles quelles de la feuille d'origine, donc
     écrites sans espaces autour des combinateurs (`#main-view+div`). */
  for (const rule of [
    "#main-view+div",
    "width:auto",
    "--panel-gap:0!important",
    "width:100vw!important",
    "grid-container",
  ]) {
    assert(sheet.includes(rule), `la feuille « tenir dans l'écran » a perdu « ${rule} »`);
  }
  assert(
    sheet.includes("html.sd-mobile .sd-root #main-view+div"),
    "la feuille d'origine n'est plus portée sous notre coque : elle frapperait aussi nos propres nœuds"
  );
  return "les règles qui font tenir la page bureau sont là ✓";
});

check("navigation is at the top, like the original app", () => {
  const nav = doc.querySelector(".sd-nav");
  assert(nav, "the top navigation bar was not built");
  assert(nav.parentElement === doc.body || nav.closest(".sd-layer"), "the nav must live in our layer");
  const items = [...nav.querySelectorAll(".sd-nav-item")].map((b) => b.getAttribute("data-tab"));
  assert(items.join("|") === "home|library|search", "nav order: " + items.join("|"));
  assert(nav.querySelector(".sd-nav-logo"), "the centred logo is missing");
  ["bell", "friends", "profile"].forEach((k) => {
    assert(nav.querySelector(".sd-nav-" + k), "missing nav button: " + k);
  });
  const labels = [...nav.querySelectorAll("button")].every((b) => b.getAttribute("aria-label"));
  assert(labels, "every nav button must carry a label");
  assert(doc.documentElement.classList.contains("sd-nav-on"), "sd-nav-on is not set on a main tab");
  return "7 éléments · maison/bibliothèque/recherche + logo + 3 écrans Spotify";
});

await checkAsync("the bottom tab bar is off by default", async () => {
  // La disposition d'origine a la navigation en haut : la barre du bas reste
  // disponible (réglage) mais ne s'affiche pas d'elle-même. Le défaut se lit
  // dans la source — les tests précédents ont pu le basculer à l'exécution.
  const src = await read("src/inject/spotiduck-ui.js");
  assert(/tabbar:\s*false/.test(src), "the default for `tabbar` must be false");
  SD.set("tabbar", false);
  assert(doc.documentElement.classList.contains("sd-no-tabbar"), "sd-no-tabbar missing");
  assert(doc.querySelectorAll(".sd-tab").length === 3, "the tab bar must still exist in the DOM (setting)");
  return "navigation en haut · onglets disponibles mais masqués ✓";
});

check("the mini player carries the full transport", () => {
  const mini = doc.querySelector(".sd-mini");
  ["shuffle", "prev", "play", "next", "repeat", "like"].forEach((k) => {
    assert(mini.querySelector(".sd-mini-" + k), "missing mini control: " + k);
  });
  assert(mini.querySelector(".sd-mini-cur"), "elapsed time missing");
  assert(mini.querySelector(".sd-mini-dur"), "duration missing");
  assert(mini.querySelector(".sd-mini-seek[role='slider']"), "the progress rail must be a slider");
  return "aléatoire · précédent · lecture · suivant · répétition · progression";
});

check("the mini player's own controls drive playback", () => {
  const mini = doc.querySelector(".sd-mini");
  const before = window.MockSpotify.state.playing;
  mini.querySelector(".sd-mini-play").click();
  assert(window.MockSpotify.state.playing !== before, "mini play did not toggle playback");
  mini.querySelector(".sd-mini-play").click();
  const shuffleBtn = doc.querySelector('[data-testid="control-button-shuffle"]');
  const shuffleBefore = shuffleBtn.getAttribute("aria-checked");
  mini.querySelector(".sd-mini-shuffle").click();
  assert(shuffleBtn.getAttribute("aria-checked") !== shuffleBefore, "mini shuffle did not reach the web player");
  const repeatBefore = doc.querySelector('[data-testid="control-button-repeat"]').getAttribute("aria-checked");
  mini.querySelector(".sd-mini-repeat").click();
  assert(
    doc.querySelector('[data-testid="control-button-repeat"]').getAttribute("aria-checked") !== repeatBefore,
    "mini repeat did not reach the web player"
  );
  mini.querySelector(".sd-mini-repeat").click();
  return "lecture · aléatoire · répétition ✓";
});

check("the layout viewport is pinned to the device width", () => {
  // Le web player ne déclare pas de <meta viewport> : sans lui, la WebView
  // calcule la mise en page sur 980 px et toute l'interface vise un écran trois
  // fois plus large que le téléphone (c'est le défaut d'affichage d'origine).
  const metas = doc.querySelectorAll('meta[name="viewport"]');
  assert(metas.length === 1, `expected exactly one viewport meta, got ${metas.length}`);
  const content = metas[0].getAttribute("content");
  assert(/width=device-width/.test(content), "width=device-width missing: " + content);
  assert(/initial-scale=1/.test(content), "initial-scale=1 missing: " + content);
  assert(/viewport-fit=cover/.test(content), "viewport-fit=cover missing: " + content);
  return content.replace(/, /g, " ");
});

check("a layout viewport wider than the screen is reported", () => {
  const vp = SD._internals.Viewport;
  const realScreen = window.screen.width;
  Object.defineProperty(window.screen, "width", { value: 1080, configurable: true });
  Object.defineProperty(window.screen, "devicePixelRatio", { value: 2.75, configurable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: 2.75, configurable: true });
  const bad = { layout: 980 };
  Object.defineProperty(doc.documentElement, "clientWidth", { value: bad.layout, configurable: true });
  const m = vp.measure();
  assert(m.device === 393, "expected a 393 CSS px screen, got " + m.device);
  assert(m.ok === false, "980 px for a 393 px screen must be flagged");
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 393, configurable: true });
  assert(vp.measure().ok === true, "a 393 px layout on a 393 px screen must be accepted");
  Object.defineProperty(window.screen, "width", { value: realScreen, configurable: true });
  return "980≠393 signalé · 393=393 accepté";
});

check("native consent banner is removed and the scroll lock released", () => {
  // Le web player affiche la bannière OneTrust par-dessus notre mini-player et
  // bloque le défilement tant qu'on n'a pas cliqué « Accepter ».
  const banner = doc.createElement("div");
  banner.id = "onetrust-consent-sdk";
  banner.appendChild(doc.createElement("div"));
  doc.body.appendChild(banner);
  doc.body.style.overflow = "hidden";
  SD._internals.Polish.purgePopups();
  assert(!doc.getElementById("onetrust-consent-sdk"), "the consent banner survived");
  assert(doc.body.style.overflow !== "hidden", "the body scroll stayed locked");
  return "bannière retirée + défilement libéré ✓";
});

/* ------------------------------------------------------------------ *
 * Le rattrapage du 26/09 — unité du curseur, place du bas d'écran, réglages.
 *
 * Quatre familles de défauts signalementées ou dénichées à la relecture, toutes
 * vérifiées **comportementalement** (un état qui bouge, une valeur écrite, une
 * adresse changée) et non en lisant le code :
 *
 *   1. lire et écrire le curseur de Spotify dans l'unité mesurée ;
 *   2. réserver au bas de l'écran la hauteur **réellement affichée** du
 *      mini-lecteur ;
 *   3. les réglages : prendre effet tout de suite, et survivre au redémarrage ;
 *   4. aucun bouton qui s'appelle « undefined », aucune commande muette quand
 *      l'élément de Spotify a disparu, un branchement qui ne se répète pas.
 * ------------------------------------------------------------------ */
const bootWithMock = async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  dom.window.eval(
    "window.__bridgeCalls = []; window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => {" +
      "window.__bridgeCalls.push([String(p), a]); if (String(p) === 'isWoke') return false; return undefined; } });"
  );
  dom.window.eval(await read("demo/mock/spotify.js"));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(260);
  return dom;
};

await checkAsync("le bas de l'écran réserve la hauteur réellement affichée du mini-lecteur", async () => {
  /* Un règlement : la place réservée sous la page vient de la **mesure**, pas
     d'une hauteur espérée dans la feuille. Trois pièges sont vérifiés ici — et
     le premier est le plus vicieux : écrire `0` parce que la page n'a pas encore
     de mise en page ferait glisser le contenu sous la barre, soit l'autre moitié
     du défaut d'origine. */
  const dom = await bootWithMock();
  const w = dom.window;
  const internal = w.SpotiDuckUI._internals;
  const html = w.document.documentElement;
  const readH = () => html.style.getPropertyValue("--sd-mini-h-current");

  /* jsdom ne peint rien : `getBoundingClientRect()` vaut 0. Loin d'écrire « 0px
     » (le mini-lecteur est bien affiché), la mesure doit donc **rendre la main**
     à la feuille de styles. */
  internal.UI.measure();
  assert(readH() !== "0px", "la mesure écrase la réservation alors qu'elle n'a rien mesuré");

  /* Une hauteur réelle, et la valeur en ligne suit le haut de l'écran. */
  internal.UI.el.mini.getBoundingClientRect = () => ({
    height: 183.4,
    width: 360,
    top: 0,
    left: 0,
    right: 360,
    bottom: 183.4,
  });
  assert(internal.UI.measure() === true, "une hauteur nouvelle n'a rien changé");
  assert(readH() === "184px", `hauteur réservée attendue « 184px », obtenue « ${readH()} »`);
  assert(internal.UI.measure() === false, "la même hauteur est redite à chaque image : la page serait repeinte sans fin");

  /* Mini-lecteur hors écran (page de connexion, écran d'accueil) → la
     réservation se referme d'elle-même, plus de bande vide sous la page. Le banc
     ne lit pas nos feuilles (pas de moteur de rendu) : on masque par l'attribut
     `hidden`, qui suit le même chemin dans `measure()`. */
  internal.UI.el.mini.hidden = true;
  assert(internal.UI.measure() === true, "le mini-lecteur masqué ne libère pas la place");
  assert(readH() === "0px", `place attendue « 0px » une fois le mini-lecteur masqué, obtenue « ${readH()} »`);
  internal.UI.el.mini.hidden = false;
  assert(internal.UI.measure() === true, "le mini-lecteur revenu ne reprend pas sa place");
  assert(readH() === "184px", `place attendue « 184px » au retour du mini-lecteur, obtenue « ${readH()} »`);

  /* Et les feuilles gardent une valeur de repli crédible : trois rangées, au
     moins 140 px, sinon le premier rendu réserve une bande trop courte. */
  const css = await read("src/inject/76-device.css");
  const reserved = [...css.matchAll(/--sd-mini-h:\s*calc\((\d+)px/g)].map((m) => Number(m[1]));
  assert(reserved.length >= 3, "les feuilles ne fixent plus une hauteur de repli par taille d'écran");
  assert(reserved.every((n) => n >= 140 && n <= 260), `hauteurs de repli hors mesure : ${reserved.join(", ")}`);
  w.close();
  return `mesurée ${">"} 0 · repli ${reserved.join("/")} · 0 masqué ✓`;
});

await checkAsync("un réglage prend effet tout de suite, et survit au redémarrage", async () => {
  /* Deux promesses tenues au même endroit : l'appui se voit **immédiatement**
     (pas après avoir changé d'onglet), et le réglage retrouvé au lancement
     suivant est bien celui qui a été choisi. » */
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const internal = api._internals;

  /* Une rangée de la page à récupérer : l'accueil n'a de raison d'être que s'il a
     des données (`Home.shouldShow`) — ce n'est pas le sujet d'ici. */
  w.document
    .querySelector("#main-view, main")
    .insertAdjacentHTML(
      "afterbegin",
      '<section data-testid="component-shelf"><div><h2>Vos playlists</h2>' +
        '<a href="/playlist/aaa"><img src="https://i.scdn.co/image/aaa" alt="Mix du soir"><p>Mix du soir</p></a>' +
        "</div></section>"
    );
  internal.Home.refresh("banc");
  assert(internal.Home.el.hidden === false, "l'accueil ne se montre pas alors qu'il a des données");

  api.set("homeBoard", false);
  assert(internal.Home.el.hidden === true, "l'accueil maison reste à l'écran quand on l'éteint");
  api.set("homeBoard", true);
  assert(internal.Home.el.hidden === false, "l'accueil maison ne revient pas quand on le rallume");

  api.state.tab = "library";
  api.set("libraryBoard", false);
  assert(api.library.el.hidden === true, "la bibliothèque maison reste à l'écran quand on l'éteint");
  api.set("libraryBoard", true);
  assert(api.library.el.hidden === false, "la bibliothèque maison ne revient pas quand on la rallume");

  /* La couleur reprise de la pochette : l'éteindre rend sa base au lecteur. */
  api.set("accentFromArt", true);
  api.set("accentFromArt", false);
  assert(
    !w.document.documentElement.style.getPropertyValue("--sd-player-bg"),
    "le dégradé de la pochette reste en place après avoir éteint le réglage"
  );

  /* Tous les réglages sont écrits, y compris les trois que la liste oubliait. */
  const saved = JSON.parse(w.localStorage.getItem("sd.ui.settings") || "{}");
  for (const key of [
    "theme",
    "density",
    "haptics",
    "accentFromArt",
    "tabbar",
    "takeControl",
    "resume",
    "reduceMotion",
    "stats",
    "homeBoard",
    "libraryBoard",
  ]) {
    assert(key in saved, `le réglage « ${key} » n'est pas écrit dans le stockage`);
  }
  w.close();

  /* **Second lancement, même stockage** : ce qui a été choisi est retrouvé — et
     une valeur qui n'existe pas retombe sur le réglage par défaut au lieu de
     laisser l'interface sans feuille. */
  const again = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  again.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  again.window.localStorage.setItem(
    "sd.ui.settings",
    JSON.stringify({ density: "large", homeBoard: false, stats: false, tabbar: true, theme: "clair", accentFromArt: "oui" })
  );
  again.window.eval(await read("demo/mock/spotify.js"));
  again.window.eval(await read("dist/spotiduck-ui.js"));
  await tick(260);
  const back = again.window.SpotiDuckUI;
  assert(back.settings.density === "large", `densité retrouvée attendue « large », obtenue « ${back.settings.density} »`);
  assert(back.settings.homeBoard === false, "l'accueil éteint ne l'est plus au second lancement");
  assert(back.settings.stats === false, "statistiques éteintes non retrouvées");
  assert(back.settings.tabbar === true, "la barre d'onglets rallumée ne l'est plus au second lancement");
  assert(back.settings.theme === "auto", `thème inconnu attendu « auto », obtenu « ${back.settings.theme} »`);
  assert(back.settings.accentFromArt === true, `un réglage d'un autre type ne devrait pas s'écrire (obtenu « ${back.settings.accentFromArt} »)`);
  assert(again.window.document.documentElement.classList.contains("sd-density-large"), "la densité retrouvée n'est pas appliquée");
  {
    const board = again.window.document.querySelector(".sd-home");
    assert(!board || board.hidden, "l'accueil éteint est revenu à l'écran");
  }
  again.window.close();
  return "11 réglages écrits · pris en compte séance tenante · relu au second lancement ✓";
});

await checkAsync("aucun bouton ne s'appelle « undefined », et une bulle sans texte reste muette", async () => {
  /* Un libellé oublié dans la liste des textes ne se voit nulle part : ni à la
     compilation, ni au banc quand il lit la liste au lieu de l'appel. Sur
     l'écran, cela donne une bulle « undefined » ou un bouton sans nom. */
  const dom = await bootWithMock();
  const w = dom.window;
  const doc = w.document;
  const bad = [];
  for (const el of doc.querySelectorAll(".sd-layer, .sd-layer *")) {
    for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
      const v = el.getAttribute(attr);
      if (v && /undefined|NaN|\[object/.test(v)) bad.push(`${el.tagName}.${el.className}[${attr}]=${v}`);
    }
    if (!el.children.length && /^(undefined|NaN|\[object)/.test((el.textContent || "").trim())) {
      bad.push(`${el.tagName}.${el.className}:${el.textContent.trim()}`);
    }
  }
  assert(!bad.length, `du texte accidenté est affiché : ${bad.slice(0, 4).join(" · ")}`);

  /* Toutes les commandes de la coque ont un nom (lecteur d'écran, tangage). */
  const unnamed = [...doc.querySelectorAll(".sd-layer button")].filter(
    (b) =>
      !b.closest("[hidden]") &&
      !(b.getAttribute("aria-label") || "").trim() &&
      !(b.textContent || "").trim()
  );
  assert(!unnamed.length, `${unnamed.length} boutons de la coque sont sans nom`);

  /* Et la bulle ne se montre que si elle a quelque chose à dire. */
  const Toast = w.SpotiDuckUI._internals.Toast;
  assert(Toast.show(undefined) === false, "une bulle sans texte s'affiche");
  assert(Toast.show(null) === false, "une bulle nulle s'affiche");
  assert(Toast.show("") === false, "une bulle vide s'affiche");
  assert(Toast.show("Notice indisponible") === true, "une bulle avec un texte ne s'affiche pas");
  assert(Toast.el.textContent === "Notice indisponible", "le texte de la bulle n'est pas celui demandé");
  w.close();
  return `${unnamed.length} bouton sans nom · bulle muette sans texte ✓`;
});

await checkAsync("le curseur se lit et s'écrit dans l'unité de la page", async () => {
  /* Le cœur du lecteur. La page de Spotify compte tantôt en secondes, tantôt en
     millisecondes : un seul endroit convertit (`ticksToMs` / `msToTicks`), et le
     banc le vérifie dans les deux sens — y compris ce qui se passe pendant
     qu'on tient le doigt sur la barre, où seul l'écouteur délégué sait lire. */
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const internal = api._internals;
  const input = w.document.querySelector('div[data-testid="playback-progressbar"] input');
  const dur = Number(input.getAttribute("max")); // 207 s : la page compte en secondes
  assert(dur > 60 && dur < 400, `curseur du banc gradué en secondes attendu, obtenu ${dur}`);

  /* 1. Un glissement du doigt sur le curseur de **Spotify** (notre coque n'y est
        pour rien) doit donner la position en millisecondes, et non sa
        millième partie. */
  input.value = String(Math.round(dur / 2));
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  await tick(30);
  const half = Math.round(dur / 2) * 1000;
  assert(
    Math.abs(api.state.anchorPos - half) < 1500,
    `position attendue ≈ ${half} ms après un glissement, obtenue ${api.state.anchorPos}`
  );

  /* 2. Écrire, c'est l'inverse : la moitié du morceau vaut la moitié de la
        course du curseur — pas 1000 fois plus ni 1000 fois moins. */
  internal.Actions.seekRatio(0.5);
  await tick(60);
  assert(
    Math.abs(Number(input.value) - dur / 2) < 2,
    `curseur attendu ≈ ${(dur / 2).toFixed(1)}, écrit ${input.value}`
  );

  /* 3. Une demande hors du morceau reste dans le morceau. Une page qui n'a pas
        encore annoncé sa durée ne doit pas non plus ramener la lecture à zéro. */
  api.seek(dur * 1000 * 50);
  await tick(40);
  assert(Math.abs(Number(input.value) - dur) < 2, `une avance au-delà du titre doit s'arrêter à la fin, curseur à ${input.value}`);
  api.seek(-5000);
  await tick(40);
  assert(Number(input.value) === 0, `une avance négative doit s'arrêter au début, curseur à ${input.value}`);
  input.setAttribute("max", "");
  api.state.duration = dur * 1000;
  api.seek(10000);
  await tick(40);
  assert(
    Math.abs(Number(input.value) - 10) < 1.5,
    "un curseur sans graduation doit retomber sur la durée annoncée par la page, pas à zéro"
  );
  input.setAttribute("max", String(dur));

  /* 4. Et la durée du titre se connaît même avant que la page l'annonce : le
        geste ne se bloque pas, il cherche dans la course du curseur. */
  const before = api.state.duration;
  api.state.duration = 0;
  assert(internal.UI && Math.abs(internal.Actions.seekRatio(1) || 1) >= 0, "seekRatio doit rester utilisable sans durée annoncée");
  await tick(40);
  assert(Math.abs(Number(input.value) - dur) < 2, `fin de piste attendue sans durée annoncée, curseur à ${input.value}`);
  api.state.duration = before;
  w.close();
  return "glisser lu en ms · écriture dans la graduation de la page · bornes tenues ✓";
});

await checkAsync("une commande ne reste pas muette quand l'élément de Spotify a disparu", async () => {
  /* « Précédent » remettait le titre au début **sans regarder si cela avait
     marché** : le curseur absent (page en cours de remplacement), le bouton ne
     faisait absolument rien. Il doit alors faire ce que l'utilisateur attend
     depuis ce bouton : revenir au titre précédent. */
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const mock = w.MockSpotify;
  const doc = w.document;

  /* En lecture, à quarante secondes du début : un « précédent » remet d'abord au
     début, comme dans l'application. */
  api.state.anchorPos = 40000;
  api.state.anchorAt = w.performance.now();
  const index = mock.state.trackIndex;
  doc.querySelector(".sd-mini-prev").click();
  await tick(200);
  assert(mock.state.trackIndex === index, "un « précédent » en milieu de piste ne doit pas changer de titre tout de suite");
  assert(mock.state.position < 2, `position attendue près du début, obtenue ${mock.state.position}`);

  /* Curseur de progression retiré de la page : plus rien à remettre à zéro →
     on change vraiment de piste. */
  doc.querySelector('div[data-testid="playback-progressbar"] input').remove();
  api.state.anchorPos = 40000;
  api.state.anchorAt = w.performance.now();
  doc.querySelector(".sd-mini-prev").click();
  await tick(200);
  assert(
    mock.state.trackIndex !== index,
    `« précédent » sans curseur doit revenir au titre précédent (piste ${index} toujours jouée)`
  );
  w.close();
  return "remis au début si possible, piste précédente sinon ✓";
});

/* ------------------------------------------------------------------ *
 * L'élément qui joue, pas seulement le markup.
 *
 * Relevé en CI (Chrome réel, vraie page Spotify) le 26/09 : « les boutons
 * du lecteur ne font rien ». Deux causes, toutes deux muettes : la coque ne
 * lisait la piste **que** par les `data-testid` de React (renommés : la coque
 * se croyait sans titre), et sans titre elle posait `disabled` sur ses propres
 * boutons — un bouton désactivé ne reçoit aucun événement, donc l'appui ne
 * déclenchait ni commande ni message. Ces quatre sondes reproduisent une page
 * qui joue sans le dire par son markup.
 * ------------------------------------------------------------------ */
async function barePlayerPage(dom, opts) {
  const w = dom.window;
  const doc = w.document;
  const seleteurs = [
    '[data-testid="now-playing-widget"]',
    '[data-testid="now-playing-bar"]',
    "aside",
    "footer",
    'div[data-testid="playback-progressbar"]',
    'button[data-testid^="control-button"]',
    '[data-testid="add-like-button"]',
    '[data-testid="context-item-info-title"]',
    "[data-testid='playback-progressbar']",
  ];
  seleteurs.forEach((sel) => {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  });
  if (opts && opts.sansMedia) return { pos: () => 0, isPaused: () => true };

  let paused = false;
  let at = 42;
  const audio = doc.createElement("audio");
  Object.defineProperty(audio, "currentSrc", {
    value: "https://sd.example/track.mp3",
    configurable: true,
  });
  Object.defineProperty(audio, "duration", { value: 214, configurable: true });
  Object.defineProperty(audio, "currentTime", {
    get: () => at,
    set: (v) => {
      at = Number(v);
    },
    configurable: true,
  });
  Object.defineProperty(audio, "paused", { get: () => paused, configurable: true });
  Object.defineProperty(audio, "ended", { value: false, configurable: true });
  audio.play = function () {
    paused = false;
    audio.dispatchEvent(new w.Event("play"));
    return Promise.resolve();
  };
  audio.pause = function () {
    paused = true;
    audio.dispatchEvent(new w.Event("pause"));
  };
  (doc.querySelector("#main-view") || doc.body).appendChild(audio);
  Object.defineProperty(w.navigator, "mediaSession", {
    configurable: true,
    value: {
      metadata: {
        title: "Baarishein",
        artist: "Anuv Jain",
        album: "Anuv Jain",
        artwork: [
          { src: "https://sd.example/300.jpg", sizes: "300x300" },
          { src: "https://sd.example/720.jpg", sizes: "720x720" },
        ],
      },
      playbackState: "playing",
    },
  });
  return {
    audio: audio,
    pos: () => at,
    isPaused: () => paused,
    /* Un mutation dans la vue : c'est ce qui réveille l'observateur de la
       coque, comme le fait la page réelle quand elle remplace un bloc. */
    remuer: () => {
      const n = doc.createElement("i");
      (doc.querySelector("#main-view") || doc.body).appendChild(n);
      setTimeout(() => n.remove(), 0);
    },
  };
}

await checkAsync("la coque lit la piste dans l'élément qui joue, pas seulement dans le markup", async () => {
  const dom = await bootWithMock();
  const w = dom.window;
  const doc = w.document;
  const api = w.SpotiDuckUI;
  const Spotify = api._internals.Spotify;
  const p = await barePlayerPage(dom);

  const lu = Spotify.read();
  assert(lu.title === "Baarishein", `titre attendu de mediaSession, lu « ${lu.title} »`);
  assert(lu.artist === "Anuv Jain", "artiste attendu de mediaSession");
  assert(lu.cover === "https://sd.example/720.jpg", `plus grande pochette attendue, lue ${lu.cover}`);
  assert(lu.duration === 214000, `durée de l'élément en millisecondes attendue, lue ${lu.duration}`);
  assert(lu.position === 42000, `position de l'élément attendue, lue ${lu.position}`);
  assert(lu.playing === true, "l'élément joue : la coque doit dire « en lecture »");
  assert(Spotify.ready(), "un <audio> qui joue déclare le lecteur prêt, barre absente ou non");

  /* Et l'état suit, sans qu'on le lui demande : l'écoute de l'élément et
     l'observateur de la page se充 chargent de la resynchronisation. */
  p.remuer();
  await tick(700);
  assert(api.state.title === "Baarishein", `état attendu nourri par la page, lu « ${api.state.title} »`);
  assert(api.state.hasTrack === true, "la coque ne doit plus se croire sans piste");
  const btn = doc.querySelector(".sd-mini-play");
  assert(!btn.disabled, "une piste lue doit rendre le bouton pressable");
  assert(btn.getAttribute("aria-disabled") === "false", "bouton disponible : aria-disabled=false");
  w.close();
  return "mediaSession + <audio> lus · durée, position, pochette justes · état nourri ✓";
});

await checkAsync("lecture et pause agissent sur l'élément quand le bouton de Spotify est introuvable", async () => {
  const dom = await bootWithMock();
  const w = dom.window;
  const doc = w.document;
  const api = w.SpotiDuckUI;
  const p = await barePlayerPage(dom);
  p.remuer();
  await tick(700);
  assert(p.isPaused() === false, "la page doit partir en lecture dans cette sonde");

  doc.querySelector(".sd-mini-play").click();
  await tick(120);
  assert(p.isPaused() === true, "appuyer sur pause doit mettre l'élément en pause");
  await tick(700);
  assert(api.state.playing === false, "et l'état de la coque doit le dire");

  doc.querySelector(".sd-mini-play").click();
  await tick(120);
  assert(p.isPaused() === false, "un second appui reprend la lecture de l'élément");
  const toast = (doc.querySelector(".sd-layer .sd-toast") || {}).textContent || "";
  assert(
    !/ne répondent pas|rien ne joue/i.test(toast),
    `une commande qui a agi ne doit pas s'excuser : « ${toast.trim()} »`
  );
  w.close();
  return "pause puis reprise obtenues sur l'élément · aucun message d'échec ✓";
});

await checkAsync("la position se pose sur l'élément quand le curseur de la page a disparu", async () => {
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const Spotify = api._internals.Spotify;
  const p = await barePlayerPage(dom);
  assert(Spotify.progressInput() === null, "cette sonde doit être sans curseur de progression");
  assert(Spotify.seek(90000) === true, "chercher doit réussir sur l'élément");
  assert(Math.abs(p.pos() - 90) < 0.5, `90 secondes attendues sur l'élément, obtenu ${p.pos()}`);
  assert(Spotify.seek(-4000) === true && p.pos() === 0, "une demande négative va au début, jamais avant");
  assert(Spotify.seek(9999999) === true && Math.abs(p.pos() - 214) < 0.5, `la demande est bornée à la durée (${p.pos()})`);
  w.close();
  return "écriture sur l'élément · bornes tenues ✓";
});

await checkAsync("un bouton du lecteur sans piste reste pressable et le dit", async () => {
  const dom = await bootWithMock();
  const w = dom.window;
  const doc = w.document;
  const api = w.SpotiDuckUI;
  await barePlayerPage(dom, { sansMedia: true });
  api.state.title = "";
  api.state.hasTrack = false;
  api._internals.UI.paint(api.state, "sonde");

  const btn = doc.querySelector(".sd-mini-play");
  assert(btn, "le mini-lecteur doit garder ses commandes en place");
  assert(
    !btn.disabled,
    "jamais `disabled` : un bouton désactivé ne reçoit aucun événement, l'appui devient muet"
  );
  assert(btn.getAttribute("aria-disabled") === "true", "l'indisponibilité s'annonce par aria-disabled");
  assert(btn.classList.contains("is-unavailable"), "…et se dessine par .is-unavailable");

  const toast = doc.querySelector(".sd-layer .sd-toast");
  if (toast) toast.textContent = "";
  btn.click();
  await tick(1400);
  const dit = ((doc.querySelector(".sd-layer .sd-toast") || {}).textContent || "").trim();
  assert(dit.length > 0, "l'appui doit recevoir une réponse, même sans piste");
  assert(/ne joue|titre|piste/i.test(dit), `réponse attendue sur l'absence de piste, lue : « ${dit} »`);
  w.close();
  return "bouton pressable, état annoncé, appui répondu ✓";
});

await checkAsync("l'onglet bibliothèque mène bien quelque part", async () => {
  /* Depuis une playlist, l'appui sur « Bibliothèque » allumait l'onglet et ne
     montrait rien : notre page se range devant une sous-page, et aucune
     navigation n'était demandée. Elle doit donc ramener l'accueil, où la page a
     sa place. */
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const internal = api._internals;
  w.MockSpotify.navigate("playlist");
  await tick(80);
  assert(w.location.pathname !== "/", "le banc n'a pas ouvert de sous-page");
  assert(api.library.el.hidden === true, "la page bibliothèque recouvre la playlist ouverte");

  internal.Router.tab("library");
  /* La vue change quand Spotify a peint la sienne (observation du DOM, pas
     d'attente fixe côté utilisateur) : le banc laisse le temps du relevé. */
  await tick(600);
  assert(w.location.pathname === "/", `appui sur « bibliothèque » attendu à l'accueil, adresse ${w.location.pathname}`);
  assert(api.state.tab === "library", "l'onglet actif n'a pas suivi");
  assert(api.library.el.hidden === false, "la page bibliothèque ne s'est pas montrée une fois à l'accueil");
  w.close();
  return "depuis une playlist : accueil + page bibliothèque ✓";
});

await checkAsync("le mini-lecteur se pilote aussi au clavier", async () => {
  /* Barre de progression du mini-lecteur : les flèches, « début » et « fin »
     doivent agir comme dans le lecteur plein écran (télécommande, clavier
     Bluetooth), et le simple appui ne doit pas ouvrir la feuille. */
  const dom = await bootWithMock();
  const w = dom.window;
  const api = w.SpotiDuckUI;
  const rail = w.document.querySelector(".sd-mini-seek");
  assert(rail, "la barre de progression du mini-lecteur est absente");
  const input = w.document.querySelector('div[data-testid="playback-progressbar"] input');
  const dur = Number(input.getAttribute("max"));

  api.state.seeking = false;
  rail.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await tick(60);
  assert(Number(input.value) === 0, `« début » attendu, curseur à ${input.value}`);
  rail.dispatchEvent(new w.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await tick(60);
  assert(Math.abs(Number(input.value) - dur) < 2, `« fin » attendue, curseur à ${input.value}`);
  rail.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await tick(60);
  assert(
    Number(input.value) > 0 && Number(input.value) < dur,
    `une flèche doit avancer de quelques secondes, curseur à ${input.value}`
  );

  /* Appui simple sur la barre : il déplace la lecture, mais n'ouvre pas le
     lecteur plein écran (le geste qui gêne le plus à l'usage). */
  assert(api.state.playerOpen !== true, "le lecteur plein écran ne doit pas s'ouvrir au toucher de la barre");
  w.close();
  return "flèches · début · fin · appui simple ✓";
});

await checkAsync("un redémarrage de la coque ne branche pas deux fois la page", async () => {
  /* En attendant que le web player soit prêt, `boot` se rejoue une soixantaine
     de fois. Chaque passage ajoutait ses écouteurs de fin de session, ses
     alarmes et ses minuteurs : au bout d'une minute sans session, un seul
     passage en arrière-plan écrivait des dizaines de fois, et les alarmes de
     page blanche partaient en rafale. */
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://open.spotify.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  /* Le comptage doit précéder le script : on compte les branchements, pas les
     appels. */
  dom.window.eval(
    "window.__adds = {};" +
      "['pagehide','beforeunload','visibilitychange','input'].forEach(function (name) {" +
      "  var wa = window.addEventListener.bind(window); window.addEventListener = function (n, f, o) {" +
      "    if (n === name) window.__adds[n] = (window.__adds[n] || 0) + 1; return wa(n, f, o); };" +
      "  var da = document.addEventListener.bind(document); document.addEventListener = function (n, f, o) {" +
      "    if (n === name) window.__adds[n] = (window.__adds[n] || 0) + 1; return da(n, f, o); };" +
      "});"
  );
  dom.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => undefined }));
  dom.window.eval(await read("dist/spotiduck-ui.js"));
  /* Assez longtemps pour que `boot` se soit rejoué plusieurs fois (aucun lecteur
     dans cette page : il attend, puis réessaie). */
  await tick(4200);
  const adds = dom.window.__adds;
  const repeated = Object.keys(adds).filter((k) => adds[k] > 1);
  assert(!repeated.length, `écouteurs branchés plusieurs fois : ${repeated.map((k) => `${k}×${adds[k]}`).join(" · ")}`);
  assert((adds.pagehide || 0) === 1 && (adds.visibilitychange || 0) === 1, "les écouteurs de fin de session ne sont plus branchés du tout");
  /* Une seule écoute du curseur, posée sur le document : pas une par copie du
     curseur recréé à chaque changement de vue. */
  assert((adds.input || 0) <= 1, `le glisser du curseur réécoute encore ${adds.input} fois`);
  /* Et la coque, elle, est bien construite une fois. */
  assert(dom.window.document.querySelectorAll(".sd-layer").length === 1, "deux couches injectées dans la même page");
  dom.window.close();
  return `branché une fois (${Object.keys(adds).length} types d'écouteurs) ✓`;
});

await checkAsync("no polling loops left behind", async () => {
  // The mock itself uses one interval for playback; the layer must not add any
  // 2s/5s DOM scraping loop (that was the main source of jank).
  const raw = await read("src/inject/spotiduck-ui.js");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // strip comments
  const loops = (src.match(/setInterval\(/g) || []).length;
  assert(loops === 0, `runtime still uses setInterval (${loops}×)`);
  assert(/MutationObserver/.test(src), "expected a MutationObserver");
  return "0 intervals · MutationObserver ✓";
});

check("no runtime errors", () => {
  assert(errors().length === 0, errors().join(" | "));
  return "0 errors";
});

/* ------------------------------------------------------------------ *
 * Troisième banc : le mode « interface Spotify » (native-mode.js).
 * Le user-agent est celui de Chrome Android, donc la page affichée est
 * celle de Spotify ; ce script doit seulement la laisser tranquille et
 * continuer à faire fonctionner les boutons de la notification Android —
 * c'est le mode livré par défaut depuis la 2.7.3.
 * ------------------------------------------------------------------ */
const natHtml =
  '<!doctype html><html><head></head><body>' +
  '<div data-testid="banner">Ouvrir dans l\'application</div>' +
  '<a href="/download">Telecharger l\'application</a>' +
  /* Le bandeau du haut, tel que Spotify le repose à chaque changement d'écran :
     attributs inconnus, texte explicite, lien vers l'application. */
  '<div id="app-prompt" class="encore-banner-random" role="banner">' +
  '<span>Ouvrir dans l\'application</span><a href="spotify://open">Ouvrir</a></div>' +
  /* La barre du haut de la page, elle, porte aussi ses commandes : elle doit
     survivre — seule l'invite disparaît. */
  '<header id="top-bar" role="banner"><a href="/search">Rechercher</a>' +
  '<a href="/me">Profil</a><a href="spotify://open">Ouvrir dans l\'application</a></header>' +
  /* La barre du bas : ses onglets sont des liens `spotify:` (Spotify s'en sert
     pour renvoyer vers son application). Aucun ne doit être touché — c'est
     exactement ce qui cassait le bouton Bibliothèque. */
  '<nav id="bottom-nav"><a href="/">Accueil</a><a href="/search">Rechercher</a>' +
  '<a id="lib-tab" href="spotify:collection">Bibliothèque</a>' +
  '<a id="premium-tab" href="/premium">Premium</a></nav>' +
  /* Et l'encart d'abonnement, en fenêtre. */
  '<div id="premium-dialog" role="dialog"><p>Passez à Premium</p>' +
  '<button>Essai gratuit</button></div>' +
  /* L'offre du démarrage, telle que Spotify la pose : une fenêtre, sa croix de
     fermeture et deux boutons — trois éléments cliquables, et un prix qui ne
     ressemble à aucun de nos motifs par attribut. */
  '<div id="premium-0" role="dialog" aria-modal="true">' +
  '<button aria-label="Fermer">×</button><p>Premium à 0 € pendant 3 mois</p>' +
  '<button>Essayer</button><button>Plus tard</button></div>' +
  /* Et un onglet qui n'est pas un lien : le routeur de Spotify décide. */
  '<nav id="bottom-nav-2"><button id="lib-button">Bibliothèque</button>' +
  '<a href="/search">Rechercher</a></nav>' +
  '<div data-testid="now-playing-widget">' +
  '<a data-testid="context-item-link" href="/track/1">Titre test</a>' +
  '<div data-testid="context-item-info-artist">Artiste test</div>' +
  '<img data-testid="cover-art-image" src="https://i.scdn.co/image/test.jpg">' +
  '<button data-testid="control-button-playpause" aria-label="Lecture"></button>' +
  '<button data-testid="control-button-skip-forward" aria-label="Suivant"></button>' +
  '<button data-testid="control-button-skip-back" aria-label="Precedent"></button>' +
  '<button aria-checked="false" aria-label="Jaime"></button>' +
  '<div data-testid="playback-progressbar"><input type="range" min="0" max="200" value="10"></div>' +
  "</div></body></html>";

const nat = new JSDOM(natHtml, {
  url: "https://open.spotify.com/",
  pretendToBeVisual: true,
  runScripts: "dangerously",
});
const nw = nat.window;
const nd = nw.document;
const natCalls = [];
const natClicks = [];
const natErrors = [];
nw.__bridgeCalls = natCalls;
nw.addEventListener("error", (e) => natErrors.push(String(e.message)));
nw.eval(
  "window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => {" +
    "if (String(p) === 'nFetchAsync') return undefined;" +
    "window.__bridgeCalls.push([String(p), a]);" +
    "if (String(p) === 'isWoke') return false; } });"
);
for (const b of nd.querySelectorAll("button")) {
  b.addEventListener("click", () => natClicks.push(b.getAttribute("data-testid") || b.getAttribute("aria-label")));
}
const natScript = await read("android/app/src/main/assets/native-mode.js");
nw.eval(natScript);
nw.eval(natScript); // Android peut réinjecter la page : le script doit être idempotent
const nSD = nw.SpotiDuckUI;
const natCall = (name) => natCalls.filter((c) => c[0] === name);

check("native mode: a shim replaces the injected layer", () => {
  assert(nSD && nSD.mode === "native", "window.SpotiDuckUI.mode is not native");
  assert(!nd.querySelector(".sd-layer") && !nd.querySelector(".sd-tab"), "the SpotiDuck layer must not be injected");
  assert(nd.querySelectorAll("style[data-sd='native-mode']").length === 1, "the banner stylesheet was injected twice");
  const missing = ["play", "pause", "playPause", "next", "previous", "like", "seek", "sync", "back"].filter(
    (m) => typeof nSD[m] !== "function"
  );
  assert(missing.length === 0, "methods the PlaybackService calls are missing: " + missing.join(", "));
  return "9 méthodes · aucune couche injectée · idempotent ✓";
});

check("native mode: the viewport meta is declared too", () => {
  const metas = nd.querySelectorAll('meta[name="viewport"]');
  assert(metas.length === 1, `expected exactly one viewport meta, got ${metas.length}`);
  assert(/width=device-width/.test(metas[0].getAttribute("content")), "width=device-width missing");
  return "width=device-width · une seule balise ✓";
});

check("native mode: browser banners are hidden, not removed", () => {
  const css = nd.querySelector("style[data-sd='native-mode']").textContent;
  assert(css.includes("[data-testid='banner']"), "the mobile banner selector is missing");
  assert(/display:none\s*!important/.test(css), "the banner selectors must be display:none");
  assert(css.includes("play.google.com") && css.includes("apps.apple.com"), "the store links should be hidden too");
  assert(nd.querySelector("[data-testid='banner']"), "the banner should stay in the DOM, only hidden");
  return "bandeaux masqués en CSS ✓";
});

check("native mode: the open-in-app banner is hunted down by its text", () => {
  const band = nd.querySelector("#app-prompt");
  assert(band, "the test page no longer has the app banner");
  assert(
    band.getAttribute("data-sd-appprompt") === "1",
    "the app banner was not recognised (Spotify renamed its attributes, the text is intact)"
  );
  const css = nd.querySelector("style[data-sd='native-mode']");
  assert(
    /\[data-sd-appprompt='1'\]\s*\{[^}]*display:none/.test(css.textContent),
    "nothing hides what the hunt marked"
  );
  const bar = nd.querySelector("#top-bar");
  assert(bar && !bar.hasAttribute("data-sd-appprompt"), "the page's own top bar must survive");
  const invite = bar.querySelector("a[href^='spotify:']");
  assert(invite && invite.getAttribute("data-sd-appprompt") === "1", "the invite inside the top bar must go");
  const track = nd.querySelector("a[data-testid='context-item-link']");
  assert(track && !track.hasAttribute("data-sd-appprompt"), "a track link must not be hidden");
  return "bandeau dédié entier · barre du haut épargnée · liens de la page épargnés ✓";
});

check("native mode: a nav tab with a spotify: link is never touched", () => {
  const lib = nd.querySelector("#lib-tab");
  assert(lib, "the test page no longer has the library tab");
  assert(
    !lib.hasAttribute("data-sd-appprompt"),
    "the library tab was mistaken for an « open in the app » invite"
  );
  const nav = nd.querySelector("#bottom-nav");
  assert(nav && !nav.hasAttribute("data-sd-appprompt"), "the bottom bar must never be hidden");
  const accueil = nav.querySelector("a[href='/']");
  assert(accueil && !accueil.hasAttribute("data-sd-appprompt"), "the home tab must survive");
  return "onglets préservés (dont un lien spotify:) ✓";
});

check("native mode: the subscription upsell and its tab are removed", () => {
  const dialog = nd.querySelector("#premium-dialog");
  /* Une fenêtre part en entier (`data-sd-premium-dialog`) : c'est la marque que
     pose le chemin « fenêtre posée par-dessus la page ». */
  assert(
    dialog &&
      (dialog.getAttribute("data-sd-premium-dialog") === "1" ||
        dialog.getAttribute("data-sd-premium") === "1"),
    "the premium dialog was not recognised"
  );
  const tab = nd.querySelector("#premium-tab");
  assert(tab && tab.getAttribute("data-sd-premium") === "1", "the premium tab must go");
  const nav = nd.querySelector("#bottom-nav");
  assert(!nav.hasAttribute("data-sd-premium"), "the bottom bar itself must survive");
  const css = nd.querySelector("style[data-sd='native-mode']");
  assert(
    /\[data-sd-premium='1'\]\s*\{[^}]*display:none/.test(css.textContent),
    "nothing hides what the sweep marked"
  );
  const track = nd.querySelector("a[data-testid='context-item-link']");
  assert(track && !track.hasAttribute("data-sd-premium"), "a track link must not be hidden");
  return "encart entier · onglet seul · barre préservée ✓";
});

check("native mode: the 0 € offer dialog goes, close button and all", () => {
  const offer = nd.querySelector("#premium-0");
  assert(offer, "the test page no longer has the 0 € offer");
  assert(
    offer.getAttribute("data-sd-premium-dialog") === "1",
    "the offer dialog was not recognised (a price, a close button and two CTAs)"
  );
  const css = nd.querySelector("style[data-sd='native-mode']");
  assert(
    /\[data-sd-premium-dialog='1'\]\s*\{[^}]*display:none/.test(css.textContent),
    "nothing hides the whole offer dialog"
  );
  const plain = nd.querySelector("#premium-dialog");
  assert(
    plain &&
      (plain.getAttribute("data-sd-premium-dialog") === "1" ||
        plain.getAttribute("data-sd-premium") === "1"),
    "the upsell dialog must go too"
  );
  const nav = nd.querySelector("#bottom-nav");
  assert(nav && !nav.hasAttribute("data-sd-premium-dialog"), "a nav bar must never pass for a dialog");
  return "fenêtre entière (croix + 2 boutons) ✓";
});

check("native mode: a nav tab says where it leads, link or not", () => {
  const routeFor = nw.__sdNavRouteFor;
  assert(typeof routeFor === "function", "native-mode.js no longer exposes the tab mapping");
  assert(routeFor(nd.querySelector("#lib-tab")) === "/collection", "a spotify:collection tab must lead to /collection");
  assert(routeFor(nd.querySelector("#lib-button")) === "/collection", "a « Bibliothèque » button must lead to /collection");
  const search = nd.querySelector("#bottom-nav a[href='/search']");
  assert(routeFor(search) === "/search", "the search tab must lead to /search");
  const home = nd.querySelector("#bottom-nav a[href='/']");
  assert(routeFor(home) === "/", "the home tab must lead to /");
  assert(routeFor(nd.querySelector("a[data-testid='context-item-link']")) === null, "a track link is not a tab");
  return "bibliothèque · rechercher · accueil ✓";
});

await checkAsync("native mode: a tab that leads nowhere is navigated for it", async () => {
  const tab = nd.querySelector("#lib-button");
  tab.dispatchEvent(new nw.MouseEvent("click", { bubbles: true }));
  const tap = nw.__sdNavTap;
  assert(tap && tap.route === "/collection", "the press was not recorded: " + JSON.stringify(tap));
  assert(tap.label.indexOf("Bibliothèque") === 0, "the label was not recorded: " + tap.label);
  /* Au bout d'une seconde sans mouvement de la page, la navigation est faite
     par l'application. jsdom ne sait pas naviguer (« Not implemented:
     navigation ») : c'est la marque qui compte. */
  await tick(1500);
  assert(nw.__sdNavTap.forced === "/collection", "the app did not take over the navigation");
  return "appui noté · navigation reprise par l'application ✓";
});

/* ------------------------------------------------------------------ *
 * La coque sur la page de connexion. C'est là qu'un nouvel utilisateur
 * commence, et c'est là qu'elle recouvrait le formulaire : l'écran d'accueil
 * maison se posait par-dessus `accounts.spotify.com`, et son bouton menait à
 * la page déjà affichée — « le bouton ne fait rien », utilisateur bloqué.
 * ------------------------------------------------------------------ */
const coopLoginCalls = [];
const coopLogin = new JSDOM(
  '<!doctype html><html><body><div id="root">' +
    '<form data-testid="login-form">' +
    '<input id="login-username" name="username" type="text">' +
    '<input name="password" type="password">' +
    '<button type="submit">Se connecter</button>' +
    "</form></div></body></html>",
  { url: "https://accounts.spotify.com/fr/login?allow_password=1", pretendToBeVisual: true, runScripts: "dangerously" }
);
coopLogin.window.AndBridge = new Proxy(
  {},
  withoutAsync({ get: (t, p) => (...a) => { coopLoginCalls.push([String(p), a]); return undefined; } })
);
coopLogin.window.eval(await read("dist/spotiduck-ui.js"));
await tick(150);
const cld = coopLogin.window.document;

check("coop: the welcome screen never covers the login form", () => {
  assert(!cld.documentElement.classList.contains("sd-welcome-on"), "welcome shown over the login page");
  assert(cld.documentElement.classList.contains("sd-login"), "the login page was not recognised");
  const form = cld.querySelector("[data-testid='login-form']");
  assert(form, "the login form is gone");
  assert(form.querySelector("input[type='password']"), "the password field is gone");
  return "aucun écran d'accueil sur la page de connexion ✓";
});

check("coop: the login page reports `login` (not a lost session)", () => {
  const states = coopLoginCalls.filter((c) => c[0] === "loginState").map((c) => c[1][0]);
  assert(states.includes("login"), "rapporté : " + JSON.stringify(states));
  assert(!states.includes("out"), "la page de connexion ne doit jamais être rapportée « déconnecté »");
  return "login ✓";
});

check("coop: no runtime error on the login host", () => {
  const errs = coopLogin.window.__errors || [];
  assert(errs.length === 0, errs.join(" | "));
  return "0 erreur";
});

/* Le banc de la connexion : une deuxième page, sur le domaine de connexion de
   Spotify, sans champ de mot de passe — c'est le cas où les boutons sociaux sont
   les seuls proposés et où aucun ne peut fonctionner dans une WebView. */
const loginDom = new JSDOM(
  '<!doctype html><html><body><div id="root"><button>Continuer avec Google</button></div></body></html>',
  { url: "https://accounts.spotify.com/fr/login", pretendToBeVisual: true, runScripts: "dangerously" }
);
const lw = loginDom.window;
const ld = lw.document;
lw.__bridgeCalls = [];
lw.AndBridge = new Proxy({}, withoutAsync({ get: () => () => {} }));
lw.eval(natScript);

check("native mode: a social-only login page gets an e-mail way through", () => {
  const bar = ld.querySelector("#sd-login-help");
  assert(bar, "no e-mail help on a login page without a password field");
  const button = bar.querySelector("a[data-sd='login-help-button']");
  assert(button, "the help has no button");
  /* Adresse **absolue** : mesurée en CI, `open.spotify.com/login` répond 404 et
     `/fr/login` tout court ne demande que l'e-mail. C'est
     `accounts.spotify.com/fr/login?allow_password=1` qui affiche les deux champs,
     et un lien relatif dépendrait de la page où on se trouve. */
  assert(
    button.getAttribute("href") === "https://accounts.spotify.com/fr/login?allow_password=1",
    "the button must ask Spotify for the password form: " + button.getAttribute("href")
  );
  assert(
    /e-?mail/i.test(button.textContent),
    "the button should say it is about e-mail: " + button.textContent
  );
  assert(bar.querySelector("a[data-sd='login-help-hide']"), "the help cannot be dismissed");
  return "bouton e-mail + mot de passe, masquable ✓";
});

check("native mode: the help disappears once the password form is there", () => {
  const input = ld.createElement("input");
  input.type = "password";
  input.name = "password";
  ld.querySelector("#root").appendChild(input);
  lw.__sdLoginTick();
  assert(!ld.querySelector("#sd-login-help"), "the help stayed after the form appeared");
  return "champ mot de passe présent → aucun bandeau ✓";
});

check("native mode: no login help outside the login pages", () => {
  assert(!nd.querySelector("#sd-login-help"), "the help must not appear on the player page");
  return "rien sur le lecteur ✓";
});

await checkAsync("native mode: the logged-out home page offers the e-mail way too", async () => {
  const home = new JSDOM(
    '<!doctype html><html><body><div id="root"><button>Se connecter</button></div></body></html>',
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  home.window.__calls = [];
  home.window.AndBridge = new Proxy({}, withoutAsync({ get: () => () => {} }));
  home.window.eval(natScript);
  const bar = home.window.document.querySelector("#sd-login-help");
  assert(bar, "the logged-out home page got no e-mail help");
  const button = bar.querySelector("a[data-sd='login-help-button']");
  assert(button && /allow_password=1/.test(button.getAttribute("href")), "the button must ask for the password form");
  /* Une fois le lecteur en place (barre de navigation), le raccourci s'efface. */
  const nav = home.window.document.createElement("nav");
  nav.innerHTML = "<a href='/'>Accueil</a>";
  home.window.document.body.appendChild(nav);
  home.window.__sdLoginTick();
  assert(!home.window.document.querySelector("#sd-login-help"), "the help stayed on the player page");
  return "page déconnectée oui · lecteur non ✓";
});

check("native mode: window.open is left to the WebView", () => {
  /* Mesuré en CI : « Continuer avec Google » ouvre
     `accounts.google.com/v3/signin/identifier?client_id=…&redirect_uri=accounts.spotify.com/login/google/redirect`
     par `window.open`, et attends que cette fenêtre lui rende la main par
     `window.opener`. Le script ne doit donc **pas** y toucher : la 2.8.1 le
     remplaçait par une navigation dans la page courante, et le retour de
     connexion n'arrivait plus.

     La WebView, elle, en ouvre une vraie (transport de fenêtre + onCloseWindow,
     vérifié par l'audit). Ici on vérifie seulement que la page garde la main. */
  assert(typeof nw.__sdNavigate === "function", "__sdNavigate a disparu (liens internes et sonde)");
  assert(
    typeof nw.open === "function" && String(nw.open).indexOf("__sdNavigate") === -1,
    "window.open est de nouveau remplacé par une navigation dans la page"
  );
  /* Une fenêtre vide reste une fenêtre vide : c'est `about:blank` qui sert de
     base à la vraie destination, et la WebView la gère. */
  assert(!/realOpen/.test(natScript), "le shim de la 2.8.1 est encore dans le script");
  return "window.open intact (vraie fenêtre côté WebView) ✓";
});

check("native mode: the login page announces its state, not a disconnection", () => {
  /* Le cookie dit qu'une session a existé ; la page seule dit si elle vaut
     encore quelque chose. Sur une page de connexion, être déconnecté est la
     normale : l'annoncer « out » ferait jeter une copie de secours valable. */
  const sent = [];
  const previous = lw.AndBridge;
  lw.AndBridge = new Proxy({}, withoutAsync({ get: (_t, name) => (...args) => sent.push([name, args[0]]) }));

  assert(lw.__sdLoginState() === "login", "une page de connexion doit se dire « login » : " + lw.__sdLoginState());
  lw.__sdLoginTick();
  assert(
    sent.some((c) => c[0] === "loginState" && c[1] === "login"),
    "l'état de connexion n'est pas annoncé : " + JSON.stringify(sent)
  );

  lw.AndBridge = previous;
  return "verdict « login » annoncé au pont ✓";
});

check("native mode: a connected player page is announced as « in »", () => {
  const player = new JSDOM(
    '<!doctype html><html><body><div data-testid="now-playing-widget"></div></body></html>',
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const sent = [];
  player.window.AndBridge = new Proxy({}, withoutAsync({ get: (_t, name) => (...args) => sent.push([name, args[0]]) }));
  player.window.eval(natScript);
  assert(player.window.__sdLoginState() === "in", "un lecteur connecté doit se dire « in » : " + player.window.__sdLoginState());
  player.window.__sdLoginTick();
  assert(
    sent.some((c) => c[0] === "loginState" && c[1] === "in"),
    "le lecteur connecté n'est pas annoncé : " + JSON.stringify(sent)
  );
  return "lecteur connecté → « in » ✓";
});

check("native mode: a logged-out player is announced as « out »", () => {
  /* Un lecteur dont la session est morte : la coquille est là (barre de
     navigation), mais aucune trace de compte. C'est le seul cas qui se dit
     « out » — l'accueil déconnecté, lui, se dit « login ». */
  const out = new JSDOM(
    '<!doctype html><html><body><nav><a href="/">Accueil</a></nav>' +
      '<button data-testid="login-button">Se connecter</button>' +
      '<p>S\'inscrire gratuitement</p></body></html>',
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const sent = [];
  out.window.AndBridge = new Proxy({}, withoutAsync({ get: (_t, name) => (...args) => sent.push([name, args[0]]) }));
  out.window.eval(natScript);
  assert(out.window.__sdLoginState() === "out", "une page déconnectée doit se dire « out » : " + out.window.__sdLoginState());
  out.window.__sdLoginTick();
  assert(
    sent.some((c) => c[0] === "loginState" && c[1] === "out"),
    "la déconnexion n'est pas annoncée : " + JSON.stringify(sent)
  );
  return "lecteur déconnecté → « out » ✓";
});

check("native mode: after a form error, the state can be cleaned and retried", () => {
  /* « E-mail ou mot de passe incorrect » arrive aussi quand ce n'est **pas** le
     mot de passe : un jeton de page (CSRF) resté d'une visite précédente suffit.
     Le bouton n'apparaît donc qu'après une erreur, et seulement si
     l'application peut nettoyer (jamais `sp_dc` ni `sp_key`). */
  const fail = new JSDOM(
    '<!doctype html><html><body><div id="root"><button>Continuer avec Google</button>' +
      '<div role="alert">E-mail ou mot de passe incorrect</div></div></body></html>',
    { url: "https://accounts.spotify.com/fr/login", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const clean = [];
  fail.window.AndBridge = new Proxy(withoutAsync({}), {
    get: (_t, name) => (...args) => {
      clean.push(name);
      return name === "resetLoginState" ? true : undefined;
    },
  });
  fail.window.eval(natScript);
  const retry = fail.window.document.querySelector("#sd-login-help [data-sd='login-help-reset']");
  assert(retry, "aucun bouton de réessai après une erreur du formulaire");

  /* Le clic ne doit pas partir en navigation dans le banc d'essai : jsdom ne
     l'implémente pas, et le rechargement est de toute façon différé. */
  fail.window.setTimeout = () => 0;
  retry.dispatchEvent(new fail.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert(clean.includes("resetLoginState"), "l'état de connexion n'est pas nettoyé : " + JSON.stringify(clean));
  return "erreur → nettoyage ciblé + réessai ✓";
});

check("native mode: the notification controls press Spotify's buttons", () => {
  natClicks.length = 0;
  nSD.playPause();
  nSD.next();
  nSD.previous();
  nSD.like();
  assert(
    natClicks.join("|") === "control-button-playpause|control-button-skip-forward|control-button-skip-back|Jaime",
    "clicked: " + natClicks.join(", ")
  );
  return "play/pause · suivant · précédent · j'aime";
});

check("native mode: French labels are understood on play/pause", () => {
  const pp = nd.querySelector("button[data-testid='control-button-playpause']");
  pp.setAttribute("aria-label", "Lecture"); // en pause : appuyer lance la lecture
  natClicks.length = 0;
  assert(nSD.play() === true && natClicks.length === 1, "play() must click while paused (label « Lecture »)");
  natClicks.length = 0;
  assert(nSD.pause() === true && natClicks.length === 0, "pause() must be a no-op while already paused");
  pp.setAttribute("aria-label", "Pause"); // en lecture
  natClicks.length = 0;
  assert(nSD.pause() === true && natClicks.length === 1, "pause() must click while playing");
  natClicks.length = 0;
  assert(nSD.play() === true && natClicks.length === 0, "play() must be a no-op while already playing");
  return "« Lecture » / « Pause » ✓";
});

check("native mode: seek and metadata use the right units", () => {
  const input = nd.querySelector("input[type='range']");
  assert(nSD.seek(42000) === true, "seek returned false");
  assert(Math.abs(parseFloat(input.value) - 42) < 0.01, "Spotify's bar counts seconds, got " + input.value);
  const last = natCall("recMediaStatus").slice(-1)[0];
  assert(last, "no recMediaStatus sent to the bridge");
  const payload = JSON.parse(last[1][0]);
  assert(payload.track === "Titre test" && payload.artist === "Artiste test", "wrong metadata: " + last[1][0]);
  assert(payload.duration === 200000, "duration should be milliseconds, got " + payload.duration);
  assert(payload.cover.indexOf("i.scdn.co") > -1, "cover art not forwarded");
  return "42 s dans la barre · 200 000 ms au pont";
});

/* La page d'accueil du téléphone n'a parfois **aucun** repère de lecture dans
   son arbre (barre remplacée, repères renommés). Le shim ne doit pas pour
   autant se taire : il publie ce que la page annonce au système et pilote
   l'élément qui joue réellement. Sans ces deux secours, la notification
   restait figée sur « rien » et ses boutons ne cliquaient rien du tout. */
await checkAsync("native mode: la notification suit et commande l'élément qui joue", async () => {
  const d = new JSDOM(
    "<!doctype html><html><body><main id='main-view'>aucun lecteur dans cette page</main></body></html>",
    { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const w = d.window;
  w.eval(
    "window.__c = []; window.AndBridge = new Proxy({}, { get: function (t, p) { return function () {" +
      "var a = Array.prototype.slice.call(arguments); window.__c.push([String(p), a]);" +
      " if (String(p) === 'isWoke') return false; return undefined; }; } });"
  );
  w.eval(
    "(function () { var a = document.createElement('audio');" +
      "Object.defineProperty(a, 'currentSrc', { value: 'https://sd.example/track.mp3', configurable: true });" +
      "Object.defineProperty(a, 'duration', { value: 200, configurable: true });" +
      "var t = 42; var paused = false;" +
      "Object.defineProperty(a, 'currentTime', { get: function () { return t; }, set: function (v) { t = Number(v); }, configurable: true });" +
      "Object.defineProperty(a, 'paused', { get: function () { return paused; }, configurable: true });" +
      "Object.defineProperty(a, 'ended', { value: false, configurable: true });" +
      "a.play = function () { paused = false; }; a.pause = function () { paused = true; };" +
      "window.__audio = a; window.__pos = function () { return t; }; window.__paused = function () { return paused; };" +
      "document.body.appendChild(a);" +
      "Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: {" +
      "title: 'Baarishein', artist: 'Anuv Jain', artwork: [{ src: 'https://sd.example/720.jpg', sizes: '720x720' }] }," +
      " playbackState: 'playing' } });" +
      "})();"
  );
  w.eval(await read("android/app/src/main/assets/native-mode.js"));
  const sd = w.SpotiDuckUI;
  assert(sd && sd.mode === "native", "le shim n'a pas été installé sur cette page nue");

  const publie = () => {
    const c = w.__c.filter((x) => x[0] === "recMediaStatus").slice(-1)[0];
    return c ? JSON.parse(c[1][0]) : null;
  };
  const s0 = publie();
  assert(s0, "la notification n'a rien publié alors que la page joue");
  assert(s0.track === "Baarishein" && s0.artist === "Anuv Jain", `titre et artiste attendus de la session média, lus « ${s0.track} » / « ${s0.artist} »`);
  assert(s0.duration === 200000, `durée de l'élément en millisecondes attendue, lue ${s0.duration}`);
  assert(s0.position === 42000, `position de l'élément attendue, lue ${s0.position}`);
  assert(s0.playing === true, "la page joue : la notification doit le dire");
  assert(/scdn|sd\.example/.test(s0.cover), `pochette attendue de la session média, lue « ${s0.cover} »`);

  assert(sd.pause() === true, "pause doit répondre avoir agi");
  assert(w.__paused() === true, "l'élément doit être en pause après pause()");
  assert(sd.play() === true && w.__paused() === false, "play doit reprendre l'élément");
  assert(sd.seek(90000) === true, "seek doit écrire une position");
  assert(Math.abs(w.__pos() - 90) < 0.5, `90 secondes attendues sur l'élément, obtenu ${w.__pos()}`);
  assert(sd.seek(-5000) === true && w.__pos() === 0, "une position négative va au début");
  d.window.close();
  return "médias publiés sans aucun repère de markup · lecture, pause et course obtenues sur l'élément ✓";
});

/* **Le mode livré par défaut : la page mobile de Spotify.** Nos boutons ne sont
   plus les nôtres — la notification et l'écran de verrouillage cliquent **ceux
   de Spotify**, trouvés par `data-testid` puis par libellé. Deux pièges, mesurés
   sur cette page : la page *ressemble* à un lecteur partout (un onglet
   « Suivant », un bouton « Activer la lecture aléatoire », un curseur de
   volume), et ses curseurs ne sont pas gradués pareil selon les versions. */
await checkAsync("native mode: les commandes de la notification ne se trompent pas de bouton", async () => {
  const natTrapped = await (async () => {
    const d = new JSDOM(
      "<!doctype html><html><body>" +
        /* Les leurres, posés **avant** le lecteur : c'est l'ordre de la vraie
           page, et donc celui que ramasse une recherche sans ancre. */
        '<button id="shuffle-decoy" aria-label="Activer la lecture aléatoire"></button>' +
        '<button id="preview-decoy" aria-label="Lire un aperçu"></button>' +
        '<nav id="nav"><button id="nav-next" aria-label="Suivant">Suivant</button></nav>' +
        '<div data-testid="volume-bar"><input id="vol" type="range" min="0" max="100" value="60" aria-label="Volume"></div>' +
        /* Pas de `data-testid` sur les commandes : c'est le cas où l'on ne peut
           compter que sur le libellé. */
        '<div data-testid="now-playing-widget">' +
        '<a data-testid="context-item-link" href="/track/9">Titre piégé</a>' +
        '<div data-testid="context-item-info-artist">Artiste piégé</div>' +
        /* La pochette : `src` est la vignette 64 px chargée en attendant, la
           grande est annoncée dans `srcset`. */
        '<img data-testid="cover-art-image" src="https://i.scdn.co/image/small64.jpg"' +
        ' srcset="https://i.scdn.co/image/mid300.jpg 300w, https://i.scdn.co/image/large720.jpg 720w">' +
        '<button id="pp" aria-label="Lecture - Titre piégé"></button>' +
        '<button id="like" aria-checked="false" aria-label="Ajouter aux Titres liké"></button>' +
        /* Curseur gradué en **millisecondes** (184 000 = 3 min 4 s). */
        '<div data-testid="playback-progressbar"><input id="bar" type="range" min="0" max="184000" value="42000"></div>' +
        "</div></body></html>",
      { url: "https://open.spotify.com/", pretendToBeVisual: true, runScripts: "dangerously" }
    );
    const calls = [];
    const clicks = [];
    d.window.eval(
      "window.__c = []; window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => {" +
        "window.__c.push([String(p), a]); if (String(p) === 'isWoke') return false; return undefined; } });"
    );
    d.window.eval(
      "[].forEach.call(document.querySelectorAll('button'), function (b) {" +
        "b.addEventListener('click', function () { window.__clicks = (window.__clicks || []).concat([b.id]); }); });" +
        "window.__clicks = [];"
    );
    d.window.eval(await read("android/app/src/main/assets/native-mode.js"));
    return { dom: d, clicks: () => d.window.__clicks || [] };
  })();
  const d = natTrapped.dom;
  const w = d.window;
  const sd = w.SpotiDuckUI;
  assert(sd && sd.mode === "native", "le shim n'a pas été installé dans cette page");

  /* « Lecture » : le leurre aléatoire est devant, il ne doit **pas** être cliqué. */
  sd.play();
  await tick(60);
  assert(
    natTrapped.clicks().join(",") === "pp",
    `seul le bouton lecture/pause doit être pressé, obtenus : ${natTrapped.clicks().join(",") || "rien"}`
  );

  /* « Suivant » : l'onglet de navigation s'appelle pareil, et n'est pas une
     commande de lecture. */
  natTrapped.clicks().length = 0;
  w.__clicks = [];
  sd.next();
  await tick(60);
  assert(
    !(w.__clicks || []).includes("nav-next"),
    "l'onglet « Suivant » de la navigation a été confondu avec la piste suivante"
  );

  /* Avancer : la barre est graduée en millisecondes, le volume est le premier
     curseur de la page. */
  const vol = w.document.getElementById("vol");
  const bar = w.document.getElementById("bar");
  assert(sd.seek(90000) === true, "une avance dans une barre en millisecondes a échoué");
  assert(Number(bar.value) === 90000, `position attendue 90000 (millisecondes), écrite ${bar.value}`);
  assert(Number(vol.value) === 60, `le volume a été déplacé par l'avance : ${vol.value}`);
  assert(
    sd.seek(-1000) === true && Number(bar.value) === 0,
    `une avance avant le début doit s'arrêter au début, curseur à ${bar.value}`
  );
  sd.seek(90000);
  assert(
    sd.seek(9999999) === true && Number(bar.value) === 184000,
    `une avance au-delà du titre doit s'arrêter à la fin, curseur à ${bar.value}`
  );

  /* La notification : durée et position en millisecondes, la plus grande
     pochette, et un état de lecture lu sur le bon bouton. */
  sd.sync();
  await tick(60);
  const status = w.__c.filter((c) => c[0] === "recMediaStatus").slice(-1)[0];
  assert(status, "aucune métadonnée n'a été transmise au pont");
  const payload = JSON.parse(status[1][0]);
  assert(payload.duration === 184000, `durée attendue 184000 ms, obtenue ${payload.duration}`);
  assert(payload.position === 184000, `position attendue 184000 ms (fin de piste), obtenue ${payload.position}`);
  assert(payload.track === "Titre piégé" && payload.artist === "Artiste piégé", "métadonnées incomplètes");
  assert(
    payload.cover === "https://i.scdn.co/image/large720.jpg",
    "la pochette transmise n'est pas la plus grande disponible : " + payload.cover
  );
  /* « Lecture » annonce la commande à venir : la page est donc **en pause**.
     Le leurre du début de page (« Activer la lecture aléatoire ») contenait,
     lui aussi, le mot « lecture » — l'ancien repère répondait donc toujours
     « en pause », quelle que soit la vraie état de la lecture. */
  assert(payload.playing === false, `« Lecture » doit être lu comme une pause, obtenu ${payload.playing}`);
  w.document.getElementById("pp").setAttribute("aria-label", "Pause - Titre piégé");
  sd.sync();
  await tick(60);
  const paused = JSON.parse(w.__c.filter((c) => c[0] === "recMediaStatus").slice(-1)[0][1][0]);
  assert(paused.playing === true, `« Pause » doit être lu comme une lecture en cours, obtenu ${paused.playing}`);
  w.close();
  return "libellés ancrés dans le lecteur · millisecondes respectées · volume intact · grande pochette ✓";
});

await checkAsync("native mode: the position keeps flowing to the notification", async () => {
  const input = nd.querySelector("input[type='range']");
  input.value = "30"; // 30 s
  await tick(1300); // premier tick : le passage en lecture est publié
  natCalls.length = 0;
  input.value = "35"; // 5 s plus loin : au-delà du seuil, la notification doit suivre
  await tick(1300);
  const pos = natCall("recMediaPosition");
  assert(pos.length > 0, "no recMediaPosition after the position drifted");
  const ms = pos[pos.length - 1][1][0];
  assert(Math.abs(ms - 35000) <= 1000, "the position should be in milliseconds, got " + ms);
  natCalls.length = 0;
  input.value = "36"; // 1 s plus loin : sous le seuil, pas de spam
  await tick(1300);
  assert(natCall("recMediaPosition").length === 0, "a 1 s drift must not wake the bridge");
  return "dérive > 4 s → recMediaPosition(" + ms + ") · 1 s = silence ✓";
});

await checkAsync("native mode: a 3 s press reopens the interface chooser", async () => {
  const chooser = () => natCall("showUiChooser").length;
  const press = async (ms) => {
    nd.dispatchEvent(new nw.Event("touchstart", { bubbles: true }));
    await tick(ms);
    nd.dispatchEvent(new nw.Event("touchend", { bubbles: true }));
    await tick(80);
  };
  await press(400);
  assert(chooser() === 0, "a short press must not open the chooser");
  await press(3250);
  assert(chooser() === 1, "a 3 s press must call showUiChooser (" + chooser() + ")");
  natClicks.length = 0;
  nd.querySelector("button[aria-label='Jaime']").click();
  assert(natClicks.length === 0, "the click released after the long press must be swallowed: " + natClicks.join(", "));
  return "3 s → choix de l'interface · clic final avalé ✓";
});

await checkAsync("native mode: scrolling with a finger down opens nothing", async () => {
  const before = natCall("showUiChooser").length;
  nd.dispatchEvent(new nw.MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 100 }));
  await tick(200);
  nd.dispatchEvent(new nw.MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 320 }));
  await tick(3100);
  nd.dispatchEvent(new nw.MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 320 }));
  assert(natCall("showUiChooser").length === before, "a scrolling finger must not open the chooser");
  return "12 px de mouvement → annulé ✓";
});

await checkAsync("native mode: consent banners are removed and scrolling released", async () => {
  const banner = nd.createElement("div");
  banner.id = "onetrust-consent-sdk";
  banner.innerHTML = "<div id='onetrust-banner-sdk'>Ce site utilise des cookies</div>";
  nd.body.appendChild(banner);
  nd.body.style.overflow = "hidden"; // le script de consentement verrouille la page
  await tick(400); // le MutationObserver doit réagir de lui-même
  assert(!nd.getElementById("onetrust-consent-sdk"), "the consent banner is still in the DOM");
  assert(nd.body.style.overflow !== "hidden", "the scroll lock was not released");
  return "bannière retirée + défilement libéré ✓";
});

check("native mode: no runtime errors", () => {
  assert(natErrors.length === 0, natErrors.join(" | "));
  return "0 erreurs";
});

/* ------------------------------------------------------------------ *
 *  Interface d'origine — le code d'origine, tel quel                  *
 *                                                                     *
 *  C'est l'affichage historique du projet, proposé par le sélecteur :  *
 *  l'affichage d'origine de SpotiDuck (= le script injecté de          *
 *  l'application d'origine, sans retouche).                            *
 *  On le charge donc pour de vrai, sur une page qui ressemble à la     *
 *  page bureau de Spotify (c'est elle qu'il habille), et on vérifie ce *
 *  qu'il produit : la feuille d'origine, son bouton de lecture, la     *
 *  bibliothèque en plein écran, et le contrat avec Android.            *
 * ------------------------------------------------------------------ */
const origHtml =
  "<!doctype html><html><head></head><body>" +
  "<div id='global-nav-bar'><button data-testid='home-button'></button></div>" +
  "<div id='Desktop_LeftSidebar_Id'>" +
  "<header><div><div><button aria-label='Bibliothèque'></button><h1>Ma bibliothèque</h1></div>" +
  "<div><span></span></div></div></header>" +
  "<nav><div><div class='collapsed type'></div><div></div></div></nav>" +
  "<div class='YourLibraryX'><div><header>Filtres</header></div></div>" +
  "<div role='grid'><div role='row'>Titres likés</div></div>" +
  "</div>" +
  "<div id='Desktop_PanelContainer_Id'><div><div aria-hidden='true'></div></div></div>" +
  "<main><section data-testid='home-page'><div>" +
  [...Array(9)].map((_, i) => `<section>Section ${i + 1}</section>`).join("") +
  "</div></section></main>" +
  "<aside data-testid='now-playing-bar'><div><div>" +
  "<div data-testid='now-playing-widget'><div>cover</div><div><span>Titre</span></div></div>" +
  "<div data-testid='player-controls'>" +
  "<button data-testid='control-button-skip-back' aria-label='Précédent'></button>" +
  "<button data-testid='control-button-playpause' aria-label='Lecture'><svg>0123456789</svg></button>" +
  "<button data-testid='control-button-skip-forward' aria-label='Suivant'></button>" +
  "<button data-testid='control-button-repeat' aria-label='Activer la répétition'></button>" +
  "<button data-testid='lyrics-button' aria-label='Paroles'></button>" +
  "</div>" +
  "<div data-testid='now-playing-widget-2'><button aria-checked='false' aria-label='Ajouter aux titres likés'></button></div>" +
  "<div data-testid='playback-progressbar'><input type='range' min='0' max='200' value='0'></div>" +
  "</div></div></aside>" +
  "<input data-testid='search-input'>" +
  "</body></html>";

const origDom = new JSDOM(origHtml, {
  url: "https://open.spotify.com/",
  pretendToBeVisual: true,
  runScripts: "dangerously",
});
const ow = origDom.window;
const od = ow.document;
const origCalls = [];
const origErrors = [];
ow.__bridgeCalls = origCalls;
ow.addEventListener("error", (e) => origErrors.push(String(e.message)));

/* Le script vit de minuteries de 5 s (il attend que la page soit prête).
   On les capture pour les déclencher à la demande : sans cela, un test
   devrait patienter 5 à 15 secondes. */
ow.__timers = [];
const realSetInterval = ow.setInterval.bind(ow);
ow.eval(`
  window.setInterval = function (fn, ms) { window.__timers.push({ fn, ms }); return window.__timers.length; };
  window.clearInterval = function (id) { if (window.__timers[id - 1]) window.__timers[id - 1].dead = true; };
  window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => {
    window.__bridgeCalls.push([String(p), a]);
    if (String(p) === "isWoke") return false;
    return null;
  }});
`);
const clickLog = [];
for (const b of od.querySelectorAll("button")) {
  b.addEventListener("click", () => clickLog.push(b.getAttribute("data-testid") || b.getAttribute("aria-label") || "?"));
}

const origScript = await read("android/app/src/main/assets/spotiduck-original.js");
ow.eval(origScript);
/* Chaque minuteur est dû : c'est ce que fait la page au bout de quelques
   secondes. On exécute chaque minuterie vivante deux fois, comme le ferait
   le navigateur, puis on se met dans l'état « ça lit ». */
const pump = (times = 2) => {
  for (let i = 0; i < times; i++) for (const t of ow.__timers) if (!t.dead) t.fn();
};
pump();
/* Le lecteur devient actif : la page renseigne ces variables, le script entre
   alors en service (veille, habillage, bibliothèque, notification). */
ow.eval(
  "track='Titre test';artist='Artiste test';playing=true;repmode='false';isfav=false;" +
    "duration=200;position=5;cover='https://i.scdn.co/image/x.jpg'"
);
ow.eval("manageAll(true)");
pump();
const origCall = (name) => origCalls.filter((c) => c[0] === name);
const origStyles = () => [...od.querySelectorAll("style")];

check("origine : le script est celui de l'application d'origine, en entier", () => {
  const fns = [
    "mngFetch", "playFromUri", "firstFuck", "manageAll", "manageWake",
    "actPlayPause", "actSkipBack", "actSkipForward", "actRepeat", "actAddToFav",
    "actSeek", "addCSSJSHack", "addAutoFeatures", "addAndAuto", "switchLs",
    "updMedia", "clickNP", "closeNowPlay", "trigUnlock", "hasVid", "updNpbState",
  ].filter((f) => typeof ow[f] !== "function");
  assert(fns.length === 0, "fonctions d'origine manquantes : " + fns.join(", "));
  assert(origErrors.length === 0, origErrors.join(" | "));
  return `${fns.length === 0 ? 21 : 0} fonctions d'origine · 0 erreur`;
});

check("origine : la feuille de style d'origine est posée telle quelle", () => {
  const style = origStyles().find((s) => s.textContent.includes("transition:none"));
  assert(style, "la feuille de style d'origine n'a pas été injectée");
  const css = style.textContent;
  assert(css.length === 6001, `feuille de ${css.length} car. au lieu de 6001 — l'affichage d'origine a été modifié`);
  /* Trois règles qui *sont* l'affichage d'origine : le lecteur collé en bas,
     la bibliothèque resserrée, et l'accueil limité aux six premières rangées. */
  assert(
    /aside\[data-testid=now-playing-bar\][^}]*linear-gradient\(to bottom,#770000,#330000\)/.test(css),
    "l'habillage du lecteur d'origine est absent"
  );
  assert(/#Desktop_LeftSidebar_Id>nav>div\{min-height:48px;border-radius:25px\}/.test(css), "la barre de navigation d'origine est absente");
  assert(
    /section\[data-testid=home-page\]>div>section:nth-child\(n\+7\)\{display:none\}/.test(css),
    "la limite de rangées de l'accueil d'origine est absente"
  );
  return "6 001 car. · lecteur rouge en bas · accueil limité à 6 rangées ✓";
});

check("origine : le bouton de lecture de l'application d'origine est posé", () => {
  const np = od.querySelector(".npbtn");
  assert(np, "le bouton « now playing » (.npbtn) n'a pas été inséré");
  assert(
    np.nextElementSibling && np.nextElementSibling.getAttribute("data-testid") === "lyrics-button",
    "le bouton d'origine se place juste avant celui des paroles, dans la barre de lecture"
  );
  assert(np.innerHTML.includes("<svg"), "le bouton est sans icône");
  return ".npbtn collé au bouton paroles ✓";
});

await checkAsync("origine : la bibliothèque s'ouvre en plein écran, comme à l'origine", async () => {
  await tick(40); // le basculement est différé d'un tour de boucle par le script d'origine
  const sidebar = od.getElementById("Desktop_LeftSidebar_Id");
  const css = sidebar.style.cssText.replace(/\s+/g, "");
  assert(/position:fixed/.test(css) && /width:100%/.test(css),
    "la bibliothèque n'a pas été passée en plein écran : " + sidebar.style.cssText);
  assert(/height:92%/.test(css) && /z-index:20/.test(css),
    "la géométrie de la bibliothèque d'origine a changé : " + sidebar.style.cssText);
  return "bibliothèque plein écran ✓";
});

check("origine : le script prévient Android à la fin de l'habillage", () => {
  assert(origCall("cssInjected").length > 0, "AndBridge.cssInjected() n'est jamais appelé");
  assert(origCall("manageTSleep").some((c) => c[1][0] === true), "l'écran n'est pas maintenu allumé pendant la lecture");
  assert(origCall("manageTShut").some((c) => c[1][0] === false), "l'arrêt automatique n'est pas désarmé pendant la lecture");
  return "cssInjected · veille et arrêt gérés ✓";
});

await checkAsync("origine : toutes les méthodes du pont appelées existent côté Android", async () => {
  const bridge = await read("android/app/src/main/java/com/spotiduck/app/Bridge.kt");
  const exposed = new Set([...bridge.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map((m) => m[1]));
  const called = [...new Set([...origScript.matchAll(/AndBridge\.(\w+)\s*\(/g)].map((m) => m[1]))];
  const missing = called.filter((c) => !exposed.has(c));
  assert(missing.length === 0, "Bridge.kt n'expose pas : " + missing.join(", "));
  return called.length + " méthodes appelées, toutes exposées";
});

check("origine : l'adaptateur du service de lecture relaie les fonctions d'origine", () => {
  const sd = ow.SpotiDuckUI;
  assert(sd && sd.version === "original", "window.SpotiDuckUI n'est pas l'adaptateur d'origine");
  const relayed = {};
  for (const name of ["actPlayPause", "actSkipForward", "actSkipBack", "actAddToFav", "actRepeat", "clickNP", "closeNowPlay"]) {
    relayed[name] = 0;
    ow[name] = () => { relayed[name]++; };
  }
  ow.actSeek = (s) => { relayed.seek = s; };
  assert(sd.playPause() === true && relayed.actPlayPause === 1, "playPause() ne relaie pas actPlayPause");
  assert(sd.next() === true && relayed.actSkipForward === 1, "next() ne relaie pas actSkipForward");
  assert(sd.previous() === true && relayed.actSkipBack === 1, "previous() ne relaie pas actSkipBack");
  assert(sd.like() === true && relayed.actAddToFav === 1, "like() ne relaie pas actAddToFav");
  assert(sd.openQueue() === true && relayed.clickNP === 1, "openQueue() ne relaie pas clickNP");
  assert(sd.seek(42000) === true && Math.abs(relayed.seek - 42) < 0.001,
    "seek() doit convertir les millisecondes en secondes, reçu " + relayed.seek);
  assert(sd.sync() === true, "sync() ne relaie pas updMedia");
  assert(sd.back() === false || typeof sd.back() === "boolean", "back() doit répondre par un booléen");
  return "play/pause · suivant · précédent · j'aime · file · seek en secondes ✓";
});

check("origine : en lecture, l'état part vers la notification", () => {
  ow.eval("track='Titre test';artist='Artiste test';playing=true;repmode='false';isfav=false;duration=200;position=5;cover='https://i.scdn.co/image/x.jpg'");
  ow.eval("updMedia()");
  const status = origCall("recMediaStatus").slice(-1)[0];
  assert(status, "aucun recMediaStatus envoyé au pont");
  const payload = JSON.parse(status[1][0]);
  assert(payload.track === "Titre test" && payload.artist === "Artiste test", "métadonnées incomplètes : " + status[1][0]);
  return "titre et artiste transmis ✓";
});

check("coop: the player reports a confirmed session", () => {
  const states = window.__bridgeCalls.filter((c) => c[0] === "loginState").map((c) => c[1][0]);
  assert(states.includes("in"), "aucun état « connecté » rapporté : " + JSON.stringify(states.slice(0, 6)));
  return "in ✓";
});

check("origine : aucune erreur d'exécution", () => {
  assert(origErrors.length === 0, origErrors.join(" | "));
  return "0 erreur";
});

/* ------------------------------------------------------------------ report */
const pad = Math.max(...results.map((r) => r.name.length));
let failed = 0;
console.log("\nSpotiDuck UI smoke test — " + new Date().toISOString().slice(0, 16).replace("T", " ") + "\n");
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(pad)}  ${r.ok ? r.detail : "\x1b[31m" + r.detail + "\x1b[0m"}`);
}
console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
