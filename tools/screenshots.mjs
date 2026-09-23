#!/usr/bin/env node
/**
 * Visual check for the injected mobile layer.
 *
 *   node tools/screenshots.mjs [baseUrl]
 *
 * Requirements (dev-only, not needed to build the bundle):
 *   npm i -D puppeteer-core @sparticuz/chromium
 *
 * Drives the mock web player in demo/ and writes PNGs to shots/, so a change
 * in the CSS can be reviewed (and regressions spotted) without a device.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "shots");
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const PHONE = { width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const LANDSCAPE = { width: 800, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let chromium, puppeteer;
try {
  chromium = (await import("@sparticuz/chromium")).default;
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.error(
    "Missing dev dependencies.\n  npm i -D puppeteer-core @sparticuz/chromium\n" +
      "(or export CHROME_PATH to an existing Chrome/Chromium binary)"
  );
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const executablePath = process.env.CHROME_PATH || (await chromium.executablePath());
const browser = await puppeteer.launch({
  args: [...(chromium.args || []), "--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  executablePath,
  headless: true,
});

const logs = [];
async function open(path, viewport) {
  const page = await browser.newPage();
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.setViewport(viewport);
  await page.goto(BASE + path, { waitUntil: "networkidle2" });
  await page.waitForTimeout(700);
  return page;
}
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("  ▸ shots/" + name + ".png");
}
async function tap(page, selector) {
  await page.click(selector);
  await page.waitForTimeout(650);
}
async function swipe(page, selector, dx, dy) {
  const box = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + (dx * i) / 8, box.y + (dy * i) / 8);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

console.log("→ desktop web player (layer OFF)");
let page = await open("/demo/player.html?off=1", PHONE);
await shot(page, "00-before-desktop");
await page.close();

console.log("→ mobile layer ON");
page = await open("/demo/player.html", PHONE);
await shot(page, "01-home");

console.log("  · mini player + full player");
await page.evaluate(() => window.MockSpotify.play(0));
await page.waitForTimeout(700);
await shot(page, "02-home-miniplayer");
await tap(page, ".sd-mini");
await shot(page, "03-full-player");
await tap(page, ".sd-ctrl-queue");
await shot(page, "04-queue-sheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

console.log("  · library + search tabs");
await tap(page, '.sd-tab[data-tab="library"]');
await shot(page, "05-library");
await tap(page, '.sd-tab[data-tab="search"]');
await shot(page, "06-search");
await tap(page, '.sd-tab[data-tab="home"]');
await tap(page, "div[data-testid='card'] .shortcut, .shortcut");
await shot(page, "07-playlist-page");
await page.close();

console.log("→ with system insets (notch + gesture bar)");
page = await open("/demo/player.html?top=44&bottom=24", PHONE);
await page.evaluate(() => window.MockSpotify.play(1));
await page.waitForTimeout(600);
await shot(page, "08-insets-home");
await tap(page, ".sd-mini");
await shot(page, "09-insets-player");
await page.close();

console.log("→ landscape");
page = await open("/demo/player.html?top=24&bottom=0", LANDSCAPE);
await page.evaluate(() => window.MockSpotify.play(2));
await page.waitForTimeout(600);
await shot(page, "10-landscape-home");
await tap(page, ".sd-mini");
await shot(page, "11-landscape-player");
await page.close();

console.log("→ small screen 320×568");
page = await open("/demo/player.html", { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await shot(page, "12-small-home");
await page.evaluate(() => window.MockSpotify.play(3));
await page.waitForTimeout(500);
await tap(page, ".sd-mini");
await shot(page, "13-small-player");
await page.close();

await browser.close();

if (logs.length) {
  console.log("\nconsole output:");
  logs.slice(0, 40).forEach((l) => console.log("  " + l));
} else {
  console.log("\nno console output (clean run)");
}
