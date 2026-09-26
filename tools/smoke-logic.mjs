#!/usr/bin/env node
/**
 * Le moteur de lecture d'origine, **testé comme il tourne**.
 *
 *     node tools/smoke-logic.mjs      (inclus dans `npm run smoke`)
 *
 * `dist/spotiduck-logic.js` est du code copié, pas réécrit : il ne peut donc
 * pas être jugé sur sa forme, seulement sur ce qu'il **fait**. Ce fichier le
 * charge dans un faux navigateur (une `document` minuscule, un `AndBridge` qui
 * enregistre, un `fetch` qui joue le rôle de la page Spotify) et vérifie les
 * quatre choses pour lesquelles il est là :
 *
 *   1. le capteur lit l'identifiant d'appareil, le `Client-Token`, le `Bearer`
 *      et l'URI en cours **dans le trafic de la page** ;
 *   2. `playFromUri` commande à l'API Connect **par le pont** (`nFetch`), avec
 *      l'appareil capté, `endpoint: play`, `license: tft` ;
 *   3. `manageAll` (la machine d'état) pilote veille et minuteries et ne répète
 *      pas un rapport déjà envoyé ;
 *   4. les commandes `act*` restent muettes plutôt que fausses quand la page
 *      n'a pas de bouton — et un `fetch` ordinaire de la page n'est **jamais**
 *      détourné vers le pont.
 *
 * Chacune de ces règles a été écrite pour un défaut vécu : la coque qui ne
 * trouvait plus le markup, le « player vérouillé » qui ne se débloquait qu'au
 * rechargement, une notification qui répétait l'état à chaque tick.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "dist/spotiduck-logic.js"), "utf8");

const results = [];
const ok = (name, cond, detail = "") =>
  results.push({ name, pass: !!cond, detail: String(detail).slice(0, 200) });

/* ------------------------------------------------------------------ *
 * Le décor : assez de DOM pour que les blocs d'origine s'y comportent
 * comme dans la page, et rien d'autre.
 * ------------------------------------------------------------------ */
const clicks = [];
const bySel = new Map();
class FakeEl {
  constructor(tag, testid) {
    this.tagName = tag.toUpperCase();
    this._testid = testid || "";
    this.disabled = false;
    this.value = 0;
    this.style = {};
    this.dataset = {};
    this._svg = { innerHTML: "x".repeat(200) }; /* icône « en pause » = à jouer */
    this.classList = {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
    };
  }
  querySelector() { return this._svg; }
  addEventListener(k, fn) { (this._h ||= {})[k] = fn; }
  appendChild(c) { return c; }
  insertBefore(c) { return c; }
  setAttribute() {}
  getAttribute() { return null; }
  click() { clicks.push(this._testid || this.tagName); }
  dispatchEvent() { return true; }
}

function makeSandbox() {
  const bridge = [];
  const doc = {
    visibilityState: "visible",
    querySelector: (sel) => bySel.get(sel) || null,
    querySelectorAll: () => [],
    createElement: (t) => new FakeEl(t),
    addEventListener() {},
    removeEventListener() {},
    documentElement: new FakeEl("html"),
    head: new FakeEl("head"),
    body: new FakeEl("body"),
  };
  const win = {
    document: doc,
    AndBridge: {
      nFetch: (url, body) => {
        bridge.push({ kind: "nFetch", url, body });
        return Promise.resolve(JSON.stringify({ status: 200, body: "{}", headers: {} }));
      },
      deferMessage: (m) => bridge.push({ kind: "deferMessage", m }),
      wakeUp: () => bridge.push({ kind: "wakeUp" }),
      wakeOff: () => bridge.push({ kind: "wakeOff" }),
      isWoke: () => false,
      manageTShut: (v) => bridge.push({ kind: "manageTShut", v }),
      manageTSleep: (v) => bridge.push({ kind: "manageTSleep", v }),
      recMediaStatus: (j) => bridge.push({ kind: "recMediaStatus", j: JSON.parse(j) }),
      recMediaPosition: (p) => bridge.push({ kind: "recMediaPosition", p }),
      playLoaded: () => bridge.push({ kind: "playLoaded" }),
    },
    location: { pathname: "/playlist/37i9dQZF1DXcBWIGoYBM5M", reload: () => bridge.push({ kind: "reload" }) },
    navigator: { userAgent: "fake" },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 0,
    Headers: Map,
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    Event: function (t) { this.type = t; },
    KeyboardEvent: function () {},
    MouseEvent: function () {},
  };
  /* La page, vue de l'intérieur : un `fetch` que le moteur va envelopper. */
  const pageCalls = [];
  win.fetch = async (url, opts) => {
    pageCalls.push({ url, opts });
    return { status: 200, ok: true, headers: new Map(), text: async () => "{}", json: async () => ({}) };
  };
  return { win, bridge, pageCalls, doc };
}

/* **Le contexte est le navigateur.** L'original écrit `window.playFromUri = …`
   et se relit ensuite par le nom nu (`manageWake(true)`, `playing`) : ça ne
   fonctionne que parce que `window` **est** l'objet global. Un harnais qui passe
   `window` en paramètre d'une fonction verrait ces noms être `undefined` — et un
   test vert dans ce harnais-là ne prouverait rien. On contexte donc un vrai
   objet global, où `this.window === this`. */
function load(sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext("this.window = this; this.self = this; this.top = this;", ctx);
  vm.runInContext(src, ctx, { filename: "dist/spotiduck-logic.js" });
  return ctx;
}

/* ------------------------------------------------------------------ 1 · capteur */
{
  bySel.clear(); clicks.length = 0;
  const { win, pageCalls } = makeSandbox();
  const w = load(win);
  ok("moteur chargé", w.SpotiDuckLogic && w.SpotiDuckLogic.version === "1", "window.SpotiDuckLogic");
  const names = ["hasVid", "mngFetch", "playFromUri", "manageWake", "trigUnlock", "actPlayPause", "actSkipBack", "actSkipForward", "actRepeat", "actAddToFav", "actSeek", "manageAll", "updMedia"];
  ok("les treize fonctions d'origine sont là", names.every((n) => typeof w[n] === "function"), names.filter((n) => typeof w[n] !== "function").join(", "));

  await w.fetch("https://api.spotify.com/v1/me/token", { headers: { "Client-Token": "TOK-CLIENT", Authorization: "Bearer TOK-AUTH" } });
  await w.fetch("https://spclient.wg.spotify.com/track-playback/v1/devices", {
    method: "POST",
    body: JSON.stringify({ device: { device_id: "DEV42" } }),
  });
  await w.fetch("https://spclient.wg.spotify.com/pathfinder/v2/query", {
    method: "POST",
    body: JSON.stringify({ operationName: "isCurated", variables: { uris: ["spotify:album:79dLY"] } }),
  });
  const t = w.SpotiDuckLogic.tokens();
  ok("appareil capté dans le trafic de la page", t.device === "DEV42", JSON.stringify(t));
  ok("jetons capturés (sans les recopier)", String(t.client).startsWith("TOK-CLI") && String(t.auth).endsWith("AUTH"), JSON.stringify(t));
  ok("URI en cours capté", t.uri === "spotify:album:79dLY", String(t.uri));
  ok("un fetch ordinaire de la page n'est pas détourné", pageCalls.length === 3, `${pageCalls.length} appels reçus par la page`);
}

/* ------------------------------------------------------------------ 2 · playFromUri */
{
  bySel.clear(); clicks.length = 0;
  const { win, bridge } = makeSandbox();
  const w = load(win);
  await w.fetch("https://spclient.wg.spotify.com/track-playback/v1/devices", {
    method: "POST", body: JSON.stringify({ device: { device_id: "DEV9" } }),
  });
  const sent = w.SpotiDuckLogic.playUri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
  ok("la commande est acceptée par le moteur", sent === true);
  const call = bridge.find((b) => b.kind === "nFetch");
  const url = call ? call.url : "";
  ok("elle part par le pont, pas par le réseau de la page", !!call && /connect-state\/v1\/player\/command\/from\/DEV9\/to\/DEV9/.test(url), url);
  let cmd = null, method = null;
  try { const opts = JSON.parse(call.body); method = opts.method; cmd = JSON.parse(opts.body).command; } catch (e) {}
  ok("corps de commande conforme à l'origine",
    cmd && cmd.endpoint === "play" && cmd.context.uri === "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M" && cmd.options.license === "tft" && method === "POST",
    JSON.stringify({ method, endpoint: cmd && cmd.endpoint, uri: cmd && cmd.context.uri, license: cmd && cmd.options.license }));
  ok("aucun clic de bouton pour démarrer", clicks.length === 0, clicks.join(","));
}

/* ------------------------------------------------------------------ 3 · manageAll */
{
  bySel.clear(); clicks.length = 0;
  const { win, bridge } = makeSandbox();
  const w = load(win);
  w.SpotiDuckLogic.feed({ track: "Nightcall", artist: "Kavinsky", duration: 257, position: 1, cover: "c.png", repeat: "false", liked: true });
  w.SpotiDuckLogic.setPlaying(true);
  const media = bridge.filter((b) => b.kind === "recMediaStatus");
  ok("l'état est rapporté à Android", media.length === 1 && media[0].j.track === "Nightcall" && media[0].j.playing === true, JSON.stringify(media[0] && media[0].j));
  const timers = bridge.filter((b) => /^manageT/.test(b.kind)).map((b) => `${b.kind}:${b.v}`);
  ok("veille et arrêt automatique suivent la lecture",
    timers.includes("manageTShut:false") && timers.includes("manageTSleep:true"), timers.join(" "));
  w.SpotiDuckLogic.setPlaying(true);
  ok("deux fois le même état ne font pas deux rapports",
    bridge.filter((b) => b.kind === "recMediaStatus").length === 1, `${bridge.filter((b) => b.kind === "recMediaStatus").length} rapports`);
  w.SpotiDuckLogic.setPlaying(false);
  ok("la pause rend l'arrêt automatique possible",
    bridge.filter((b) => b.kind === "manageTShut").slice(-1)[0].v === true);
}

/* ------------------------------------------------------------------ 4 · commandes */
{
  bySel.clear(); clicks.length = 0;
  const { win, bridge } = makeSandbox();
  const w = load(win);
  /* Boutons absents : les sauts se taisent (l'original garde son `if`), et
     `actSeek` **lève** — mesuré, pas supposé : il écrit directement sur le
     curseur, sans le vérifier. C'est pour ça que la coque n'appelle jamais un
     `act*` à nu : sa porte avale et répond faux. */
  let threw = null;
  try { w.actSkipForward(); w.actSkipBack(); } catch (e) { threw = String(e.message || e); }
  ok("sauter sans bouton : muet, et pas blessant", threw === null && clicks.length === 0, String(threw));
  threw = null;
  try { w.actSeek(10); } catch (e) { threw = String(e.message || e); }
  ok("curseur absent : actSeek lève dans l'original", threw !== null, "le harnais laisserait passer une régression");
  ok("…et la porte de la coque l'avale", w.SpotiDuckLogic.call("actSeek", 10) === false, String(threw));

  /* L'original ne lit aucun attribut d'état : il **mesure l'icône** du bouton
     (icône large = rien ne joue, icône étroite = ça joue) et ne presse que ce
     qui manque. Ces deux assertions sont la raison de le garder. */
  const play = new FakeEl("button", "playpause");
  play._svg.innerHTML = "x".repeat(200);
  bySel.set("aside button[data-testid=control-button-playpause]:not(.fuckd)", play);
  w.SpotiDuckLogic.feed({ pBtn: play });
  ok("playLoaded demandé à Android, une seule fois",
    bridge.filter((b) => b.kind === "playLoaded").length === 1,
    `${bridge.filter((b) => b.kind === "playLoaded").length} appels`);
  /* Le jugé est celui de l'original, **repris tel quel** : icône courte et
     demande de jouer → il presse ; icône longue et demande de pause → il
     presse ; sinon il ne touche à rien. Ce qui est vérifié ici, c'est la
     mécanique — un « si » qui sauterait ferait presser le bouton à l'envers. */
  w.SpotiDuckLogic.call("actPlayPause", true);
  ok("icône longue + « jouer » → il ne presse pas", clicks.length === 0, clicks.join(","));
  play._svg.innerHTML = "xx";
  w.SpotiDuckLogic.call("actPlayPause", true);
  ok("icône courte + « jouer » → il presse le bouton de Spotify", clicks.length === 1, clicks.join(","));
  clicks.length = 0;
  w.SpotiDuckLogic.call("actPlayPause", false);
  ok("icône courte + « pause » → il ne presse pas", clicks.length === 0, clicks.join(","));
  play._svg.innerHTML = "x".repeat(200);
  w.SpotiDuckLogic.call("actPlayPause", false);
  ok("icône longue + « pause » → il presse", clicks.length === 1, clicks.join(","));
  const skip = new FakeEl("button", "skip-forward");
  bySel.set("button[data-testid=control-button-skip-forward]", skip);
  w.actSkipForward();
  ok("sauter presse le bouton de la page", clicks.includes("skip-forward"), clicks.join(","));
}

/* ------------------------------------------------------------------ 5 · la porte de la coque */
{
  bySel.clear(); clicks.length = 0;
  const { win } = makeSandbox();
  load(win);
  /* Sans appareil capté, l'original construirait une URL `from/undefined/to/
     undefined` : la commande partirait dans le vide et **masquerait** le secours
     de la coque. D'où la porte, vérifiée dans la source livrée. */
  const shell = readFileSync(join(root, "dist/spotiduck-ui.js"), "utf8");
  ok("la coque refuse de commander sans appareil capté",
    /if \(!e\.tokens\(\)\.device\) return false;/.test(shell), "porte absente de la coque");
  /* L'ordre des secours est la décision, pas un détail : la voie de l'API ne
     peut pas couper court aux deux voies vérifiées de la coque. */
  const order = [
    shell.indexOf("Engine.toggle(want)"),
    shell.indexOf("this.mediaToggle(go === null"),
    shell.indexOf("return Engine.playContext()"),
  ];
  ok("coque : markup → moteur → élément → API, dans cet ordre",
    order.every((n) => n > 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
  ok("coque : un appui du moteur n'est cru réussi que s'il a pressé",
    /addEventListener\("click", spy, true\)[\s\S]{0,200}return pressed;/.test(shell),
    "sans ce spy, `actPlayPause` répond vrai même sans presser");
  ok("coque : la commande API ne se fait jamais passer pour un succès",
    /e\.playUri\(uri\);\s*return false;/.test(shell));
  /* Et le capteur ne doit **pas** détourner le trafic de la page : c'est ce
     détourage (flux d'état du lecteur via `HttpURLConnection`, sans
     `AbortSignal`) qui rendait toutes les touches du bas muettes. */
  ok("moteur : le capteur écoute, il n'intercepte pas",
    !/resp\s*=\s*await mngFetch\(url,opts\)/.test(src) && /return oriFetch\.apply\(this, args\);/.test(src),
    "la page doit rester maître de ses requêtes");
  ok("l'état mesuré est bien repassé au moteur à chaque appui",
    /Engine\.feed\(\);\n\s*if \(!Spotify\.playPause\(want\)\)/.test(shell));
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "✓" : "✗"} ${r.name}${r.pass ? "" : "  → " + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} assertions du moteur d'origine\n`);
process.exit(failed.length ? 1 : 0);
