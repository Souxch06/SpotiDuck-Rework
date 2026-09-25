#!/usr/bin/env node
/**
 * Zero-dependency static server for the demo harness.
 *
 *   node tools/serve.mjs [port]
 *
 * Binds 0.0.0.0 (required by the sandbox preview proxy) and serves the repo
 * root, with `/` → `/demo/index.html`.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/") url = "/demo/index.html";
    if (url.endsWith("/")) url += "index.html";
    const path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ""));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: url + "/index.html" }).end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 — " + (req.url || ""));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SpotiDuck demo → http://0.0.0.0:${PORT}/  (root: ${ROOT})`);
});
