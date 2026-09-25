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
  q('.sd-tab[data-tab="library"]').click();
  await tick();
  assert(doc.documentElement.classList.contains("sd-tab-library"), "sd-tab-library not set");
  assert(q(".sd-topbar").classList.contains("is-visible"), "top bar should be visible on the library");
  assert(q(".sd-topbar-title").textContent === "Bibliothèque", "title: " + q(".sd-topbar-title").textContent);
  return "top bar + class ✓";
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
  await tick(120);
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

await checkAsync("gesture: swipe left on the mini player = next track", async () => {
  const before = window.MockSpotify.track.title;
  const mini = q(".sd-mini");
  const mk = (type, x, y) => new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  mini.dispatchEvent(mk("pointerdown", 300, 400));
  for (let i = 1; i <= 6; i++) mini.dispatchEvent(mk("pointermove", 300 - i * 20, 400));
  mini.dispatchEvent(mk("pointerup", 180, 400));
  await tick(150);
  assert(window.MockSpotify.track.title !== before, "track did not change");
  return before + " → " + window.MockSpotify.track.title;
});

await checkAsync("full player opens, drag down closes it", async () => {
  q(".sd-mini").click();
  await tick(60);
  assert(doc.documentElement.classList.contains("sd-player-open"), "player did not open");
  const head = q(".sd-player-head");
  const mk = (type, y) => new window.MouseEvent(type, { bubbles: true, clientX: 180, clientY: y });
  head.dispatchEvent(mk("pointerdown", 100));
  for (let i = 1; i <= 6; i++) head.dispatchEvent(mk("pointermove", 100 + i * 40));
  head.dispatchEvent(mk("pointerup", 340));
  await tick(80);
  assert(!doc.documentElement.classList.contains("sd-player-open"), "player did not close on drag");
  return "open → drag 240px → closed";
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
  window.AndBridge = new Proxy({}, { get: (t, p) => (...a) => { seen.push(String(p)); return String(p) === "openPlayProtect"; } });
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
  await tick(120);
  const pos = SD.state.position;
  assert(pos >= 4000 && pos <= 9000, "seek() did not move the position, got " + pos + " ms");
  return "play/pause idempotent · seek " + Math.round(pos / 1000) + " s";
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

await checkAsync("a native dialog makes our chrome step back", async () => {
  const modal = doc.createElement("div");
  modal.setAttribute("role", "dialog");
  doc.body.appendChild(modal);
  await tick(300);
  assert(doc.documentElement.classList.contains("sd-native-modal"), "sd-native-modal not set");
  modal.remove();
  await tick(300);
  assert(!doc.documentElement.classList.contains("sd-native-modal"), "sd-native-modal not cleared");
  return "ours fades, dialog keeps the taps ✓";
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
  host.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  bare.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
    { get: (t, p) => (...a) => { calls.push([String(p), a]); return undefined; } }
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
  /* Les deux sont collées en haut : quand la barre de navigation est là, la
     barre de titre est dessous — invisible, donc « rien ne s'affiche ». */
  const src = await read("src/inject/spotiduck-ui.js");
  assert(
    /var navOn = !isSubPage && !isLibrary;/.test(src),
    "la barre de navigation et la barre de titre se recouvrent encore"
  );
  return "navigation (accueil/recherche) · titre (bibliothèque/sous-page) ✓";
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  assert(sum.bands.evening === 6, `le soir devrait compter 6 écoutes, ${sum.bands.evening}`);
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
  dom.window.close();
  return "6 écoutes · 3 artistes · parts, série, moments et découvertes exacts ✓";
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  assert(tiles.length === 6, `six tuiles attendues, ${tiles.length} trouvée(s)`);
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
  return "6 tuiles · 7 jours · artistes · moments, sans rangée de Spotify ✓";
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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

  /* Les filtres filtrent pour de vrai. */
  const chips = [...page.querySelectorAll(".sd-chip")];
  assert(chips.length === 3, "les trois filtres ne sont pas là");
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
    probe.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  dom.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  w.AndBridge = { version: () => "2.11.3", session: () => false };
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
  assert(/SpotiDuck 2\.11\.3/.test(diag), "le diagnostic n'annonce pas la version de l'application : " + diag);
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
  device.window.AndBridge = new Proxy({}, { get: () => () => undefined });
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
  { get: (t, p) => (...a) => { coopLoginCalls.push([String(p), a]); return undefined; } }
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
lw.AndBridge = new Proxy({}, { get: () => () => {} });
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
  home.window.AndBridge = new Proxy({}, { get: () => () => {} });
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
  lw.AndBridge = new Proxy({}, { get: (_t, name) => (...args) => sent.push([name, args[0]]) });

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
  player.window.AndBridge = new Proxy({}, { get: (_t, name) => (...args) => sent.push([name, args[0]]) });
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
  out.window.AndBridge = new Proxy({}, { get: (_t, name) => (...args) => sent.push([name, args[0]]) });
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
  fail.window.AndBridge = new Proxy({}, {
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
