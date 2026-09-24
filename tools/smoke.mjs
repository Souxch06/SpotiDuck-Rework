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

await checkAsync("interface size setting scales the whole shell", async () => {
  SD.openSettings();
  await tick(60);
  const sheet = q(".sd-sheet-settings");
  try {
    const seg = sheet.querySelector('[data-seg="density"]');
    assert(seg, "density segment missing from the settings sheet");
    const u = () =>
      parseFloat(window.getComputedStyle(doc.documentElement).getPropertyValue("--sd-u"));
    /* jsdom does not evaluate calc() for custom properties, so the check reads
       the scale factor itself — the tokens multiply by it (verified below). */
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
 * c'est le mode par défaut depuis la 2.5.0.
 * ------------------------------------------------------------------ */
const natHtml =
  '<!doctype html><html><head></head><body>' +
  '<div data-testid="banner">Ouvrir dans l\'application</div>' +
  '<a href="/download">Telecharger l\'application</a>' +
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
