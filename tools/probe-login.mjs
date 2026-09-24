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

/** Remplit les champs visibles et clique le bouton de validation. */
async function tryLogin(page, { email, password }) {
  const filled = await page.evaluate(
    (values) => {
      const setValue = (el, value) => {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const pwd = document.querySelector("input[type='password']");
      const mail = document.querySelector(
        "input[type='email'],input[name='username'],input[autocomplete='username'],input[type='text']"
      );
      if (mail) setValue(mail, values.email);
      if (pwd) setValue(pwd, values.password);
      const wanted = /se connecter|continuer|connexion|log in|sign in|suivant/i;
      const buttons = [...document.querySelectorAll("button,[role='button'],input[type='submit']")].filter(
        (b) => wanted.test((b.innerText || b.textContent || "").trim()) && b.getBoundingClientRect().height > 4
      );
      const button = buttons[buttons.length - 1];
      if (button) button.click();
      return { filledMail: !!mail, filledPassword: !!pwd, clicked: button ? (button.innerText || "").trim() : null };
    },
    { email, password }
  );
  await sleep(9000);
  const after = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const alerts = [...document.querySelectorAll("[role='alert'],[aria-live],.error,[data-testid*='error'],[class*='error']")]
      .map((e) => (e.innerText || "").trim())
      .filter((t) => t.length > 3)
      .slice(0, 4);
    return {
      url: location.href,
      title: document.title,
      passwordFields: document.querySelectorAll("input[type='password']").length,
      alerts,
      captcha: /captcha|je ne suis pas un robot|challenge|vérification/i.test(text),
      text: text.slice(0, 400),
    };
  });
  return { filled, ...after };
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
      hasOpener: await p.evaluate(() => !!window.opener).catch(() => null),
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

    // Une vraie tentative de connexion sur chacune des deux pages : c'est le
    // seul moyen de savoir si le chemin e-mail/mot de passe est vivant, et
    // lequel des deux formulaires (moderne, `allow_password=1`) répond
    // correctement à une tentative. Compte de sonde : adresse inexistante,
    // aucun mot de passe réel n'est envoyé.
    const stamp = Date.now();
    for (const [name, values] of [
      ["moderne", { email: `spotiduck-sonde-${stamp}@example.com`, password: "SondeSpotiDuck!42" }],
      ["classique", { email: `spotiduck-sonde-${stamp}@example.com`, password: "SondeSpotiDuck!42" }],
    ]) {
      const target = pages.find((p) => p.name === name);
      if (!target) continue;
      const attempt = await tryLogin(target.page, values).catch((e) => ({ error: String(e) }));
      report[`attempt_${name}`] = attempt;
      note(
        `Tentative « ${name} »`,
        `champs remplis ${JSON.stringify(attempt.filled)} · clic « ${attempt.clicked} » · après : mot de passe ${attempt.passwordFields} · captcha ${attempt.captcha ? "oui" : "non"}`
      );
      note(`Message « ${name} »`, `alertes ${JSON.stringify(attempt.alerts || [])} · texte : ${attempt.text || attempt.error}`);
    }

    // Le clic qui décide de tout : « Continuer avec Google ». Si Google refuse,
    // on le voit ici, avec ses mots. On repart d'une page propre : la tentative
    // de connexion ci-dessus a laissé du texte d'erreur un peu partout.
    const clean = await browser.newPage();
    await clean.setUserAgent(UA);
    await clean.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
    await clean.goto("https://accounts.spotify.com/fr/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(7000);
    const result = await clickGoogle(browser, clean).catch((e) => ({ error: String(e) }));
    report.googleClick = result;
    note("Clic Google", `cliqué ${result.clicked} · cible(s) ouverte(s) ${(result.openedTargets || []).length} · refus ${result.blocked ? "OUI" : "non"} · ${result.reason || result.error || ""}`);
    if (result.popup) {
      note("Fenêtre Google", `adresse : ${result.popup.url}`);
      note("Fenêtre Google (texte)", `titre « ${result.popup.title} » · ${result.popup.body}`);
      note("Fenêtre Google (opener)", `window.opener ${result.popup.hasOpener ? "présent" : "ABSENT"}`);
    } else {
      warn("Aucune fenêtre Google", `rien à lire : ${JSON.stringify(result).slice(0, 300)}`);
    }
    if (result.blocked) {
      warn("Google refuse la connexion", `refus détecté — ${JSON.stringify(result).slice(0, 600)}`);
    }
  } catch (e) {
    warn("Sonde navigateur interrompue", String(e));
    report.error = String(e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
    console.log(`[Sonde] rapport écrit dans ${OUT}/rapport.json`);
    /* Le rapport entier est aussi recopié dans le journal : les artefacts ne
       sont pas toujours téléchargeables, et un constat illisible ne sert à
       rien. */
    const flat = JSON.stringify(report);
    for (let i = 0; i < flat.length; i += 3500) {
      console.log(`RAPPORT ${String(i / 3500).padStart(3, "0")} ${flat.slice(i, i + 3500)}`);
    }
  }
}

main().catch((e) => {
  warn("Sonde navigateur : erreur non rattrapée", String(e));
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/rapport.json`, JSON.stringify(report, null, 2));
  } catch (err) {}
});
