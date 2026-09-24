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

  /* Chaque contrôle de la coque : présent ? visible (vraie boîte) ? cliquable ?
     « Les boutons ne sont pas comme notre version » se mesure ici : un contrôle
     à 0×0 px ou sous `display:none` est un contrôle que l'utilisateur ne voit
     pas, et « rien n'est relié » commence toujours par là. */
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "absent";
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
    return `${visible ? "visible" : "MASQUÉ"} ${Math.round(rect.width)}×${Math.round(rect.height)} pos=${cs.position} z=${cs.zIndex}`;
  };
  out.controls = {
    "barre du haut (.sd-nav)": box(".sd-nav"),
    "onglet Bibliothèque (.sd-nav-item)": box('.sd-nav-item[data-tab="library"]'),
    "barre du bas (.sd-tabbar)": box(".sd-tabbar"),
    "mini-lecteur (.sd-mini)": box(".sd-mini"),
    "en-tête (.sd-topbar)": box(".sd-topbar"),
    "lecteur plein écran (.sd-player)": box(".sd-player"),
  };
  /* Ce qu'il reste du chrome de Spotify : s'il est encore là ET que le nôtre
     ne l'est pas, l'utilisateur voit des boutons de Spotify — « pas comme
     notre version ». */
  out.spotifyChrome = {
    barreLaterale: box("#Desktop_LeftSidebar_Id"),
    barreHaute: box('[data-testid="topbar-content"]'),
    navGlobale: box("#global-nav-bar"),
    barreLecture: box('[data-testid="now-playing-bar"]'),
  };

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

/** L'état intérieur de la coque — ce que ses boutons sont censés changer. */
const SHELL_STATE = () => {
  const api = window.SpotiDuckUI;
  const sidebar = document.querySelector("#Desktop_LeftSidebar_Id");
  const cs = sidebar ? getComputedStyle(sidebar) : null;
  const rect = sidebar ? sidebar.getBoundingClientRect() : null;
  return {
    path: location.pathname,
    classes: document.documentElement.className.split(/\s+/).filter((c) => c.indexOf("sd-") === 0).join(" "),
    stateTab: api && api.state ? api.state.tab : null,
    route: api && api.state ? api.state.route : null,
    sidebarDisplay: cs ? cs.display : "absente",
    sidebarBox: rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : "-",
    recherche: !!document.querySelector('[data-testid="search-page"]'),
    accueil: !!document.querySelector('[data-testid="home-page"]'),
    dialogue: !!document.querySelector('[role="dialog"]'),
    erreurs: (window.__sdProbeErrors || []).slice(0, 4),
  };
};

/** Un appui réel sur un contrôle, et ce qu'il déclenche. */
const CLICK = async (selector) => {
  const el = document.querySelector(selector);
  if (!el) return { clicked: false, reason: `${selector} absent` };
  const before = location.pathname;
  const disabled = el.disabled === true;
  el.click();
  /* 1 500 ms : la coque reprend la navigation elle-même au bout d'une seconde
     si le routeur de Spotify n'a pas bougé (voir son propre garde-fou). */
  await new Promise((r) => setTimeout(r, 1500));
  return {
    clicked: true,
    selector,
    label: (el.textContent || "").trim().slice(0, 24),
    disabled,
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
    { label: "accueil", url: "https://open.spotify.com/" },
    { label: "connexion", url: "https://accounts.spotify.com/fr/login?allow_password=1" },
  ];

  const lines = [];
  const shots = [];

  /* Toute mesure est tolérante : un appui peut **naviguer** (c'est même ce
     qu'on espère), et une page qui navigue détruit le contexte d'exécution.
     Sans ce garde-fou, la moindre navigation faisait tomber toute la sonde —
     ce qui est arrivé, et masquait justement le résultat intéressant. */
  const safely = async (fn, ...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const message = String((error && error.message) || error);
      return { erreur: message.slice(0, 140), navigation: /context was destroyed|Execution context/i.test(message) };
    }
  };

  for (const target of pages) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error && error.message).slice(0, 240)));
    page.on("console", (message) => {
      if (message.type() === "error" && !/Google Analytics|sandboxed/i.test(message.text())) {
        errors.push(message.text().slice(0, 240));
      }
    });

    try {
      await page.evaluateOnNewDocument(identity);
      await page.evaluateOnNewDocument(() => {
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

      const before = await safely(() => page.evaluate(MEASURE));

      /* La coque, à la fin du chargement — comme `onPageFinished`. */
      await safely(() => page.evaluate(bundle));
      await sleep(3500);

      const after = await safely(() => page.evaluate(MEASURE));
      await safely(() =>
        page.evaluate(() => {
          window.__sdProbeErrors = [];
          window.addEventListener("error", (e) => window.__sdProbeErrors.push(String(e.message).slice(0, 200)));
        })
      );

      /* Une miniature téléchargeable depuis les annotations (les artefacts ne
         sont pas joignables ici) : l'écran réduit, JPEG qualité 35. */
      const miniature = async (name) => {
        try {
          await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 0.5, isMobile: false, hasTouch: true });
          await sleep(400);
          const buffer = await page.screenshot({ type: "jpeg", quality: 22 });
          shots.push(`SHOT:${target.label}-${name}:${buffer.toString("base64")}`);
          await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: false, hasTouch: true });
          await sleep(200);
        } catch (error) {
          shots.push(`SHOT:${target.label}-${name}:echec ${String((error && error.message) || error).slice(0, 60)}`);
        }
      };

      await miniature("coque");

      /* Les trois vues de la barre du haut : état intérieur + ce que la page
         affiche, avant et après un appui réel. */
      const navEffects = [];
      for (const name of ["library", "search", "home"]) {
        const stateBefore = await safely(() => page.evaluate(SHELL_STATE));
        await safely(() => page.evaluate(CLICK, `.sd-nav-item[data-tab="${name}"]`));
        await sleep(600);
        const stateAfter = await safely(() => page.evaluate(SHELL_STATE));
        navEffects.push({ name, before: stateBefore, after: stateAfter });
        /* (pas de capture à chaque vue : chaque image coûte des morceaux
           d'annotation, et GitHub n'en garde qu'une poignée) */
      }

      lines.push(
        `${target.label} → coque=${after && after.layer ? "construite" : after && after.erreur ? `mesure impossible (${after.erreur})` : "ABSENTE"} / ` +
          `styles=${after && after.cssBytes ? after.cssBytes : "?"} car. / ` +
          `CONTRÔLES : ${after && after.controls ? Object.entries(after.controls).map(([k, v]) => `${k}=${v}`).join(" · ") : "?"} | ` +
          `RESTE DE SPOTIFY : ${after && after.spotifyChrome ? Object.entries(after.spotifyChrome).map(([k, v]) => `${k}=${v}`).join(" · ") : "?"} | ` +
          `LES TROIS VUES : ${navEffects
            .map(
              (e) =>
                `${e.name}→ tab=${e.after && e.after.stateTab} chemin=${e.after && e.after.path} ` +
                `barreLatérale=${e.after && e.after.sidebarDisplay}/${e.after && e.after.sidebarBox} ` +
                `recherche=${e.after && e.after.recherche ? "oui" : "non"} accueil=${e.after && e.after.accueil ? "oui" : "non"}` +
                (e.after && e.after.navigation ? " (la page a navigué)" : "") +
                (e.after && e.after.erreurs && e.after.erreurs.length ? ` ERREURS=${JSON.stringify(e.after.erreurs)}` : "")
            )
            .join("  ·  ")}`
      );
      console.log(`[Sonde coque] ${lines[lines.length - 1]}`);

      report.pages.push({ label: target.label, url: target.url, before, after, navEffects, errors });
      if (errors.length) warn(`Erreurs — ${target.label}`, errors.slice(0, 5).join("  ||  "));
    } catch (error) {
      lines.push(`${target.label} → ÉCHEC : ${String((error && error.message) || error).slice(0, 200)}`);
      report.pages.push({ label: target.label, url: target.url, failure: String((error && error.message) || error) });
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (lines.length) note("La coque sur la vraie page", lines.join("  ||  "));

  /* Les miniatures : encodées dans les annotations, parce que les artefacts ne
     sont pas joignables depuis tous les environnements. Une annotation est
     coupée net à 1 800 caractères (mesuré), donc chaque image part en morceaux :
     `SHOT:<nom>:<morceau>/<total>:<base64>`. */
  const CHUNK = 1700;
  for (const shot of shots) {
    const [, name, payload] = shot.split(":");
    if (payload.startsWith("echec")) {
      warn(`Capture — ${name}`, payload);
      continue;
    }
    const total = Math.ceil(payload.length / CHUNK);
    console.log(`[Sonde coque] capture ${name} : ${payload.length} caractères en ${total} morceau(x)`);
    for (let i = 0; i < total; i++) {
      const part = payload.slice(i * CHUNK, (i + 1) * CHUNK);
      note(`Capture ${name} ${i + 1}/${total}`, `SHOT:${name}:${i + 1}/${total}:${part}`);
    }
  }

  const allErrors = report.pages.flatMap((p) => (p.errors || []).map((e) => `${p.label}: ${e}`));
  if (allErrors.length) warn("Erreurs de la page", allErrors.slice(0, 5).join("  ||  "));
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
