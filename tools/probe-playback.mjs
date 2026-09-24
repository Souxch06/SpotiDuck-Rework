#!/usr/bin/env node
/**
 * Sonde de lecture — répond, par la mesure, à la seule question qui décide du
 * correctif : **pourquoi** Spotify affiche à l'application
 *
 *   « Lecture désactivée — Spotify ne fonctionnera pas si vous bloquez le
 *     contenu protégé, si votre navigateur n'est pas compatible ou si vous
 *     utilisez un mode de navigation privée ou incognito. »
 *
 * Ce que fait la sonde, dans l'ordre :
 *
 *   1. elle récupère ce que Spotify sert à un agent **mobile** (celui de
 *      l'application) et à un agent **bureau** : la page, puis tous les
 *      scripts qu'elle référence ;
 *   2. elle cherche dans ces scripts le message exact (français et anglais) et
 *      imprime **le code qui l'entoure** — c'est lui qui dit quelle condition
 *      l'affiche (DRM, agent, mode privé) ;
 *   3. elle pilote un vrai Chrome (mode sans tête) pour relever ce que la page
 *      voit réellement : présence de `requestMediaKeySystemAccess`, résultat de
 *      la demande Widevine pour un flux audio, et forme exacte de
 *      `navigator.userAgentData` — cette dernière sert de référence pour
 *      l'identité que l'application doit présenter.
 *
 * Ne lève jamais : tout constat est publié en annotation et écrit dans
 * /tmp/probe-playback/rapport.json. À lancer depuis la CI (le runner a le
 * réseau et Chrome) : `node tools/probe-playback.mjs`.
 */

import { mkdirSync, writeFileSync } from "node:fs";

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Mobile Safari/537.36";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

/* Les deux jeux de valeurs que Chrome publie à part de l'agent : celui d'un
   téléphone Android, et celui que porte le code d'origine (Windows). */
function metadataAndroid() {
  return {
    brands: [
      { brand: "Chromium", version: "150" },
      { brand: "Google Chrome", version: "150" },
      { brand: "Not?A_Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: "150.0.0.0" },
      { brand: "Google Chrome", version: "150.0.0.0" },
      { brand: "Not?A_Brand", version: "24.0.0.0" },
    ],
    mobile: true,
    model: "Pixel 7",
    platform: "Android",
    platformVersion: "14.0.0",
    architecture: "",
    bitness: "",
    wow64: false,
    formFactor: "Mobile",
  };
}

function metadataWindows() {
  return {
    brands: [
      { brand: "Not;A=Brand", version: "8" },
      { brand: "Chromium", version: "150" },
      { brand: "Google Chrome", version: "150" },
    ],
    fullVersionList: [
      { brand: "Not;A=Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: "150.0.0.0" },
      { brand: "Google Chrome", version: "150.0.0.0" },
    ],
    mobile: false,
    model: "",
    platform: "Windows",
    platformVersion: "10.0.0",
    architecture: "x86",
    bitness: "64",
    wow64: false,
    formFactor: "Desktop",
  };
}

const OUT = "/tmp/probe-playback";
mkdirSync(OUT, { recursive: true });

const report = { at: new Date().toISOString(), ua: MOBILE_UA, files: [], findings: [], browser: [] };

const clean = (text, max = 700) => String(text).replace(/\s+/g, " ").slice(0, max);
const note = (title, text) => {
  const line = clean(text);
  console.log(`::notice title=${title}::${line}`);
  console.log(`[Sonde lecture] ${title} — ${line}`);
};
const warn = (title, text) => {
  const line = clean(text);
  console.log(`::warning title=${title}::${line}`);
  console.log(`[Sonde lecture] ⚠ ${title} — ${line}`);
};

/* ---------------------------------------------------------------- motifs ---
   Chaque motif est une question précise posée au code de Spotify. Le contexte
   imprimé autour de la première occurrence est ce qui permet de lire la
   condition (et non de la deviner). */
const PATTERNS = [
  { name: "message FR exact", re: /Lecture d.\s?sactiv/i },
  { name: "contenu protégé (FR)", re: /contenu prot[ée]g[ée]/i },
  { name: "Playback disabled (EN)", re: /playback disabled/i },
  { name: "protected content (EN)", re: /protected content/i },
  { name: "playback-disabled (repère)", re: /playback[-_ ]?disabled/i },
  { name: "requestMediaKeySystemAccess", re: /requestMediaKeySystemAccess/ },
  { name: "com.widevine.alpha", re: /com\.widevine\.alpha/ },
  { name: "widevine (générique)", re: /widevine/i },
  { name: "EME / média chiffré", re: /encrypted[-_ ]?media|encryptedMedia|mediaKeys/i },
  { name: "config DRM (sessionTypes…)", re: /sessionTypes|persistentState|distinctiveIdentifier/ },
  { name: "codec audio AAC", re: /mp4a\.40\.2/ },
  { name: "licence / clé de contenu", re: /licenseUrl|license_url|keySystem|setMediaKeys/i },
  { name: "compatibilité navigateur", re: /browser[^"'`]{0,24}(not supported|unsupported|compatible)/i },
  { name: "agent (userAgentData)", re: /userAgentData/ },
  { name: "agent (plateforme)", re: /platformVersion/ },
  { name: "navigation privée", re: /incognito|private browsing|priv[ée]e/i },
];

/* --------------------------------------------------------------- réseau --- */
async function grab(url, ua) {
  const res = await fetch(url, {
    headers: {
      "user-agent": ua,
      "accept-language": "fr-FR,fr;q=0.9",
      accept: "*/*",
    },
    redirect: "follow",
  });
  const body = await res.text();
  return { status: res.status, url: res.url, body };
}

/** URLs de scripts référencées par une page, absolues et dédoublonnées. */
function scriptUrls(html, base) {
  const found = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+\.(?:js|json)(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    try {
      found.add(new URL(match[1], base).toString());
    } catch {
      /* référence illisible : on l'ignore */
    }
  }
  return [...found];
}

/* ------------------------------------------------------------ analyse ----- */
function scan(label, url, text) {
  const hits = [];
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.replace("g", "") + "g");
    const contexts = [];
    let match;
    while ((match = re.exec(text)) && contexts.length < 3) {
      contexts.push(text.slice(Math.max(0, match.index - 190), match.index + 190));
      if (match.index === re.lastIndex) re.lastIndex++;
    }
    if (contexts.length === 0) continue;
    const hit = { label, url, name: pattern.name, total: contexts.length, contexts };
    hits.push(hit);
    report.findings.push(hit);
  }
  return hits;
}

/* ------------------------------------------------------------------ main --- */
async function main() {
  const agents = [
    { label: "mobile", ua: MOBILE_UA },
    {
      label: "bureau",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    },
  ];

  const corpus = [];

  for (const agent of agents) {
    let page;
    try {
      page = await grab("https://open.spotify.com/", agent.ua);
    } catch (error) {
      warn(`Page ${agent.label} : injoignable`, error && error.message);
      continue;
    }
    note(`Page ${agent.label} (${page.status}, ${page.body.length} o)`, page.url);
    corpus.push({ label: `page-${agent.label}`, url: page.url, body: page.body });

    /* Les scripts de l'application web : c'est là que vivent le message et sa
       condition. On borne (nombre et taille) pour rester sous la minute. */
    const urls = scriptUrls(page.body, page.url).slice(0, 30);
    note(`Scripts ${agent.label}`, `${urls.length} référence(s) — ${urls.slice(0, 6).join(" ")}`);
    let bytes = 0;
    for (const url of urls) {
      if (bytes > 40 * 1024 * 1024) break;
      try {
        const file = await grab(url, agent.ua);
        bytes += file.body.length;
        corpus.push({ label: `script-${agent.label}`, url, body: file.body });
        report.files.push({ label: `script-${agent.label}`, url, status: file.status, bytes: file.body.length });
      } catch (error) {
        report.files.push({ label: `script-${agent.label}`, url, error: String(error && error.message) });
      }
    }
    note(`Volume ${agent.label}`, `${(bytes / 1024).toFixed(0)} Ko de scripts analysés`);
  }

  /* Le message exact, où qu'il soit : page, script, ou table de traduction. */
  const wanted = [
    { needle: "Lecture désactivée", label: "FR : Lecture désactivée" },
    { needle: "contenu protégé", label: "FR : contenu protégé" },
    { needle: "Ajustez vos paramètres", label: "FR : Ajustez vos paramètres" },
    { needle: "Playback disabled", label: "EN : Playback disabled" },
    { needle: "protected content", label: "EN : protected content" },
  ];
  for (const { needle, label } of wanted) {
    const where = corpus.filter((item) => item.body.includes(needle));
    if (where.length === 0) {
      warn(label, "introuvable dans la page et les scripts servis");
      continue;
    }
    for (const item of where.slice(0, 2)) {
      const at = item.body.indexOf(needle);
      note(`${label} — ${item.label}`, `${item.url} — …${item.body.slice(Math.max(0, at - 220), at + 220)}…`);
    }
  }

  /* Repères techniques, avec le code qui les entoure. */
  const seen = new Set();
  for (const item of corpus) {
    for (const hit of scan(item.label, item.url, item.body)) {
      const key = hit.name + item.label;
      if (seen.has(key)) continue;
      seen.add(key);
      note(`${hit.name} (${item.label})`, `${hit.total} occurrence(s) — …${clean(hit.contexts[0], 520)}…`);
    }
  }

  /* ------------------------------------------------ ce que voit Chrome ---
     Comparaison directe des **deux identités**, dans le même navigateur :

       • celle que l'application envoie aujourd'hui (Chrome Android, sans
         en-têtes de plateforme) ;
       • celle du code d'origine (Chrome Windows **et** les en-têtes
         `sec-ch-ua*` « Windows » qui vont avec, telles que les littéraux
         déchiffrés de l'application d'origine les donnent).

     Deux relevés par scénario : ce que le navigateur offre pour le contenu
     protégé (`requestMediaKeySystemAccess`), et ce que la page affiche —
     bandeau « Lecture désactivée », mise en page bureau ou mobile. */
  const scenarios = [
    { label: "mobile — agent de l'application", ua: MOBILE_UA, metadata: metadataAndroid(), headers: null },
    {
      label: "bureau — agent du code d'origine",
      ua: DESKTOP_UA,
      metadata: metadataWindows(),
      headers: {
        "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-ch-ua-platform-version": '"10.0.0"',
      },
    },
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let puppeteer = null;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    warn("Chrome", "puppeteer-core absent — relevé navigateur ignoré (npm install --no-save puppeteer-core)");
  }
  if (puppeteer) {
    const candidates = [
      process.env.CHROME_PATH,
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter(Boolean);
    for (const executablePath of candidates) {
      let browser = null;
      try {
        browser = await puppeteer.launch({
          executablePath,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--lang=fr-FR", "--window-size=412,915"],
        });
      } catch {
        continue;
      }
      note("Chrome", `pilote ouvert avec ${executablePath}`);
      for (const scenario of scenarios) {
        const page = await browser.newPage();
        try {
          await page.setUserAgent(scenario.ua, scenario.metadata ? { userAgentMetadata: scenario.metadata } : undefined);
          if (scenario.headers) await page.setExtraHTTPHeaders(scenario.headers);
          await page.goto("https://open.spotify.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
          await sleep(10000);
          const probe = await page.evaluate(async () => {
            const out = { href: location.href };
            out.hasRequestMediaKeySystemAccess = typeof navigator.requestMediaKeySystemAccess;
            out.hasMediaKeys = typeof window.MediaKeys;
            try {
              const config = [
                {
                  initDataTypes: ["cenc"],
                  audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
                  sessionTypes: ["temporary"],
                },
              ];
              const access = await navigator.requestMediaKeySystemAccess("com.widevine.alpha", config);
              out.widevineAudio = "ok";
              try {
                const keys = await access.createMediaKeys();
                out.createMediaKeys = keys ? "ok" : "vide";
              } catch (error) {
                out.createMediaKeys = String(error && error.name);
              }
            } catch (error) {
              out.widevineAudio = String((error && error.name) || error);
            }
            out.userAgentData = navigator.userAgentData ? JSON.stringify(navigator.userAgentData) : "absent";
            if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
              try {
                out.highEntropy = JSON.stringify(
                  await navigator.userAgentData.getHighEntropyValues([
                    "architecture",
                    "bitness",
                    "brands",
                    "formFactor",
                    "fullVersionList",
                    "mobile",
                    "model",
                    "platform",
                    "platformVersion",
                    "uaFullVersion",
                    "wow64",
                  ])
                );
              } catch (error) {
                out.highEntropy = String(error && error.name);
              }
            }
            /* Mise en page servie : bureau (barre latérale, barre de lecture
               en bas) ou mobile (page d'accueil mobile). */
            const present = (selector) => !!document.querySelector(selector);
            out.layout = {
              barreLaterale: present("#Desktop_LeftSidebar_Id"),
              barreLecture: present('[data-testid="now-playing-bar"]'),
              accueil: present('[data-testid="home-page"]'),
              recherche: present('[data-testid="search-page"]'),
              barreHaute: present('[data-testid="topbar-content"]'),
            };
            /* Le bandeau, cherché dans le texte de la page entière. */
            const text = (document.body && (document.body.innerText || document.body.textContent)) || "";
            out.bodyLength = text.length;
            const at = text.search(/d[ée]sactiv|contenu prot|protected content|navigateur n.est pas compatible/i);
            out.around = at < 0 ? "" : text.slice(Math.max(0, at - 200), at + 320).replace(/\s+/g, " ");
            return out;
          });
          report.browser.push({ label: scenario.label, ...probe });
          note(
            `Chrome — ${scenario.label} : DRM`,
            `requestMediaKeySystemAccess=${probe.hasRequestMediaKeySystemAccess} · widevine audio=${probe.widevineAudio} · MediaKeys=${probe.hasMediaKeys}`
          );
          note(`Chrome — ${scenario.label} : agent`, `userAgentData=${probe.userAgentData}`);
          if (probe.highEntropy) note(`Chrome — ${scenario.label} : valeurs fines`, probe.highEntropy);
          note(
            `Chrome — ${scenario.label} : mise en page`,
            Object.entries(probe.layout || {})
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(", ") || "aucun repère connu"
          );
          if (probe.around) warn(`Chrome — ${scenario.label} : BANDEAU`, probe.around);
          else note(`Chrome — ${scenario.label} : bandeau`, `aucun « désactivé / protégé » (${probe.bodyLength} caractères de page)`);
        } catch (error) {
          warn(`Chrome — ${scenario.label}`, String(error && error.message));
        } finally {
          await page.close().catch(() => {});
        }
      }
      await browser.close().catch(() => {});
      break;
    }
  }

  writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  console.log(`[Sonde lecture] rapport écrit dans ${OUT}/rapport.json`);
}

main().catch((error) => {
  warn("Sonde lecture", `interrompue : ${String(error && error.stack || error)}`);
  try {
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  } catch {
    /* rien de plus à faire */
  }
});
