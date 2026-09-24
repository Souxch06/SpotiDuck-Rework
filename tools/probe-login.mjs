#!/usr/bin/env node
/**
 * Sonde de connexion — pilote un vrai Chrome (mode sans tête) via CDP pour
 * répondre à des questions qu'aucune capture d'écran ne peut trancher :
 *
 *   • la page de connexion de Spotify, vue par l'agent de l'application,
 *     propose-t-elle un champ mot de passe, ou seulement les boutons sociaux ?
 *   • `?allow_password=1` mène-t-il encore à un formulaire utilisable ?
 *   • que répond Google quand on clique « Continuer avec Google » : la page
 *     d'autorisation, ou un refus (« disallowed_useragent ») ?
 *
 * Ne lève jamais : tout constat est publié en annotation et écrit dans
 * /tmp/probe-login/rapport.json. Lancer de préférence depuis la CI (le runner a
 * Chrome) : `npm install --no-save puppeteer-core` puis `node tools/probe-login.mjs`.
 */

import { mkdirSync, writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Mobile Safari/537.36";

const OUT = "/tmp/probe-login";
const report = { at: new Date().toISOString(), ua: UA, steps: [] };

const note = (title, text) => {
  const line = String(text).replace(/\s+/g, " ").slice(0, 700);
  console.log(`::notice title=${title}::${line}`);
  console.log(`[Sonde] ${title} — ${line}`);
};
const warn = (title, text) => {
  console.log(`::warning title=${title}::${String(text).replace(/\s+/g, " ").slice(0, 700)}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Charge Chrome depuis le runner ou l'environnement. */
async function launch(puppeteer) {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  let lastError = null;
  for (const executablePath of candidates) {
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--lang=fr-FR",
          "--window-size=412,915",
        ],
      });
      return browser;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("aucun Chrome trouvé");
}

/** Ce que la page propose à l'utilisateur, tel quel. */
async function describe(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none";
    };
    const textOf = (el) => (el.innerText || el.textContent || "").trim().slice(0, 80);
    const clickable = [...document.querySelectorAll("button,a,[role='button'],input[type='submit']")]
      .filter(visible)
      .map(textOf)
      .filter((t) => t.length > 0);
    const labels = [...document.querySelectorAll("label")].filter(visible).map(textOf);
    return {
      title: document.title,
      url: location.href,
      passwordFields: document.querySelectorAll("input[type='password']").length,
      emailFields: document.querySelectorAll("input[type='email'],input[name='username'],input[autocomplete='username']").length,
      inputs: [...document.querySelectorAll("input")].filter(visible).map((i) => ({
        type: i.type, name: i.name, placeholder: i.placeholder,
      })),
      buttons: clickable.slice(0, 40),
      labels: labels.slice(0, 20),
      hasRecaptcha: /recaptcha|grecaptcha/i.test(document.documentElement.innerHTML),
      bodyStart: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      forms: [...document.querySelectorAll("form")].map((f) => ({
        action: f.getAttribute("action") || "(courant)", method: f.method,
        fields: [...f.querySelectorAll("input")].map((i) => i.name || i.type),
      })),
    };
  });
}

/** Clique le bouton dont le texte parle de Google, et suit ce qui s'ouvre. */
async function clickGoogle(browser, page) {
  const clicked = await page.evaluate(() => {
    const wanted = /google/i;
    const els = [...document.querySelectorAll("button,a,[role='button'],div[role='button'],iframe")]
      .filter((el) => {
        if (el.tagName === "IFRAME") return /google/i.test(el.src || el.title || "");
        const t = (el.innerText || el.textContent || "").trim();
        const aria = el.getAttribute("aria-label") || "";
        return wanted.test(t) || wanted.test(aria);
      });
    const el = els[0];
    if (!el) return null;
    const label = el.tagName === "IFRAME"
      ? `iframe ${el.src || el.title}`
      : (el.innerText || el.textContent || "").trim().slice(0, 60);
    el.scrollIntoView({ block: "center" });
    el.click();
    return { tag: el.tagName, label };
  });

  if (!clicked) {
    return { clicked: false, reason: "aucun bouton Google visible dans la page principale" };
  }

  const before = browser.targets().length;
  await sleep(9000);

  const pages = await browser.pages();
  const targets = browser.targets().filter((t) => t.type() === "page" || t.type() === "other");
  const opened = targets.filter((t) => /google|apple|facebook/i.test(t.url())).map((t) => t.url());

  // Ce que la page principale est devenue (navigation de premier niveau ?).
  const main = { url: page.url(), title: await page.title().catch(() => "") };
  let mainBody = "";
  try {
    mainBody = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400));
  } catch (e) {}

  // Une fenêtre ouverte par la page (pop-up) ?
  let popup = null;
  for (const p of pages) {
    if (p === page) continue;
    const u = p.url();
    if (!u || u === "about:blank") continue;
    popup = {
      url: u,
      title: await p.title().catch(() => ""),
      body: await p.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400)).catch(() => ""),
    };
  }

  const blocked = /disallowed_useragent|doesn't comply|does not comply|ne respecte pas|n'est pas conforme|pas autorisé/i;
  return { clicked: true, openedTargets: opened, newTargets: targets.length - before, main, mainBody, popup, blocked: blocked.test(mainBody) || (popup && blocked.test(popup.body || "")) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let puppeteer = null;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch (e) {
    warn("Pilote CDP absent", "puppeteer-core n'est pas installé : la sonde navigateur est sautée");
    return;
  }

  let browser = null;
  try {
    browser = await launch(puppeteer);
    note("Chrome", await browser.version());

    const pages = [];
    for (const [name, url] of [
      ["moderne", "https://accounts.spotify.com/fr/login"],
      ["classique", "https://accounts.spotify.com/fr/login?allow_password=1"],
      ["lecteur", "https://open.spotify.com/login"],
    ]) {
      const page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
      const console_ = [];
      page.on("console", (m) => {
        if (m.type() === "error") console_.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => console_.push("pageerror: " + String(e).slice(0, 200)));

      let status = null;
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        status = res ? res.status() : null;
        await sleep(7000); // le formulaire est monté par JavaScript
      } catch (e) {
        warn(`Page « ${name} » injoignable`, String(e));
      }

      const info = await describe(page).catch((e) => ({ error: String(e) }));
      const step = { name, url, status, ...info, consoleErrors: console_.slice(0, 8) };
      report.steps.push(step);
      pages.push({ name, page, info });
      note(
        `Connexion « ${name} »`,
        `code ${status} · mot de passe ${info.passwordFields} · e-mail ${info.emailFields} · reCAPTCHA ${info.hasRecaptcha ? "oui" : "non"} · boutons : ${(info.buttons || []).join(" / ")}`
      );
      note(`Formulaires « ${name} »`, JSON.stringify(info.forms || []));
    }

    // Le clic qui décide de tout : « Continuer avec Google » depuis la page
    // moderne. Si Google refuse, on le voit ici, avec ses mots.
    const modern = pages.find((p) => p.name === "moderne");
    if (modern) {
      const result = await clickGoogle(browser, modern.page).catch((e) => ({ error: String(e) }));
      report.googleClick = result;
      note("Clic Google", JSON.stringify(result).slice(0, 900));
      if (result && result.blocked) {
        warn("Google refuse la connexion", `refus détecté — ${JSON.stringify(result).slice(0, 600)}`);
      }
    }
  } catch (e) {
    warn("Sonde navigateur interrompue", String(e));
    report.error = String(e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
    console.log(`[Sonde] rapport écrit dans ${OUT}/rapport.json`);
  }
}

main().catch((e) => {
  warn("Sonde navigateur : erreur non rattrapée", String(e));
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  } catch (err) {}
});
