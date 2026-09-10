#!/usr/bin/env node
/**
 * 本機開發伺服器（不需 Netlify CLI）。
 *  - 靜態檔：public/
 *  - /api/<name> 與 /.netlify/functions/<name> → netlify/functions/<name>.mts（Node 22 原生執行 TypeScript）
 *  - /<visit_id> → index.html（模擬 netlify.toml 的 fallback）
 *  - 提供 Netlify 全域物件的最小替身（Netlify.env）
 * 環境：STORE_BACKEND 預設 file；ADMIN_TOKEN 未設時用 "dev"；AI_MOCK 未設時提示。
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const fnDir = path.join(root, "netlify", "functions");

process.env.STORE_BACKEND ||= "file";
process.env.ADMIN_TOKEN ||= "dev";
process.env.SIGNAL_KEY ||= "devsignal";
const port = Number(process.env.PORT || 8888);
process.env.SITE_URL ||= `http://localhost:${port}`;

globalThis.Netlify = {
  env: {
    get: (k) => process.env[k],
    has: (k) => process.env[k] !== undefined,
    toObject: () => ({ ...process.env }),
  },
  context: { deploy: { context: "dev" } },
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

const fnCache = new Map();
async function loadFn(name) {
  if (!/^[\w-]+$/.test(name)) return null;
  if (!fnCache.has(name)) {
    const file = path.join(fnDir, `${name}.mts`);
    try {
      await stat(file);
    } catch {
      return null;
    }
    fnCache.set(name, import(pathToFileURL(file).href));
  }
  return (await fnCache.get(name)).default;
}

function toRequest(req, bodyBuf) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const init = { method: req.method, headers };
  if (!["GET", "HEAD"].includes(req.method)) init.body = bodyBuf;
  return new Request(url, init);
}

async function sendResponse(res, r) {
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  const buf = Buffer.from(await r.arrayBuffer());
  res.end(buf);
}

async function serveStatic(res, file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://localhost");
    try {
      const m = /^\/(?:api|\.netlify\/functions)\/([\w-]+)(?:\/.*)?$/.exec(url.pathname);
      if (m) {
        const fn = await loadFn(m[1]);
        if (!fn) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: `no function ${m[1]}` }));
        }
        return await sendResponse(res, await fn(toRequest(req, body), {}));
      }
      let p = decodeURIComponent(url.pathname);
      if (p === "/") p = "/index.html";
      const file = path.normalize(path.join(publicDir, p));
      if (!file.startsWith(publicDir)) {
        res.writeHead(403);
        return res.end();
      }
      if (await serveStatic(res, file)) return;
      if (await serveStatic(res, `${file}.html`)) return;
      // fallback：/<visit_id> → index.html
      if (await serveStatic(res, path.join(publicDir, "index.html"))) return;
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e?.stack || e) }));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, () => {
    console.log(`GHRC visit dev server  http://localhost:${port}`);
    console.log(`  admin:  http://localhost:${port}/admin.html   (ADMIN_TOKEN=${process.env.ADMIN_TOKEN})`);
    console.log(`  store:  ${process.env.STORE_BACKEND} (${process.env.STORE_DIR || "data/store"})`);
    console.log(`  AI:     ${process.env.AI_MOCK ? "AI_MOCK（範例資料）" : process.env.ANTHROPIC_API_KEY ? "Claude API" : "未設 ANTHROPIC_API_KEY —— 可用 AI_MOCK=1 試跑"}`);
  });
}
