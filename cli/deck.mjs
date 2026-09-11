#!/usr/bin/env node
/**
 * 產出當次參訪的簡報檔（本機 CLI；後台 admin.html 也能直接在瀏覽器產出同樣的檔案，核心在 public/lib/pptx.mjs）。
 *
 *   npm run deck -- --visit=2026-10-07-uwa            讀 data/visits/2026-10-07-uwa.json ＋ public/assets/master/slim-master.pptx → dist/
 *   npm run deck -- --spec=path/to/visit.json [--master=…] [--out=dist] [--lang=ko] [--no-pdf] [--site=https://visit.healsdesign.org]
 *   npm run deck -- --inspect [--master=…]             列出母簡報每一頁的標題與媒體大小
 *   npm run deck -- --dump [--master=…]                寫 data/master-text.json（給 /api/plan 產生第 1–3 頁的 text_edits 用）
 *   npm run deck -- --validate=dist/x.pptx             結構檢查
 *
 * 產檔步驟：選頁／重排 → 複製「您最想看哪一部分」頁與 QR 頁 → 逐字取代（text_edits）→ 流程表填值 →
 * 換第二語言（zh 不動；en 刪中文；ko／ja 翻譯＋換字型）→ 清孤兒 media → 驗證 → 存檔 → PDF。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { Deck, buildDeck as buildDeckCore, inspectDeck } from "./lib/pptx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** slim master 的位置：public/ 底下讓瀏覽器也抓得到；舊位置 assets/master/ 仍相容。 */
export const MASTER_CANDIDATES = ["public/assets/master/slim-master.pptx", "assets/master/slim-master.pptx"];

export { inspectDeck };

export function parseArgs(argv) {
  const o = { _: [] };
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] === undefined ? true : m[2];
    else o._.push(a);
  }
  return o;
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

/** Node 端的 QR 產生器（瀏覽器端在 admin.html 用 qrcodejs 的 canvas）。 */
export const qrPng = (url) => QRCode.toBuffer(url, { type: "png", width: 1024, margin: 1, errorCorrectionLevel: "M" });

/**
 * spec ＋ 母簡報 → { pptx: Uint8Array, report, dump }。同 public/lib/pptx.mjs 的 buildDeck，補上 Node 端的 QR 與 SITE_URL。
 */
export async function buildDeck(spec, masterBuf, opts = {}) {
  return buildDeckCore(spec, masterBuf, { site: process.env.SITE_URL, qrPng, ...opts });
}

export function toPdf(pptxPath, outDir) {
  const bin = process.env.LIBREOFFICE_BIN || (existsSync("/Applications/LibreOffice.app/Contents/MacOS/soffice") ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : "soffice");
  const profile = path.join(os.tmpdir(), "ghrc-lo-profile");
  const r = spawnSync(bin, ["--headless", "--norestore", "--nologo", `-env:UserInstallation=${pathToFileURL(profile).href}`, "--convert-to", "pdf", "--outdir", outDir, pptxPath], { encoding: "utf8", timeout: 300000, env: { ...process.env, HOME: process.env.HOME || os.tmpdir(), SAL_USE_VCLPLUGIN: process.env.SAL_USE_VCLPLUGIN || "svp" } });
  if (r.error) return { ok: false, error: `${bin} 無法執行：${r.error.message}（沒有 LibreOffice 就用 --no-pdf）` };
  if (r.status !== 0) return { ok: false, error: `${bin} 結束碼 ${r.status}：${(r.stderr || r.stdout || "").slice(0, 500)}` };
  const pdf = path.join(outDir, path.basename(pptxPath).replace(/\.pptx$/i, ".pdf"));
  return existsSync(pdf) ? { ok: true, pdf } : { ok: false, error: "LibreOffice 沒有產出 PDF" };
}

function findMaster(arg) {
  if (arg) return path.resolve(ROOT, String(arg));
  for (const rel of MASTER_CANDIDATES) {
    const p = path.resolve(ROOT, rel);
    if (existsSync(p)) return p;
  }
  return path.resolve(ROOT, MASTER_CANDIDATES[0]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const masterPath = findMaster(args.master);
  const outDir = path.resolve(ROOT, args.out || "dist");

  if (args.validate) {
    const deck = await Deck.load(await fs.readFile(path.resolve(ROOT, String(args.validate))));
    const v = await deck.validate();
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.errors.length ? 1 : 0);
  }

  if (!existsSync(masterPath)) {
    console.error(`找不到母簡報：${masterPath}\n先用 python3 scripts/slim-master.py <396MB母檔.pptx> 產出 slim master（預設寫到 public/assets/master/slim-master.pptx，見 CLAUDE.md）。`);
    process.exit(2);
  }
  const masterBuf = await fs.readFile(masterPath);

  if (args.inspect || args.dump) {
    const info = await inspectDeck(masterBuf);
    if (args.dump) {
      const out = path.resolve(ROOT, typeof args.dump === "string" ? args.dump : "data/master-text.json");
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, JSON.stringify({ generated_at: new Date().toISOString(), master: path.relative(ROOT, masterPath), slide_count: info.slide_count, slides: info.slides.map(({ media, ...s }) => s) }, null, 2));
      console.log(`寫入 ${path.relative(ROOT, out)}（${info.slide_count} 頁）`);
    } else {
      for (const s of info.slides) console.log(`${String(s.n).padStart(2, "0")}  ${s.title.slice(0, 60).padEnd(60)}  ${s.media.map((m) => `${m.part.split("/").pop()} ${(m.bytes / 1e6).toFixed(1)}MB`).join(", ")}`);
      const total = info.slides.flatMap((s) => s.media).reduce((a, m) => a + m.bytes, 0);
      console.log(`\n${info.slide_count} 頁，媒體共 ${(total / 1e6).toFixed(1)} MB（重複引用會重複計）`);
    }
    return;
  }

  const specPath = args.spec ? path.resolve(ROOT, String(args.spec)) : args.visit ? path.resolve(ROOT, "data/visits", `${args.visit}.json`) : null;
  if (!specPath) {
    console.error("用法：npm run deck -- --visit=<visit_id> | --spec=<file> | --inspect | --dump | --validate=<pptx>");
    process.exit(2);
  }
  const spec = await readJson(specPath);
  if (!spec.visit_id) throw new Error(`${specPath} 沒有 visit_id`);
  const slidesIndex = existsSync(path.join(ROOT, "public/data/slides.json")) ? await readJson(path.join(ROOT, "public/data/slides.json")) : null;
  const lang = args.lang || spec.language || "zh";

  // 翻譯器與快取（data/translations/<lang>.json）
  let translate = null;
  const cache = new Map();
  const cachePath = path.join(ROOT, "data/translations", `${lang}.json`);
  if (lang === "ko" || lang === "ja") {
    if (existsSync(cachePath)) for (const [k, v] of Object.entries(await readJson(cachePath))) cache.set(k, v);
    const ai = await import("../netlify/lib/ai.mts");
    translate = (texts, target) => ai.translateTexts(texts, target);
  }

  const { pptx, report, dump } = await buildDeck(spec, masterBuf, { slidesIndex, lang, site: args.site || process.env.SITE_URL, translate, translationCache: cache, log: (m) => console.log(m) });
  if (cache.size && (lang === "ko" || lang === "ja")) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(Object.fromEntries(cache), null, 2));
  }
  await fs.mkdir(outDir, { recursive: true });
  const pptxPath = path.join(outDir, `${spec.visit_id}.pptx`);
  await fs.writeFile(pptxPath, pptx);
  await fs.writeFile(path.join(outDir, `${spec.visit_id}.txt`), dump.map((s) => `--- ${s.n} ${s.title}\n${s.paragraphs.join("\n")}`).join("\n\n"));
  await fs.writeFile(path.join(outDir, `${spec.visit_id}.report.json`), JSON.stringify(report, null, 2));
  console.log(`✔ ${path.relative(ROOT, pptxPath)}（${report.output_slides} 頁，${(pptx.length / 1e6).toFixed(1)} MB；文字取代 ${report.edits.applied} 處${report.edits.missed.length ? `，${report.edits.missed.length} 處沒找到` : ""}）`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  for (const m of report.edits.missed) console.log(`  ⚠ 第 ${m.slide} 頁找不到「${m.find.slice(0, 40)}」`);
  if (!args["no-pdf"]) {
    const r = toPdf(pptxPath, outDir);
    console.log(r.ok ? `✔ ${path.relative(ROOT, r.pdf)}` : `  ⚠ PDF 未產出：${r.error}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✘ ${e.message}`);
    process.exit(1);
  });
}
