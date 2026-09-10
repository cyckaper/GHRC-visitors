#!/usr/bin/env node
/**
 * 產出當次參訪的簡報檔（CLAUDE.md「v1 切法：web 出規格，CLI 出檔案」）。
 *
 *   npm run deck -- --visit=2026-10-07-uwa            讀 data/visits/2026-10-07-uwa.json ＋ assets/master/slim-master.pptx → dist/
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
import { Deck } from "./lib/pptx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASK_TITLE = { en: "Which part would you most like to see?", zh: "您最想看哪一部分？", ko: "어느 부분을 가장 보고 싶으십니까?", ja: "どの部分を最もご覧になりたいですか。" };
const QR_CAPTION = { en: "Today's slides, papers and contacts", zh: "當天簡報、論文與老師聯絡方式", ko: "오늘 발표 자료 · 논문 · 연락처", ja: "本日のスライド・論文・連絡先" };

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

function roleN(slidesIndex, role) {
  return slidesIndex?.slides?.find((s) => s.role === role)?.n;
}

/**
 * 核心：spec ＋ 母簡報 → { pptx: Buffer, report }
 * @param {object} spec  visits 表的一筆（visit_id、slides、language、text_edits、programme、page_url、deck.*）
 * @param {Buffer} masterBuf
 * @param {object} opts  { slidesIndex, lang, site, translate(texts, lang) → string[], log }
 */
export async function buildDeck(spec, masterBuf, opts = {}) {
  const log = opts.log || (() => {});
  const slidesIndex = opts.slidesIndex || null;
  const deck = await Deck.load(masterBuf);
  const all = await deck.slides();
  const byN = new Map(all.map((s) => [s.n, s.path]));
  const report = { visit_id: spec.visit_id, master_slides: all.length, chosen: [], edits: { applied: 0, missed: [] }, warnings: [] };

  // 1. 選頁
  const wanted = Array.isArray(spec.slides) && spec.slides.length ? spec.slides.map(Number) : all.map((s) => s.n);
  const chosen = [];
  for (const n of wanted) {
    if (byN.has(n)) chosen.push(n);
    else report.warnings.push(`spec 選了不存在的第 ${n} 頁（母簡報只有 ${all.length} 頁）`);
  }
  if (!chosen.length) throw new Error("沒有任何可用的頁");
  report.chosen = chosen;

  // 2. 複製「您最想看哪一部分」頁（預設從組織架構頁複製：五位老師照片並列）與 QR 頁（從謝謝頁複製）
  const askFrom = spec.deck?.ask_clone_from ?? roleN(slidesIndex, "organisation") ?? 5;
  const qrFrom = spec.deck?.qr_clone_from ?? roleN(slidesIndex, "closing") ?? all.length;
  const askSrc = byN.get(Number(askFrom));
  const qrSrc = byN.get(Number(qrFrom)) || all[all.length - 1].path;
  const askPath = askSrc ? await deck.cloneSlide(askSrc) : null;
  if (!askSrc) report.warnings.push(`找不到可複製成「您最想看哪一部分」的第 ${askFrom} 頁，略過`);
  const qrPath = await deck.cloneSlide(qrSrc);

  // 3. 重排
  const order = [...chosen.map((n) => byN.get(n)), askPath, qrPath].filter(Boolean);
  await deck.setSlideOrder(order);

  // 4. 逐字取代（母簡報頁碼 → path）
  const edits = Array.isArray(spec.text_edits) ? spec.text_edits : [];
  const byPage = new Map();
  for (const e of edits) {
    if (!e || !e.find) continue;
    const p = byN.get(Number(e.slide));
    if (!p || !order.includes(p)) {
      report.edits.missed.push({ ...e, reason: "該頁不在輸出裡" });
      continue;
    }
    byPage.set(p, [...(byPage.get(p) || []), e]);
  }
  for (const [p, list] of byPage) {
    for (const e of list) {
      const n = await deck.editText(p, [e]);
      if (n) report.edits.applied += n;
      else report.edits.missed.push({ ...e, reason: "母簡報裡找不到這段文字" });
    }
  }

  // 5. 今日流程表（第 2 頁若是表格）：時間、英文、第二語言、頁碼
  const progN = roleN(slidesIndex, "programme") ?? 2;
  const progPath = byN.get(progN);
  if (progPath && order.includes(progPath) && Array.isArray(spec.programme) && spec.programme.length) {
    const cols = spec.deck?.programme_columns || ["time", "title_en", "title_2nd", "slides_range"];
    const rows = spec.programme.map((b) => cols.map((c) => (c === "time" ? `${b.start} – ${b.end}` : String(b[c] ?? ""))));
    const ok = await deck.fillTable(progPath, rows);
    report.programme_table = ok ? "filled" : "no table on programme slide（用 text_edits）";
  }

  // 6. 第二語言
  const lang = opts.lang || spec.language || "zh";
  report.language = lang;
  if (lang === "en") {
    for (const p of order) await deck.swapCjk(p, null, "en");
  } else if (lang === "ko" || lang === "ja") {
    const texts = new Set();
    for (const p of order) for (const t of await deck.cjkRuns(p)) texts.add(t);
    const list = [...texts];
    const cache = opts.translationCache || new Map();
    const missing = list.filter((t) => !cache.has(t));
    if (missing.length) {
      if (!opts.translate) throw new Error(`需要翻譯 ${missing.length} 段中文成 ${lang}，但沒有翻譯器（設定 ANTHROPIC_API_KEY 或 AI_MOCK=1）`);
      log(`翻譯 ${missing.length} 段中文 → ${lang}`);
      const out = await opts.translate(missing, lang);
      missing.forEach((t, i) => cache.set(t, out[i]));
    }
    for (const p of order) await deck.swapCjk(p, cache, lang);
    report.translated = list.length;
  }

  // 7. 「您最想看哪一部分」頁標題
  if (askPath) {
    const lines = lang === "en" ? [ASK_TITLE.en] : [ASK_TITLE.en, ASK_TITLE[lang] || ASK_TITLE.zh];
    await deck.setTitle(askPath, lines);
  }

  // 8. QR 頁
  const site = (opts.site || process.env.SITE_URL || "https://visit.healsdesign.org").replace(/\/$/, "");
  const url = spec.page_url || `${site}/${spec.visit_id}`;
  const png = await QRCode.toBuffer(url, { type: "png", width: 1024, margin: 1, errorCorrectionLevel: "M" });
  const { cx, cy } = await deck.slideSize();
  const side = Math.round(cy * 0.42);
  const margin = Math.round(cx * 0.05);
  const x = cx - side - margin;
  const y = Math.round((cy - side) / 2) - Math.round(cy * 0.05);
  await deck.addPicture(qrPath, png, { x, y, cx: side, cy: side }, "Visit QR");
  const captionLines = [url.replace(/^https?:\/\//, ""), lang === "en" ? QR_CAPTION.en : `${QR_CAPTION.en} · ${QR_CAPTION[lang] || QR_CAPTION.zh}`];
  await deck.addTextBox(qrPath, captionLines, { x: x - Math.round(side * 0.25), y: y + side + Math.round(cy * 0.02), cx: Math.round(side * 1.5), cy: Math.round(cy * 0.12) }, { size: 1400, align: "ctr" });
  report.page_url = url;

  // 9. 清孤兒、驗證
  report.removed_parts = (await deck.clean()).length;
  const v = await deck.validate();
  report.validation = v;
  if (v.errors.length) throw new Error(`產出的檔案沒過驗證：\n- ${v.errors.join("\n- ")}`);
  report.output_slides = v.slideCount;
  const dump = [];
  for (const s of await deck.slides()) dump.push({ n: s.n, title: await deck.title(s.path), paragraphs: await deck.paragraphs(s.path) });
  return { pptx: await deck.save(), report, dump };
}

export async function inspectDeck(masterBuf) {
  const deck = await Deck.load(masterBuf);
  const slides = [];
  for (const s of await deck.slides()) {
    const rels = await deck.rels(s.path);
    const media = [];
    for (const r of rels) if (r.part && r.part.startsWith("ppt/media/")) media.push({ part: r.part, bytes: (await deck.bytes(r.part)).length, type: r.type.split("/").pop() });
    slides.push({ n: s.n, path: s.path, title: await deck.title(s.path), paragraphs: await deck.paragraphs(s.path), media });
  }
  return { slide_count: slides.length, slides };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const masterPath = path.resolve(ROOT, args.master || "assets/master/slim-master.pptx");
  const outDir = path.resolve(ROOT, args.out || "dist");

  if (args.validate) {
    const deck = await Deck.load(await fs.readFile(path.resolve(ROOT, String(args.validate))));
    const v = await deck.validate();
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.errors.length ? 1 : 0);
  }

  if (!existsSync(masterPath)) {
    console.error(`找不到母簡報：${masterPath}\n先用 python3 scripts/slim-master.py <396MB母檔.pptx> --out assets/master/slim-master.pptx 產出 slim master（見 CLAUDE.md）。`);
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

  const { pptx, report, dump } = await buildDeck(spec, masterBuf, { slidesIndex, lang, site: args.site, translate, translationCache: cache, log: (m) => console.log(m) });
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
