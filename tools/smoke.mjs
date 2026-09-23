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

await checkAsync("tab bar can be disabled without leaving a floating mini player", async () => {
  SD.set("tabbar", false);
  await tick(40);
  assert(doc.documentElement.classList.contains("sd-no-tabbar"), "sd-no-tabbar missing");
  SD.set("tabbar", true);
  await tick(40);
  assert(!doc.documentElement.classList.contains("sd-no-tabbar"), "sd-no-tabbar not removed");
  return "class toggled ✓";
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
