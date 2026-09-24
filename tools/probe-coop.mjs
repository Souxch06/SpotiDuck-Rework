#!/usr/bin/env node
/**
 * Sonde de la coque — la charge sur la **vraie** page de Spotify, dans un vrai
 * Chrome, et dit ce qu'elle devient.
 *
 *     node tools/probe-coop.mjs        (depuis la CI : le runner a Chrome)
 *
 * Pourquoi cette sonde existe : `npm run smoke` vérifie la coque sur une page
 * **factice** (`demo/mock/spotify.js`). Une page factice ne dit rien de la page
 * réelle — c'est exactement l'angle mort dans lequel l'utilisateur est tombé
 * deux fois de suite :
 *
 *   · « le bouton ne fait rien, je suis bloqué à la connexion » ;
 *   · « les boutons ne sont pas comme notre version, rien n'est relié à
 *     aucune action ».
 *
 * Ce que la sonde relève, dans l'ordre où l'application le fait :
 *
 *   1. l'identité (`src/original/spotiduck-identity.js`) au **début** du
 *      chargement, avant que la page ne lise quoi que ce soit ;
 *   2. la coque (`dist/spotiduck-ui.js`) à la **fin** du chargement (`onPageFinished`) ;
 *   3. puis, sur la page : la coque est-elle construite (`.sd-layer`, classe
 *      `sd-mobile`, onglets) ? ses styles sont-ils appliqués (position, taille
 *      réelle de la barre) ? **un appui sur un onglet produit-il une action** ?
 *      et **quelles erreurs** la page a-t-elle levées ?
 *
 * Ne lève jamais : tout part en annotations (quatre au maximum — GitHub
 * tronque au-delà) et dans /tmp/probe-coop/rapport.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

const OUT = "/tmp/probe-coop";
mkdirSync(OUT, { recursive: true });

const report = { at: new Date().toISOString(), pages: [] };

const clean = (text, max = 700) => String(text).replace(/\s+/g, " ").slice(0, max);
const note = (title, text) => {
  const line = clean(text, 1800);
  console.log(`::notice title=${title}::${line}`);
  console.log(`[Sonde coque] ${title} — ${line}`);
};
const warn = (title, text) => {
  const line = clean(text, 1800);
  console.log(`::warning title=${title}::${line}`);
  console.log(`[Sonde coque] ⚠ ${title} — ${line}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Ce que la sonde va interroger sur chaque page. Renvoie un objet plat : tout
   ce qui peut expliquer « les boutons ne font rien ». */
const MEASURE = async () => {
  const out = {};
  const root = document.documentElement;
  out.url = location.href;
  out.classes = root.className;
  out.namespace = typeof window.SpotiDuckUI;
  out.layer = !!document.querySelector(".sd-layer");
  out.layerChildren = [...document.querySelectorAll(".sd-layer > *")].map((el) => el.className).slice(0, 12);
  out.tabs = [...document.querySelectorAll(".sd-tab")].map((el) => (el.textContent || "").trim().slice(0, 24));
  out.tabHrefs = [...document.querySelectorAll(".sd-tab")].map((el) => el.getAttribute("href") || el.dataset.route || "");
  out.styles = [...document.querySelectorAll("style")].length;
  out.cssBytes = [...document.querySelectorAll("style")].reduce((n, el) => n + (el.textContent || "").length, 0);

  /* Les styles sont-ils *appliqués* ? Une coque construite mais non stylée est
     exactement ce que décrit « les boutons ne sont pas comme notre version ». */
  const tabbar = document.querySelector(".sd-tabbar");
  if (tabbar) {
    const cs = getComputedStyle(tabbar);
    const rect = tabbar.getBoundingClientRect();
    out.tabbar = { position: cs.position, display: cs.display, bottom: cs.bottom, h: Math.round(rect.height), w: Math.round(rect.width), visible: rect.height > 0 && rect.width > 0 };
  } else {
    out.tabbar = null;
  }
  const mini = document.querySelector(".sd-mini");
  if (mini) {
    const cs = getComputedStyle(mini);
    const rect = mini.getBoundingClientRect();
    out.mini = { position: cs.position, display: cs.display, h: Math.round(rect.height), visible: rect.height > 0 };
  } else {
    out.mini = null;
  }

  /* La page réelle : le lecteur est-il là (donc la session) ? */
  out.desktopLayout = {
    barreLaterale: !!document.querySelector("#Desktop_LeftSidebar_Id"),
    barreLecture: !!document.querySelector('[data-testid="now-playing-bar"]'),
    mainView: !!document.querySelector("#main-view"),
    accueil: !!document.querySelector('[data-testid="home-page"]'),
    connexion: !!document.querySelector('[data-testid="login-form"], #login-username'),
  };
  out.title = document.title.slice(0, 80);
  return out;
};

/** Un appui réel sur un onglet, et ce qu'il déclenche. */
const CLICK_TAB = async (index) => {
  const tabs = [...document.querySelectorAll(".sd-tab")];
  const tab = tabs[index];
  if (!tab) return { clicked: false, reason: `onglet ${index} absent (${tabs.length} trouvés)` };
  const before = location.pathname;
  tab.click();
  await new Promise((r) => setTimeout(r, 900));
  return {
    clicked: true,
    label: (tab.textContent || "").trim().slice(0, 24),
    href: tab.getAttribute("href") || "",
    route: tab.dataset.route || "",
    pathBefore: before,
    pathAfter: location.pathname,
    tapRecorded: (window.__sdNavTap && (window.__sdNavTap.route || window.__sdNavTap.forced)) || null,
    changed: before !== location.pathname,
  };
};

async function main() {
  let puppeteer = null;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    warn("Chrome", "puppeteer-core absent — npm install --no-save puppeteer-core@23");
    return;
  }

  const { readFileSync } = await import("node:fs");
  const identity = readFileSync("src/original/spotiduck-identity.js", "utf8");
  const bundle = readFileSync("dist/spotiduck-ui.js", "utf8");
  note("Fichiers", `identité ${(identity.length / 1024).toFixed(1)} Ko · coque ${(bundle.length / 1024).toFixed(1)} Ko`);

  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  let browser = null;
  const launchErrors = [];
  for (const executablePath of candidates) {
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--lang=fr-FR", "--window-size=412,915"],
      });
      note("Chrome", `pilote ouvert avec ${executablePath}`);
      break;
    } catch (error) {
      launchErrors.push(`${executablePath} : ${String((error && error.message) || error).slice(0, 160)}`);
    }
  }
  if (!browser) {
    warn("Chrome", `aucun navigateur pilotable — ${launchErrors.join(" · ")}`);
    return;
  }

  const pages = [
    { label: "lecteur connecté ou accueil", url: "https://open.spotify.com/" },
    { label: "page de connexion", url: "https://accounts.spotify.com/fr/login?allow_password=1" },
  ];

  const lines = [];

  for (const target of pages) {
    const page = await browser.newPage();
    const errors = [];
    const warnings = [];
    page.on("pageerror", (error) => errors.push(String(error && error.message).slice(0, 300)));
    page.on("console", (message) => {
      const text = `${message.type()}: ${message.text()}`;
      if (message.type() === "error") errors.push(text.slice(0, 300));
      else if (message.type() === "warning") warnings.push(text.slice(0, 200));
    });

    try {
      /* 1. l'identité, avant tout — comme l'application. */
      await page.evaluateOnNewDocument(identity);
      await page.evaluateOnNewDocument(() => {
        /* Le meta viewport que l'application pose aussi (`VIEWPORT_META_JS`) :
           la coque compte sur une largeur de mise en page = largeur d'écran. */
        const CONTENT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
        const put = () => {
          const root = document.head || document.documentElement;
          if (!root) return;
          let meta = document.querySelector("meta[name='viewport']");
          if (!meta) {
            meta = document.createElement("meta");
            meta.setAttribute("name", "viewport");
            root.appendChild(meta);
          }
          meta.setAttribute("content", CONTENT);
        };
        put();
        document.addEventListener("DOMContentLoaded", put);
        setTimeout(put, 1200);
      });

      await page.setUserAgent(DESKTOP_UA);
      await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: false, hasTouch: true });

      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(6000);

      const before = await page.evaluate(MEASURE);

      /* 2. la coque, à la fin du chargement — comme `onPageFinished`. */
      await page.evaluate(bundle);
      await sleep(3500);

      const after = await page.evaluate(MEASURE);
      const click = await page.evaluate(CLICK_TAB, 2); /* l'onglet Bibliothèque */
      const afterClick = await page.evaluate(MEASURE);

      const entry = { label: target.label, url: target.url, before, after, click, afterClick, errors, warnings };
      report.pages.push(entry);

      /* --- ce qu'on en dit, en une ligne par page ------------------------- */
      const summary =
        `${target.label} → coque=${after.layer ? "construite" : "ABSENTE"} / classes="${after.classes}" / ` +
        `namespace=${after.namespace} / onglets=${after.tabs.length} [${after.tabs.join(", ")}] / ` +
        `barre=${after.tabbar ? `${after.tabbar.position} ${after.tabbar.w}×${after.tabbar.h}px ${after.tabbar.visible ? "visible" : "INVISIBLE"}` : "absente"} / ` +
        `styles=${after.styles} (${after.cssBytes} car.) / layout=${Object.entries(after.desktopLayout).filter(([, v]) => v).map(([k]) => k).join("+") || "aucun"} / ` +
        `appui=${click.clicked ? `« ${click.label} » ${click.changed ? "navigue" : "NE NAVIGUE PAS"} (tap=${JSON.stringify(click.tapRecorded)})` : click.reason}`;
      lines.push(summary);
      console.log(`[Sonde coque] ${summary}`);
    } catch (error) {
      lines.push(`${target.label} → ÉCHEC : ${String(error && error.message).slice(0, 200)}`);
      report.pages.push({ label: target.label, url: target.url, failure: String(error && error.message) });
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (lines.length) note("La coque sur la vraie page", lines.join("  ||  "));

  const allErrors = report.pages.flatMap((p) => (p.errors || []).map((e) => `${p.label}: ${e}`));
  if (allErrors.length) warn("Erreurs de la page", allErrors.slice(0, 6).join("  ||  "));
  else note("Erreurs de la page", "aucune");

  await browser.close().catch(() => {});
  writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  console.log(`[Sonde coque] rapport écrit dans ${OUT}/rapport.json`);
}

main().catch((error) => {
  warn("Sonde coque", `interrompue : ${String((error && error.stack) || error)}`);
  try {
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  } catch {
    /* rien de plus à faire */
  }
});
