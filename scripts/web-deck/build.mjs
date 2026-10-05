#!/usr/bin/env node
/**
 * 網頁版簡報 /deck（明確指示：「改為用網頁連結方式、簡報都用一樣的版本、用母 ppt 建這個網頁」）。
 * 從母簡報做出：每一頁一張圖（public/assets/deck/<版本>/sNN.webp ＋ 縮圖 tNN.webp）、影片（壓成網頁用的 mp4，
 * 放在站台上）、public/data/deck.json（頁序、每一頁的字、影片在頁面上的位置）。
 *
 * 在 GitHub Actions 上跑（.github/workflows/web-deck.yml）：要 LibreOffice（pptx → PDF）、PyMuPDF＋Pillow（PDF → 圖）、
 * ffmpeg（影片）。開發用的雲端環境裡 LibreOffice 開不了 pptx、也連不到 Google Drive 的下載網址，所以只在 Actions 上轉。
 *
 *   node scripts/web-deck/build.mjs <master.pptx>
 *
 * 每一場都看同一份，所以上一場的東西不放（scripts/web-deck/source.json 的 exclude）：封面上一場來賓的名字、
 * 今日流程（每一場不一樣，來賓專頁上有）、寫給某一團的那一章（09 提問回覆）、寫著「此頁不投影」的頁、隱藏的頁。
 * 母簡報內文的標準更正（public/data/master-fixes.json：四間 → 五間）照套。講稿不放（圖上本來就沒有）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Deck, slideBlocks } from "../../cli/lib/pptx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = JSON.parse(await readFile(path.join(ROOT, "scripts/web-deck/source.json"), "utf8"));
const masterPath = process.argv[2];
if (!masterPath) throw new Error("用法：node scripts/web-deck/build.mjs <master.pptx>");
const masterBytes = await readFile(masterPath);
// 版本＝哪一天做的＋母簡報與設定的指紋：圖與影片放在這個名字的資料夾，站台可以放心讓瀏覽器一直留著（換一版就換一個資料夾）
const VERSION = `${new Date().toISOString().slice(0, 10)}-${createHash("sha1").update(masterBytes).update(JSON.stringify(SOURCE)).digest("hex").slice(0, 8)}`;
const OUT = path.join(ROOT, "public/assets/deck", VERSION);
const WEB = `assets/deck/${VERSION}`;
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const MAX_VIDEO = 45 * 1024 * 1024; // GitHub 一個檔超過 50 MB 就警告、100 MB 擋下

const log = (...a) => console.log("[web-deck]", ...a);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失敗（${r.status}）：${(r.stderr || r.stdout || r.error?.message || "").slice(-2000)}`);
  return r.stdout || "";
}

const KICKER = /^(0[1-9])\s*[·•・‧]\s*\S/;
const CHAPTER_NO = /^0[1-9]$/;
const ORG_TITLE = /^(?:Organisation|Organization|組織架構)$/i;
const CONTENTS_TITLE = /^CONTENTS\b|簡報架構|^Contents$|^目錄$/i;
const MEDIA_PIC = /<a:videoFile\b|<a:audioFile\b|p14:media\b/;

/** 一頁的章節號：頁眉「03 · …」，或分隔頁開頭的「03」（組織架構那一頁的頁眉誤標 08，不算）。沒有回 null。 */
function chapterOf(paras) {
  const t = paras.map((x) => x.trim()).filter(Boolean);
  if (t.some((x) => ORG_TITLE.test(x))) return null;
  const k = t.map((x) => KICKER.exec(x)).find(Boolean);
  if (k) return k[1];
  return CHAPTER_NO.test(t[0] || "") && t.length > 1 ? t[0] : null;
}

/** 群組的座標換算（子物件座標 → 投影片座標）。 */
function groupXfrm(xml) {
  const n = (re) => { const m = re.exec(xml); return m ? m.slice(1).map(Number) : null; };
  const off = n(/<a:off x="(-?\d+)" y="(-?\d+)"/), ext = n(/<a:ext cx="(\d+)" cy="(\d+)"/);
  const chOff = n(/<a:chOff x="(-?\d+)" y="(-?\d+)"/), chExt = n(/<a:chExt cx="(\d+)" cy="(\d+)"/);
  if (!off || !ext || !chOff || !chExt) return null;
  return { off, ext, chOff, chExt };
}

/** 這一頁的影片／音訊物件：位置（投影片座標，EMU；在群組裡的換算過）、用到的關聯、海報影格。 */
function mediaPics(xml) {
  const out = [];
  const groups = [];
  const re = /<p:grpSp>|<\/p:grpSp>|<p:pic>[\s\S]*?<\/p:pic>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const tok = m[0];
    if (tok === "<p:grpSp>") {
      const pr = /<p:grpSpPr\b[^>]*>([\s\S]*?)<\/p:grpSpPr>/.exec(xml.slice(m.index, m.index + 6000));
      groups.push(pr ? groupXfrm(pr[1]) : null);
      continue;
    }
    if (tok === "</p:grpSp>") { groups.pop(); continue; }
    if (!MEDIA_PIC.test(tok)) continue;
    const xf = /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(tok);
    if (!xf) continue;
    let [x, y, w, h] = xf.slice(1).map(Number);
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (!g) continue;
      const sx = g.chExt[0] ? g.ext[0] / g.chExt[0] : 1, sy = g.chExt[1] ? g.ext[1] / g.chExt[1] : 1;
      x = g.off[0] + (x - g.chOff[0]) * sx; y = g.off[1] + (y - g.chOff[1]) * sy; w *= sx; h *= sy;
    }
    out.push({
      xml: tok, x, y, w, h,
      audio: /<a:audioFile\b/.test(tok) && !/<a:videoFile\b/.test(tok),
      link: /<a:(?:videoFile|audioFile)\b[^>]*\br:link="([^"]+)"/.exec(tok)?.[1] || "",
      embed: /<p14:media\b[^>]*\br:embed="([^"]+)"/.exec(tok)?.[1] || "",
      poster: /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(tok)?.[1] || "",
    });
  }
  return out;
}

/** 影片物件變成一張普通的圖（LibreOffice 才會畫出海報影格），播放的設定與自動播放的 timing 拿掉。 */
function stripMedia(xml, pics) {
  let out = xml;
  for (const pic of pics) {
    let p = pic.xml.replace(/<a:videoFile\b[^>]*\/>|<a:audioFile\b[^>]*\/>|<a:quickTimeFile\b[^>]*\/>/g, "");
    p = p.replace(/<p:extLst>(?:(?!<\/p:extLst>)[\s\S])*p14:media(?:(?!<\/p:extLst>)[\s\S])*<\/p:extLst>/g, "");
    p = p.replace(/<a:hlinkClick\b[^>]*ppaction:\/\/media[^>]*\/>/g, "");
    const i = out.indexOf(pic.xml);
    if (i >= 0) out = out.slice(0, i) + p + out.slice(i + pic.xml.length);
  }
  return out.replace(/<p:timing>(?:(?!<\/p:timing>)[\s\S])*(?:<p:video\b|<p:audio\b|p14:media)(?:(?!<\/p:timing>)[\s\S])*<\/p:timing>/g, "");
}

/** 母簡報用到的字型（主題的 latin／ea 與每一個 run 指定的）。 */
async function fontsUsed(deck) {
  const set = new Set();
  for (const f of deck.files()) {
    if (!/^ppt\/(?:theme|slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(f)) continue;
    for (const m of (await deck.text(f)).matchAll(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]+)"/g)) {
      const name = m[1].trim();
      if (name && !name.startsWith("+")) set.add(name);
    }
  }
  return [...set].sort();
}

/** 這台機器上有的字型家族（fc-list）。 */
function installedFamilies() {
  const out = spawnSync("fc-list", [":", "family"], { encoding: "utf8" }).stdout || "";
  return new Set(out.split("\n").flatMap((l) => l.split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** 缺的字型到 Google Fonts 找（有就裝起來），回傳裝了哪些。只在 Actions 上會走到（那裡連得到）。 */
async function installGoogleFonts(names) {
  const dir = path.join(os.homedir(), ".local/share/fonts/web-deck");
  await mkdir(dir, { recursive: true });
  const got = [];
  for (const name of names) {
    if (/[^\x20-\x7e]/.test(name)) continue; // 中文名稱的字型（微軟正黑體…）不在 Google Fonts，交給 fontconfig 的別名
    try {
      const fam = name.replace(/ /g, "+");
      // 舊的 user-agent 拿得到 TTF（新的瀏覽器拿到 woff2，LibreOffice 不吃）
      const res = await fetch(`https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;1,400;1,700`, { headers: { "user-agent": "Mozilla/4.0" } });
      if (!res.ok) continue;
      const urls = [...(await res.text()).matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
      let n = 0;
      for (const [i, u] of urls.entries()) {
        const r = await fetch(u);
        if (!r.ok) continue;
        await writeFile(path.join(dir, `${name.replace(/\W+/g, "_")}-${i}.ttf`), Buffer.from(await r.arrayBuffer()));
        n++;
      }
      if (n) got.push(name);
    } catch (e) { log("字型下載失敗", name, e.message); }
  }
  if (got.length) spawnSync("fc-cache", ["-f"], { stdio: "ignore" });
  return got;
}

/**
 * 影片壓成網頁用的大小（H.264／AAC、moov 放前面才能邊下載邊播）；壓不小就維持原檔（只搬 moov）。
 * 影片在投影片上的框多大就壓多大：框不到七成寬，投影機上也不到 1300 像素，1280 寬就夠（檔案小一半，repo 也長得慢）。
 */
function encodeVideo(input, output, boxWidth = 1) {
  const before = spawnSync("stat", ["-c", "%s", input], { encoding: "utf8" }).stdout.trim() * 1;
  const tries = boxWidth >= 0.7
    ? [["1920", "24"], ["1920", "27"], ["1280", "27"], ["1280", "30"], ["960", "30"]]
    : [["1280", "24"], ["1280", "27"], ["960", "28"], ["854", "30"]];
  let size = 0;
  for (const [width, crf] of tries) {
    run(FFMPEG, ["-y", "-loglevel", "error", "-i", input, "-vf", `scale='min(${width},iw)':-2`, "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output]);
    size = spawnSync("stat", ["-c", "%s", output], { encoding: "utf8" }).stdout.trim() * 1;
    if (size <= MAX_VIDEO) break;
  }
  if (size > before && before <= MAX_VIDEO) {
    // 原檔本來就小：搬 moov 就好，不要越壓越大
    run(FFMPEG, ["-y", "-loglevel", "error", "-i", input, "-c", "copy", "-movflags", "+faststart", output]);
    size = spawnSync("stat", ["-c", "%s", output], { encoding: "utf8" }).stdout.trim() * 1;
  }
  if (size > MAX_VIDEO) throw new Error(`影片 ${path.basename(input)} 壓到最小還有 ${(size / 1e6).toFixed(1)} MB，放不進站台`);
  return { before, after: size };
}

const deck = await Deck.load(masterBytes);
const all = await deck.slides();
const size = await deck.slideSize();
const mapped = await slideBlocks(deck, all);
const ex = SOURCE.exclude || {};
const report = { warnings: [] };
log(`母簡報 ${all.length} 頁，照內容認得出${mapped.ok ? "" : "不"}來`);

// 1. 哪幾頁不放
const kept = [], excluded = [];
let chapter = null;
for (const s of all) {
  const xml = await deck.text(s.path);
  const paras = (await deck.paragraphs(s.path)).map((t) => t.trim());
  const ch = chapterOf(paras);
  if (ch) chapter = ch;
  const title = paras.find((t) => !KICKER.test(t)) || "";
  const role = Object.entries(mapped.ok ? mapped.roles : {}).find(([, n]) => n === s.n)?.[0];
  const text = paras.join("\n");
  const reason = /<p:sld\b[^>]*\bshow="0"/.test(xml) ? "隱藏的頁"
    : (ex.slides || []).includes(s.n) ? "source.json 指定不放"
    : role && (ex.roles || []).includes(role) ? (role === "programme" ? "今日流程（每一場不一樣，來賓專頁上有）" : `「${role}」那一頁`)
    : (ex.text || []).find((t) => text.includes(t)) ? `寫著「${(ex.text || []).find((t) => text.includes(t))}」`
    : chapter && (ex.chapters || []).includes(chapter) ? `第 ${chapter} 章（寫給某一團的）`
    : "";
  // deck.json 是公開的：不放的頁只記頁次與原因（寫給某一團的那幾頁，標題可能帶著那一團的名字）
  if (reason) { excluded.push({ src: s.n, reason }); log(`不放第 ${s.n} 頁：${reason}`); }
  else kept.push({ ...s, title, chapter: ch, block: mapped.ok ? mapped.blockOf.get(s.n) || null : null });
}
if (!kept.length) throw new Error("沒有任何一頁可以放");
log(`放 ${kept.length} 頁，不放 ${excluded.length} 頁`);

// 2. 封面：上一場來賓的那一塊清掉（每一場都看同一份）。只清母簡報的第一頁——別的頁上「Dr. …」開頭的字不是來賓。
// deck.json 是公開的，只記清了幾行，不記上一場來賓的名字
const cover = kept.find((s) => s.n === (mapped.ok ? mapped.roles.cover ?? 1 : 1));
const box = cover ? await deck.visitBox(cover.path) : null;
if (box) {
  await deck.fillVisitBox(cover.path, box, { org: "", guests: [], date: "" });
  report.cover_cleared = box.old.length;
} else if (cover) report.warnings.push("封面認不出寫來賓的那一塊，照母簡報");

// 3. 目錄頁：只列這一份有的章節
const present = new Set(kept.map((s) => s.chapter).filter(Boolean));
for (const s of kept) {
  if (!(await deck.paragraphs(s.path)).some((t) => CONTENTS_TITLE.test(t.trim()))) continue;
  const items = await deck.contentsItems(s.path);
  if (!items) { report.warnings.push("目錄頁的排法認不出來，目錄照母簡報"); break; }
  const keep = new Set(items.map((it) => it.no).filter((no) => present.has(no)));
  if (keep.size && keep.size < items.length) report.contents = await deck.keepContents(s.path, keep);
  break;
}

// 4. 母簡報內文的標準更正
const fixes = JSON.parse(await readFile(path.join(ROOT, "public/data/master-fixes.json"), "utf8")).fixes || [];
const fixed = {};
for (const s of kept) for (const f of fixes) { const n = await deck.editText(s.path, [f]); if (n) fixed[f.find] = (fixed[f.find] || 0) + n; }
report.fixes = fixed;

// 4.5 照片不拉變形（既有標準：照片維持真實比例，不變形、不裁切；Deck.fixPictureAspect，跟以前產 .pptx 同一套）。
// 要在記下影片位置之前做：影片的海報影格若被拉變形，框會跟著改，影片疊上去的位置才對得上
report.pictures_fixed = 0;
for (const s of kept) report.pictures_fixed += await deck.fixPictureAspect(s.path);

// 5. 影片：記下位置、把檔案拿出來，頁面上換成一張圖
const TMP = await mkdtemp(path.join(os.tmpdir(), "web-deck-"));
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const media = new Map(); // part → { file, n }
for (const s of kept) {
  const xml = await deck.text(s.path);
  const pics = mediaPics(xml);
  if (!pics.length) continue;
  const rels = new Map((await deck.rels(s.path)).map((r) => [r.id, r]));
  s.media = [];
  for (const pic of pics) {
    const rel = rels.get(pic.embed)?.part ? rels.get(pic.embed) : rels.get(pic.link);
    const item = { x: pic.x / size.cx, y: pic.y / size.cy, w: pic.w / size.cx, h: pic.h / size.cy, type: pic.audio ? "audio" : "video" };
    if (rel?.external) item.url = rel.target;
    else if (rel?.part && deck.has(rel.part)) {
      if (!media.has(rel.part)) {
        const file = path.join(TMP, `m${media.size + 1}.${rel.part.split(".").pop()}`);
        await writeFile(file, await deck.bytes(rel.part));
        media.set(rel.part, { file, n: media.size + 1, w: 0 });
      }
      media.get(rel.part).w = Math.max(media.get(rel.part).w, item.w); // 同一支放在好幾頁：照最大的那個框壓
      item.part = rel.part;
    } else { report.warnings.push(`第 ${s.n} 頁有一支影片找不到檔案`); continue; }
    const poster = rels.get(pic.poster);
    if (poster?.part && deck.has(poster.part)) item.posterPart = poster.part;
    s.media.push(item);
  }
  deck.set(s.path, stripMedia(xml, pics));
  for (const r of rels.values()) if (/\/(?:video|audio|media)$/.test(r.type || "")) await deck.removeRel(s.path, r.id);
}

// 6. 只留要放的頁、拿掉講稿，存一份給 LibreOffice 畫
for (const s of kept) await deck.dropNotes(s.path);
await deck.setSlideOrder(kept.map((s) => s.path));
// 海報影格要在清孤兒之前拿出來
for (const s of kept) for (const m of s.media || []) if (m.posterPart) m.posterBytes = await deck.bytes(m.posterPart);
await deck.clean();
const renderPptx = path.join(TMP, "render.pptx");
await writeFile(renderPptx, await deck.save());

// 7. 字型：缺的到 Google Fonts 找；中文的由 fontconfig 別名換成 Noto CJK（.github/workflows/web-deck.yml 寫的）
const used = await fontsUsed(deck);
const have = installedFamilies();
const missing = used.filter((f) => !have.has(f.toLowerCase()));
const fromGoogle = missing.length ? await installGoogleFonts(missing) : [];
const still = missing.filter((f) => !fromGoogle.includes(f));
report.fonts = { used, from_google: fromGoogle, substituted: still };
log("字型", JSON.stringify(report.fonts));

// 8. pptx → PDF → 每一頁一張圖
run("soffice", ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", TMP, renderPptx], { timeout: 20 * 60 * 1000 });
const pdf = path.join(TMP, "render.pdf");
const raster = JSON.parse(run("python3", [path.join(ROOT, "scripts/web-deck/raster.py"), "pdf", pdf, OUT, "--width", String(SOURCE.width || 1920), "--thumb", "480"]));
if (raster.pages !== kept.length) throw new Error(`PDF 有 ${raster.pages} 頁，應該是 ${kept.length} 頁`);

// 9. 影片壓成網頁用的大小；海報影格轉成 webp
report.videos = [];
for (const [part, m] of media) {
  const out = path.join(OUT, `v${m.n}.mp4`);
  try {
    const r = encodeVideo(m.file, out, m.w);
    report.videos.push({ part, before: r.before, after: r.after });
    log(`影片 ${part}：${(r.before / 1e6).toFixed(1)} MB → ${(r.after / 1e6).toFixed(1)} MB`);
  } catch (e) {
    // 一支轉不了不要害整份停下來：那幾頁照樣有海報影格，只是不能播
    m.failed = true;
    await rm(out, { force: true });
    report.warnings.push(`影片 ${part} 轉不了（${String(e.message || e).split("\n").pop().slice(0, 160)}），那一頁只有海報`);
    log(`影片 ${part} 轉不了`, e.message);
  }
}
const slides = [];
for (const [i, s] of kept.entries()) {
  const k = String(i + 1).padStart(2, "0");
  const paras = (await deck.paragraphs(s.path)).map((t) => t.trim()).filter(Boolean);
  const entry = { n: i + 1, src: s.n, img: `${WEB}/s${k}.webp`, thumb: `${WEB}/t${k}.webp`, title: s.title, text: paras.join("\n").slice(0, 1500), block: s.block, chapter: s.chapter };
  if (s.media?.length) {
    entry.media = [];
    for (const [j, m] of s.media.entries()) {
      const item = { type: m.type, x: +m.x.toFixed(5), y: +m.y.toFixed(5), w: +m.w.toFixed(5), h: +m.h.toFixed(5) };
      if (m.url) item.url = m.url;
      if (m.part && !media.get(m.part).failed) item.src = `${WEB}/v${media.get(m.part).n}.mp4`;
      if (!item.src && !item.url) continue; // 轉不了的影片：那一頁的圖上本來就有海報影格
      if (m.posterBytes) {
        const file = path.join(TMP, `p${k}-${j}`);
        await writeFile(file, m.posterBytes);
        run("python3", [path.join(ROOT, "scripts/web-deck/raster.py"), "image", file, path.join(OUT, `p${k}-${j}.webp`), "--max", "1600"]);
        item.poster = `${WEB}/p${k}-${j}.webp`;
      }
      entry.media.push(item);
    }
    if (!entry.media.length) delete entry.media;
  }
  slides.push(entry);
}

// 10. deck.json；舊版本的資料夾清掉（站台上只留這一份）
const dir = path.join(ROOT, "public/assets/deck");
for (const name of await readdir(dir)) if (name !== VERSION && (await stat(path.join(dir, name))).isDirectory()) await rm(path.join(dir, name), { recursive: true, force: true });
const deckJson = {
  _comment: "網頁版簡報 /deck 的頁序與每一頁的圖、字、影片位置（x、y、w、h 是佔投影片寬高的比例）。由 scripts/web-deck/build.mjs 從母簡報產生，不要手改；母簡報改版就改 scripts/web-deck/source.json 重跑（見 CLAUDE.md）。",
  version: VERSION,
  // 不記 Drive 的檔案 ID：這一份是公開的，用不到就不放
  source: { title: SOURCE.title || path.basename(masterPath), slides: all.length },
  built_at: new Date().toISOString(),
  width: raster.width, height: raster.height,
  slides,
  excluded,
  build: { ...report, image_bytes: raster.bytes },
};
await writeFile(path.join(ROOT, "public/data/deck.json"), JSON.stringify(deckJson, null, 1) + "\n");
await rm(TMP, { recursive: true, force: true });
log(`完成：${slides.length} 頁、${media.size} 支影片、圖共 ${(raster.bytes / 1e6).toFixed(1)} MB`);
