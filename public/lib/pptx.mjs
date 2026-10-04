/**
 * 母簡報子集化核心（CLAUDE.md「不要從零生成簡報」）——瀏覽器與 Node 共用，沒有任何 Node 專屬相依。
 * 解壓 → 選頁／重排 → 複製頁 → 改文字 → 換第二語言 → 加圖 → 清孤兒 → 驗證 → 重壓。
 *
 * 結構性檔案（presentation.xml、.rels、[Content_Types].xml）用 XML 解析器處理；
 * 投影片內文只動 <a:t> 文字節點與整個 <a:r>／<a:p>，不 round-trip 整份投影片 XML，
 * 以免改寫 namespace prefix 毀檔。
 *
 * 相依由呼叫端注入（configure）：
 *   瀏覽器  configure({ JSZip: window.JSZip, DOMParser: window.DOMParser })   ← admin.html 直接在瀏覽器產檔
 *   Node    cli/lib/pptx.mjs 注入 jszip 與 @xmldom/xmldom
 */
const deps = { JSZip: globalThis.JSZip, DOMParser: globalThis.DOMParser };
export function configure(d) {
  Object.assign(deps, d);
  return deps;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const HAN = /\p{Script=Han}/u;
const EMU_PER_INCH = 914400;
/** 內嵌影片／音訊的副檔名（scripts/slim-master.py 同一份清單）。 */
export const MEDIA_EXT = new Set(["mp4", "m4v", "mov", "avi", "wmv", "mpg", "mpeg", "webm", "mkv", "asf", "m4a", "mp3", "wav", "wma", "aac"]);

export const DEFAULT_SITE = "https://visit.healsdesign.org";
export const EA_FONT = { ko: "Malgun Gothic", ja: "Yu Gothic", zh: "Microsoft JhengHei", en: "" };
export const LANG_TAG = { ko: "ko-KR", ja: "ja-JP", zh: "zh-TW", en: "en-US" };
export const ASK_TITLE = { en: "Which part would you most like to see?", zh: "您最想看哪一部分？", ko: "어느 부분을 가장 보고 싶으십니까?", ja: "どの部分を最もご覧になりたいですか。" };
export const QR_CAPTION = { en: "Today's slides, papers and contacts", zh: "當天簡報、論文與老師聯絡方式", ko: "오늘 발표 자료 · 논문 · 연락처", ja: "本日のスライド・論文・連絡先" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 封面那一塊裡「像來賓的一行」：Mr.／Ms.／Dr.／Prof.… 開頭，或樣板的 Guest Name／來賓姓名。 */
const GUEST_LINE = /^(?:(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Hon|Rev)\b\.?\s|Guest Name)|來賓姓名/i;
/** 「像日期的一行」：7 September 2026、Sep 7, 2026、2026 年 9 月 7 日、2026년 9월 7일、2026-09-07。 */
const MONTH_RE = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DATE_LINE = new RegExp(`\\b\\d{1,2}\\s+${MONTH_RE}\\s+\\d{4}\\b|\\b${MONTH_RE}\\s+\\d{1,2},?\\s+\\d{4}\\b|\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{4}년\\s*\\d{1,2}월\\s*\\d{1,2}일|\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b`, "i");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

/** 只換第一處、不吃 `$` 特殊字（String.replace 的替換字串會把 `$&` 之類的當成特殊字）。 */
const swapOnce = (str, find, rep) => {
  const i = str.indexOf(find);
  return i < 0 ? str : str.slice(0, i) + rep + str.slice(i + find.length);
};
/** 一個標籤的屬性（`<a:ext cx="1" cy="2"/>` → { cx: "1", cy: "2" }）。 */
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/\s([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
/** 改一個標籤裡幾個屬性的值（屬性本來就在才改）。 */
const withAttrs = (tag, values) => Object.entries(values).reduce((t, [k, v]) => t.replace(new RegExp(`(\\s${k}=")[^"]*(")`), (_, a, b) => `${a}${v}${b}`), tag);
/** 一段（a:p）的文字，run 合併。 */
const paraText = (p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unesc(m[1])).join("");
/** 一段的格式：段落屬性、第一個有字的 run 的字型屬性、段尾屬性——照這個格式寫新的一段。 */
const paraFormat = (p) => {
  const runs = [...p.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)].map((m) => m[0]);
  const run = runs.find((r) => /<a:t>[^<]*\S[^<]*<\/a:t>/.test(r)) || runs[0] || "";
  return {
    pPr: /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(p)?.[0] || "",
    rPr: /<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(run)?.[0] || "",
    endPr: /<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[^>]*>[\s\S]*?<\/a:endParaRPr>/.exec(p)?.[0] || "",
  };
};

/**
 * 點陣圖本身的寬高——**只讀檔頭，不解碼**（瀏覽器與 Node 都能用）：PNG、JPEG、GIF、BMP。讀不出來回 null。
 * `alpha`：有透明（PNG 的 alpha 通道或 tRNS、GIF）。那多半是疊在照片上的漸層、圖示——本來就是拉伸著用的。
 * `orientation`：JPEG 的 EXIF 方向（5–8 是轉了 90 度，寬高要對調著看）。
 */
export function imageInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b.length > 29 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    let alpha = b[25] === 4 || b[25] === 6; // 色彩型態 4、6 帶 alpha
    // tRNS（調色盤或灰階的透明色）一定在 IDAT 之前
    for (let i = 8; !alpha && i + 8 <= b.length; ) {
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === "tRNS") alpha = true;
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + u32(i);
    }
    return { type: "png", w: u32(16), h: u32(20), alpha, orientation: 1 };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let orientation = 1;
    for (let i = 2; i + 9 <= b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // 填充位元組
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // 沒有長度的標記
      if (marker === 0xe1 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === "Exif") orientation = exifOrientation(b, i + 10);
      // SOF0–15（C4 DHT、C8、CC DAC 不是）：高在 +5、寬在 +7
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "jpeg", w: u16(i + 7), h: u16(i + 5), alpha: false, orientation };
      if (marker === 0xda) return null;
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: "gif", w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8), alpha: true, orientation: 1 };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: "bmp", w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)), alpha: false, orientation: 1 };
  }
  return null;
}
/** EXIF 的方向（tag 0x0112）；讀不到回 1。tiff＝TIFF 檔頭（"II"／"MM"）在 bytes 裡的位置。 */
function exifOrientation(b, tiff) {
  if (tiff + 8 > b.length) return 1;
  const le = b[tiff] === 0x49;
  const u16 = (i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > b.length) return 1;
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) break;
    if (u16(e) === 0x0112) return u16(e + 8) || 1;
  }
  return 1;
}

export function relsPath(part) {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

export function resolveTarget(fromPart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== "." && seg !== "") base.push(seg);
  }
  return base.join("/");
}

/** xmldom（Node）與原生 DOMParser（瀏覽器）都能用：前者靠 onError 回呼，後者靠 <parsererror>。 */
function parseXml(text, what = "xml") {
  const Parser = deps.DOMParser;
  if (!Parser) throw new Error("沒有 XML 解析器：瀏覽器有原生 DOMParser，Node 請經由 cli/lib/pptx.mjs 載入");
  let err = null;
  const parser = new Parser({ onError: (level, msg) => { if (level === "fatalError" || level === "error") err = err || msg; } });
  const doc = parser.parseFromString(text, "text/xml");
  if (!err) {
    const pe = doc.getElementsByTagName ? doc.getElementsByTagName("parsererror") : [];
    if (pe && pe.length) err = (pe[0].textContent || "parse error").trim().slice(0, 200);
  }
  if (err) throw new Error(`${what}: ${err}`);
  return doc;
}

export class Deck {
  constructor(zip) {
    this.zip = zip;
    this.dirty = new Map();
  }

  static async load(buffer) {
    if (!deps.JSZip) throw new Error("沒有 JSZip：瀏覽器請先載入 jszip，Node 請經由 cli/lib/pptx.mjs 載入");
    return new Deck(await deps.JSZip.loadAsync(buffer, { createFolders: false }));
  }

  files() {
    return Object.keys(this.zip.files).filter((f) => !this.zip.files[f].dir);
  }
  has(path) {
    return !!this.zip.files[path] && !this.zip.files[path].dir;
  }
  async text(path) {
    if (this.dirty.has(path)) return dec.decode(this.dirty.get(path));
    const f = this.zip.file(path);
    if (!f) throw new Error(`找不到 ${path}`);
    return f.async("string");
  }
  async bytes(path) {
    if (this.dirty.has(path)) return this.dirty.get(path);
    const f = this.zip.file(path);
    if (!f) throw new Error(`找不到 ${path}`);
    return f.async("uint8array");
  }
  set(path, content) {
    const buf = content instanceof Uint8Array ? content : enc.encode(String(content));
    this.dirty.set(path, buf);
    this.zip.file(path, buf, { createFolders: false });
  }
  remove(path) {
    this.dirty.delete(path);
    this.zip.remove(path);
  }

  // ── rels / content types ──
  async rels(part) {
    const p = relsPath(part);
    if (!this.has(p)) return [];
    const doc = parseXml(await this.text(p), p);
    return [...doc.getElementsByTagNameNS(REL_NS, "Relationship")].map((r) => ({
      id: r.getAttribute("Id"),
      type: r.getAttribute("Type"),
      target: r.getAttribute("Target"),
      external: r.getAttribute("TargetMode") === "External",
      part: r.getAttribute("TargetMode") === "External" ? null : resolveTarget(part, r.getAttribute("Target")),
    }));
  }
  async addRel(part, type, target, external = false) {
    const p = relsPath(part);
    const xml = this.has(p) ? await this.text(p) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}"></Relationships>`;
    const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]);
    const id = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    const rel = `<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`;
    this.set(p, xml.replace(/<\/Relationships>\s*$/, `${rel}</Relationships>`));
    return id;
  }
  async removeRel(part, id) {
    const p = relsPath(part);
    const xml = await this.text(p);
    this.set(p, xml.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*/>`), ""));
  }
  async contentTypes() {
    const doc = parseXml(await this.text("[Content_Types].xml"), "[Content_Types].xml");
    const defaults = new Map([...doc.getElementsByTagNameNS(CT_NS, "Default")].map((d) => [d.getAttribute("Extension").toLowerCase(), d.getAttribute("ContentType")]));
    const overrides = new Map([...doc.getElementsByTagNameNS(CT_NS, "Override")].map((o) => [o.getAttribute("PartName"), o.getAttribute("ContentType")]));
    return { doc, defaults, overrides };
  }
  async ensureDefault(ext, contentType) {
    const { defaults } = await this.contentTypes();
    if (defaults.has(ext)) return;
    const xml = await this.text("[Content_Types].xml");
    this.set("[Content_Types].xml", xml.replace(/<Default\b/, `<Default Extension="${ext}" ContentType="${contentType}"/><Default`));
  }
  async addOverride(partName, contentType) {
    const xml = await this.text("[Content_Types].xml");
    if (xml.includes(`PartName="${partName}"`)) return;
    this.set("[Content_Types].xml", xml.replace(/<\/Types>\s*$/, `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`));
  }
  async removeOverride(partName) {
    const xml = await this.text("[Content_Types].xml");
    this.set("[Content_Types].xml", xml.replace(new RegExp(`<Override\\b[^>]*\\bPartName="${partName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`), ""));
  }

  // ── slides ──
  async slideSize() {
    const m = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(await this.text("ppt/presentation.xml"));
    return m ? { cx: +m[1], cy: +m[2] } : { cx: 12192000, cy: 6858000 };
  }

  /** 依 <p:sldIdLst> 順序列出投影片：[{n, id, rId, path}] */
  async slides() {
    const xml = await this.text("ppt/presentation.xml");
    const rels = await this.rels("ppt/presentation.xml");
    const byId = new Map(rels.map((r) => [r.id, r]));
    const list = [];
    for (const m of xml.matchAll(/<p:sldId\b([^>]*)\/>/g)) {
      const id = /\bid="(\d+)"/.exec(m[1])?.[1];
      const rId = /\br:id="([^"]+)"/.exec(m[1])?.[1];
      const rel = byId.get(rId);
      list.push({ n: list.length + 1, id: +id, rId, path: rel?.part || null });
    }
    return list;
  }

  /** 重寫 <p:sldIdLst>：只留 paths（依此順序）。 */
  async setSlideOrder(paths) {
    const all = await this.slides();
    const byPath = new Map(all.map((s) => [s.path, s]));
    const items = paths.map((p) => {
      const s = byPath.get(p);
      if (!s) throw new Error(`setSlideOrder: ${p} 不在簡報裡`);
      return `<p:sldId id="${s.id}" r:id="${s.rId}"/>`;
    });
    const xml = await this.text("ppt/presentation.xml");
    if (!/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.test(xml)) throw new Error("presentation.xml 沒有 sldIdLst");
    this.set("ppt/presentation.xml", xml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${items.join("")}</p:sldIdLst>`));
    // 被拿掉的頁：presentation.xml.rels 裡的關聯也要拿掉，否則 clean() 仍會把它（和它的 media）當成有人引用
    const keep = new Set(paths);
    for (const s of all) if (s.path && !keep.has(s.path)) await this.removeRel("ppt/presentation.xml", s.rId);
  }

  /** 複製一頁（含 rels，不含講者備忘），登記 content type、presentation rels 與 sldId（放最後）。回傳新頁 path。 */
  async cloneSlide(srcPath) {
    const nums = this.files().map((f) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1]).filter(Boolean).map(Number);
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    const newPath = `ppt/slides/slide${n}.xml`;
    this.set(newPath, await this.bytes(srcPath));
    const srcRels = relsPath(srcPath);
    if (this.has(srcRels)) {
      const xml = (await this.text(srcRels)).replace(/<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/g, "");
      this.set(relsPath(newPath), xml);
    }
    await this.addOverride(`/${newPath}`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml");
    const rId = await this.addRel("ppt/presentation.xml", REL_SLIDE, `slides/slide${n}.xml`);
    const all = await this.slides();
    const id = Math.max(255, ...all.map((s) => s.id)) + 1;
    const pres = await this.text("ppt/presentation.xml");
    this.set("ppt/presentation.xml", pres.replace(/<\/p:sldIdLst>/, `<p:sldId id="${id}" r:id="${rId}"/></p:sldIdLst>`));
    return newPath;
  }

  // ── text ──
  /** 該頁所有文字段落（依出現順序，段落內的 run 合併）。 */
  async paragraphs(path) {
    const xml = await this.text(path);
    const out = [];
    for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const t = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\/>/g)].map((m) => unesc(m[1] || "")).join("");
      if (t.trim()) out.push(t);
    }
    return out;
  }

  /** 標題（title／ctrTitle placeholder 的第一段），沒有就第一段文字。 */
  async title(path) {
    const xml = await this.text(path);
    const sp = findTitleShape(xml);
    const src = sp ? sp.xml : xml;
    const p = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/.exec(src);
    return p ? [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unesc(m[1])).join("") : "";
  }

  /**
   * 逐字取代：find 先比對單一 run，再比對整段（跨 run 時合併到第一個 run）。
   * `all: true` 時同一段裡每一處都換（預設只換第一處）。回傳取代次數。
   */
  async editText(path, edits) {
    let xml = await this.text(path);
    let count = 0;
    for (const { find, replace, all } of edits) {
      if (!find) continue;
      const swap = (text) => (all ? text.split(find).join(replace) : text.replace(find, replace));
      xml = xml.replace(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (para) => {
        const runs = [...para.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)];
        if (!runs.length) return para;
        const texts = runs.map((r) => unesc(/<a:t>([\s\S]*?)<\/a:t>/.exec(r[0])?.[1] ?? ""));
        const single = texts.findIndex((t) => t.includes(find));
        if (single >= 0) {
          count++;
          const r = runs[single][0];
          return para.replace(r, setRunText(r, swap(texts[single])));
        }
        const joined = texts.join("");
        if (!joined.includes(find)) return para;
        count++;
        let out = para;
        for (let i = runs.length - 1; i > 0; i--) out = out.replace(runs[i][0], "");
        return out.replace(runs[0][0], setRunText(runs[0][0], swap(joined)));
      });
    }
    this.set(path, xml);
    return count;
  }

  /** 把標題 placeholder 換成 lines（第 i 行沿用原第 i 段的 run 格式；超過就沿用最後一段）。 */
  async setTitle(path, lines) {
    const xml = await this.text(path);
    const sp = findTitleShape(xml) || { xml: /<p:sp\b[\s\S]*?<\/p:sp>/.exec(xml)?.[0] };
    if (!sp.xml) throw new Error(`${path} 沒有可改的標題形狀`);
    const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp.xml);
    if (!body) throw new Error(`${path} 標題沒有 txBody`);
    const paras = [...body[1].matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)].map((m) => m[0]);
    const tmpl = (i) => {
      const p = paras[Math.min(i, paras.length - 1)] || "<a:p><a:r><a:rPr lang=\"en-US\"/><a:t></a:t></a:r></a:p>";
      const pPr = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(p)?.[0] || "";
      const rPr = /<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(p)?.[0] || "";
      const endPr = /<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[^>]*>[\s\S]*?<\/a:endParaRPr>/.exec(p)?.[0] || "";
      return { pPr, rPr, endPr };
    };
    const newParas = lines.map((line, i) => {
      const t = tmpl(i);
      return `<a:p>${t.pPr}<a:r>${t.rPr}<a:t>${esc(line)}</a:t></a:r>${t.endPr}</a:p>`;
    });
    const firstIdx = body[1].indexOf(paras[0]);
    const head = firstIdx >= 0 ? body[1].slice(0, firstIdx) : body[1].replace(/<a:p\b[\s\S]*$/, "");
    const newBody = `<p:txBody>${head}${newParas.join("")}</p:txBody>`;
    this.set(path, xml.replace(sp.xml, sp.xml.replace(body[0], newBody)));
  }

  /**
   * 封面上寫來賓的那一塊（單位、來賓、日期）。明確指示：「首頁的部分應該要根據本次參訪者，更改首頁的內容」——
   * 母簡報的封面寫的是上一次的來賓，每一份產出的簡報都還是他們。
   * 認法：不是標題的文字框裡，像來賓的行（Mr.／Dr.／Prof.… 開頭，或樣板的 Guest Name）與像日期的行最多的那一個。
   * 要在**換語言之前**認：英文版會把含中文的行整行刪掉（母簡報的單位與日期那兩行都是「English · 中文」寫在同一段），
   * 刪掉之後就不知道那兩行長什麼樣子了。所以這裡只記下位置與每一種行的格式，換完語言再由 `fillVisitBox` 整塊重寫。
   * 回傳 { index, id, old, org, guest, date }（三種行的格式，母簡報裡沒有日期那一行時 date 是 null）；找不到回 null。
   */
  async visitBox(path) {
    const xml = await this.text(path);
    let best = null;
    [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].forEach((m, index) => {
      const sp = m[0];
      const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp);
      if (!body || /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp)) return;
      const paras = [...body[1].matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)].map((p) => ({ xml: p[0], text: paraText(p[0]).trim() })).filter((p) => p.text);
      const kinds = paras.map((p) => (GUEST_LINE.test(p.text) ? "guest" : DATE_LINE.test(p.text) ? "date" : "other"));
      const score = kinds.filter((k) => k === "guest").length * 2 + kinds.filter((k) => k === "date").length;
      if (score && (!best || score > best.score)) best = { score, index, id: /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(sp)?.[1] || "", paras, kinds };
    });
    if (!best) return null;
    const { paras, kinds } = best;
    const firstGuest = kinds.indexOf("guest");
    const dateAt = kinds.indexOf("date");
    // 單位是來賓前面那一行；認不出來賓的行（只認得出日期）時，日期前面第一行是單位、第二行是來賓
    const end = firstGuest >= 0 ? firstGuest : dateAt >= 0 ? dateAt : paras.length;
    const lead = paras.filter((p, i) => i < end && kinds[i] === "other");
    const orgP = lead[0], guestP = firstGuest >= 0 ? paras[firstGuest] : lead[1] || lead[0], dateP = dateAt >= 0 ? paras[dateAt] : null;
    const f = (p) => (p ? paraFormat(p.xml) : null);
    // 母簡報那一塊沒有單位那一行，單位也照樣寫（照來賓那一行的格式）：封面最要緊的就是哪個單位來
    return { index: best.index, id: best.id, old: paras.map((p) => p.text), org: f(orgP || guestP || dateP), guest: f(guestP || orgP || dateP), date: f(dateP) };
  }

  /**
   * 把 `visitBox` 認出來的那一塊整塊換成這一場的字（`coverLines`）：單位、來賓、日期各沿用母簡報那一種行的格式，
   * 上一次的來賓一行都不留。有韓文、日文的行換成對應的字型（不然會掉成方框）。回傳寫進去的行；那一塊不見了回 null。
   */
  async fillVisitBox(path, box, { org = "", guests = [], date = "" }, lang = "zh") {
    const xml = await this.text(path);
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
    const byId = box.id ? shapes.filter((sp) => new RegExp(`<p:cNvPr\\b[^>]*\\bid="${box.id}"`).test(sp)) : [];
    const sp = byId.length === 1 ? byId[0] : shapes[box.index];
    const body = sp && /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp);
    if (!body) return null;
    const lines = [];
    const para = (f, text) => {
      lines.push(text);
      let run = `<a:r>${f.rPr || '<a:rPr lang="en-US" dirty="0"/>'}<a:t>${esc(text)}</a:t></a:r>`;
      const script = scriptOf(text, lang);
      if (script) run = setRunFont(run, LANG_TAG[script], EA_FONT[script]);
      return `<a:p>${f.pPr}${run}${f.endPr}</a:p>`;
    };
    const out = [];
    if (org) out.push(para(box.org, org));
    for (const g of guests) out.push(para(box.guest, g));
    if (date && box.date) out.push(para(box.date, date));
    if (!out.length) out.push(`<a:p>${box.guest?.endPr || ""}</a:p>`); // 文字框至少要有一段
    const first = body[1].search(/<a:p\b/);
    const head = first >= 0 ? body[1].slice(0, first) : body[1];
    this.set(path, swapOnce(xml, sp, swapOnce(sp, body[0], `<p:txBody>${head}${out.join("")}</p:txBody>`)));
    return lines;
  }

  /** 含漢字的 run 文字（去重，保序），供翻譯。 */
  async cjkRuns(path) {
    const xml = await this.text(path);
    const seen = new Set();
    for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
      const t = unesc(m[1]);
      if (HAN.test(t)) seen.add(t);
    }
    return [...seen];
  }

  /**
   * 換第二語言：含漢字的 run → map.get(text)（沒有對應就不動），並設 lang 與 <a:ea> 字型。
   * map 為 null 時 = 純英文版：整個 run 刪掉；整段都被刪掉且不是唯一段落時，連段落一起刪。
   */
  async swapCjk(path, map, lang) {
    let xml = await this.text(path);
    const ea = EA_FONT[lang] || "";
    const tag = LANG_TAG[lang] || "en-US";
    xml = xml.replace(/<p:txBody>([\s\S]*?)<\/p:txBody>|<a:txBody>([\s\S]*?)<\/a:txBody>/g, (bodyXml) => {
      const paras = [...bodyXml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)].map((m) => m[0]);
      let out = bodyXml;
      for (const para of paras) {
        let np = para.replace(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g, (run) => {
          const t = unesc(/<a:t>([\s\S]*?)<\/a:t>/.exec(run)?.[1] ?? "");
          if (!HAN.test(t)) return run;
          if (map === null) return "";
          const rep = map.get(t);
          if (rep == null) return run;
          return setRunFont(setRunText(run, rep), tag, ea);
        });
        if (map === null && !/<a:r\b/.test(np) && paras.length > 1 && /<a:r\b/.test(para)) np = "";
        out = out.replace(para, np);
      }
      return out;
    });
    this.set(path, xml);
  }

  // ── pictures / text boxes ──
  async addPicture(path, pngBytes, { x, y, cx, cy }, name = "Picture") {
    const nums = this.files().map((f) => /^ppt\/media\/image(\d+)\./.exec(f)?.[1]).filter(Boolean).map(Number);
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    const media = `ppt/media/image${n}.png`;
    this.set(media, pngBytes);
    await this.ensureDefault("png", "image/png");
    const rId = await this.addRel(path, REL_IMAGE, `../media/image${n}.png`);
    const xml = await this.text(path);
    const id = nextShapeId(xml);
    const pic = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    this.set(path, xml.replace(/<\/p:spTree>/, `${pic}</p:spTree>`));
  }

  async addTextBox(path, lines, { x, y, cx, cy }, { size = 1800, lang = "en-US", align = "l", hlinkRId = "" } = {}) {
    const xml = await this.text(path);
    const id = nextShapeId(xml);
    const rPr = hlinkRId ? `<a:rPr lang="${lang}" sz="${size}" dirty="0"><a:hlinkClick r:id="${hlinkRId}"/></a:rPr>` : `<a:rPr lang="${lang}" sz="${size}" dirty="0"/>`;
    const paras = lines.map((l) => `<a:p><a:pPr algn="${align}"/><a:r>${rPr}<a:t>${esc(l)}</a:t></a:r></a:p>`).join("");
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
    this.set(path, xml.replace(/<\/p:spTree>/, `${sp}</p:spTree>`));
  }

  /**
   * **照片不拉變形**（明確指示：「產出的 ppt 照片不要拉變形」；既有標準：照片維持真實比例，不變形、不裁切、不旋轉）。
   * 每一張圖拿圖檔本身的寬高（扣掉作者自己的裁切 srcRect）跟它在投影片上的框比，比例差超過 2% 就是被拉變形了：
   *   - 一般的圖（p:pic）：**整張照片**照原比例放進原本的框裡、置中——作者的裁切一起拿掉，不裁切，框的旁邊留白。
   *     實際回報：只照比例縮的話「上下都被截斷了」——母簡報裡那一張本來就被裁掉上下一大塊，拉長的時候看不出來；
   *     原圖跟框同比例時（多半就是這樣：裁切是別的軟體轉檔時留下的），拿掉裁切就剛好填滿原本的框
   *   - 鋪滿整頁的背景：照原比例裁掉多出來的邊（鋪滿才是背景的用意；留白反而像壞掉）
   *   - 填了照片的形狀（圓形的老師照片之類，p:sp 的 a:blipFill）：形狀是版面的一部分、不動它，照片照比例裁到形狀的比例
   *   這兩種要裁的，**先從作者裁掉的地方補回來**（作者選的那一塊整個留著，`cover`），原圖不夠補才裁另一邊
   * 群組裡的要乘上群組的縮放（chExt → ext），轉了角度的框照樣以中心為準。不去動的：有透明的圖
   * （疊在照片上的漸層、圖示，本來就是拉伸著用的）、很小的圖、比例差到四倍以上的（多半是刻意拉長的裝飾條）、
   * 平鋪的填滿、填滿區另外內縮的、沒寫框大小的版面配置區、EXIF 轉了 90 度的照片（各家軟體顯示的方式不一樣，算不準就不動）。
   * 回傳更正了幾張。
   */
  async fixPictureAspect(path) {
    const { cx: slideW, cy: slideH } = await this.slideSize();
    const rels = new Map((await this.rels(path)).map((r) => [r.id, r]));
    const xml = await this.text(path);
    const info = new Map();
    const pct = (v) => Math.round(v * 100000);
    /** 這一塊的框、填滿與圖檔比例；不用動或算不準就回 null。fill＝放圖的那一段（p:blipFill 或 a:blipFill）。 */
    const measure = async (el, fill, scale) => {
      const blip = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(fill);
      const stretch = /<a:stretch\b[^>]*\/>|<a:stretch\b[^>]*>[\s\S]*?<\/a:stretch>/.exec(fill)?.[0];
      if (!blip || !stretch || /<a:tile\b/.test(fill) || /<a:fillRect\b[^>]*\s[ltrb]="-?[1-9]/.test(stretch)) return null;
      const rel = rels.get(blip[1]);
      if (!rel || rel.external || !rel.part || !this.has(rel.part)) return null;
      if (!info.has(rel.part)) info.set(rel.part, imageInfo(await this.bytes(rel.part)));
      const img = info.get(rel.part);
      if (!img || img.alpha || !(img.w >= 48 && img.h >= 48) || img.orientation >= 5) return null;
      const spPr = /<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/.exec(el)?.[0];
      const xfrm = spPr && /<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/.exec(spPr)?.[0];
      const offTag = xfrm && /<a:off\b[^>]*\/>/.exec(xfrm)?.[0];
      const extTag = xfrm && /<a:ext\b[^>]*\/>/.exec(xfrm)?.[0];
      if (!offTag || !extTag) return null; // 沒寫框大小（版面配置區）：不知道框多大，不去動
      const [x, y] = [+attrsOf(offTag).x, +attrsOf(offTag).y];
      const [cx, cy] = [+attrsOf(extTag).cx, +attrsOf(extTag).cy];
      if (!(cx > 0 && cy > 0)) return null;
      const srcTag = /<a:srcRect\b[^>]*\/>|<a:srcRect\b[^>]*>[\s\S]*?<\/a:srcRect>/.exec(fill)?.[0];
      const crop = srcTag ? attrsOf(srcTag) : {};
      const [l, t, r, b] = ["l", "t", "r", "b"].map((k) => (+crop[k] || 0) / 100000);
      const fx = 1 - l - r, fy = 1 - t - b;
      if (!(fx > 0 && fy > 0)) return null;
      const imgAspect = (img.w * fx) / (img.h * fy);
      const frameAspect = (cx * scale.sx) / (cy * scale.sy);
      const ratio = imgAspect / frameAspect;
      if (Math.abs(Math.log(ratio)) < Math.log(1.02) || ratio > 4 || ratio < 0.25) return null;
      return { spPr, xfrm, offTag, extTag, x, y, cx, cy, srcTag, l, t, r, b, fx, fy, W: img.w, H: img.h, imgAspect, frameAspect, ratio };
    };
    /**
     * 框不動，看得見的那一塊改成框的比例。**先從作者裁掉的地方補回來**——作者選的那一塊整個留著，
     * 只在不夠的那個方向往外擴（以那一塊的中心為準，碰到原圖的邊就往回推）；原圖不夠補，才從另一邊照比例裁。
     * 以前是在作者裁好的那一塊裡面再裁：母簡報裡被裁掉上下一大塊的照片，就只剩中間一小條。
     * 座標是原圖的比例（0–1，可以是負的＝留白）。
     */
    const cover = (fill, m) => {
      let [x0, x1, y0, y1] = [m.l, 1 - m.r, m.t, 1 - m.b];
      const [xlo, xhi, ylo, yhi] = [Math.min(0, x0), Math.max(1, x1), Math.min(0, y0), Math.max(1, y1)];
      const fit = (a0, a1, len, lo, hi) => { const s = Math.min(Math.max((a0 + a1 - len) / 2, lo), hi - len); return [s, s + len]; };
      // 補完之後只差不到 2% 就不再裁另一邊（跟判斷有沒有變形同一個門檻：看不出來的差，不值得裁掉一條）
      if (m.ratio > 1) {
        // 看得見的那一塊比框扁：先把上下補回來；原圖不夠高，就整張的高、左右照比例裁
        const h = ((x1 - x0) * m.W) / m.frameAspect / m.H;
        if (h <= yhi - ylo) [y0, y1] = fit(y0, y1, h, ylo, yhi);
        else {
          [y0, y1] = [ylo, yhi];
          const w = ((y1 - y0) * m.H * m.frameAspect) / m.W;
          if (w < (x1 - x0) / 1.02) [x0, x1] = fit(x0, x1, w, x0, x1);
        }
      } else {
        const w = ((y1 - y0) * m.H * m.frameAspect) / m.W;
        if (w <= xhi - xlo) [x0, x1] = fit(x0, x1, w, xlo, xhi);
        else {
          [x0, x1] = [xlo, xhi];
          const h = ((x1 - x0) * m.W) / m.frameAspect / m.H;
          if (h < (y1 - y0) / 1.02) [y0, y1] = fit(y0, y1, h, y0, y1);
        }
      }
      const attrs = [["l", x0], ["t", y0], ["r", 1 - x1], ["b", 1 - y1]].filter(([, v]) => pct(v)).map(([k, v]) => ` ${k}="${pct(v)}"`).join("");
      const rect = attrs ? `<a:srcRect${attrs}/>` : ""; // 補回來就是整張：不必再寫一個空的裁切
      if (m.srcTag) return swapOnce(fill, m.srcTag, rect);
      const blipEl = /<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/.exec(fill)?.[0];
      return blipEl ? swapOnce(fill, blipEl, blipEl + rect) : fill;
    };
    const fixPic = async (pic, scale) => {
      const fill = /<p:blipFill\b[^>]*>[\s\S]*?<\/p:blipFill>/.exec(pic)?.[0];
      const m = fill && (await measure(pic, fill, scale));
      if (!m) return pic;
      // 鋪滿整頁的背景：裁邊，框不動
      if (m.cx * scale.sx >= slideW * 0.9 && m.cy * scale.sy >= slideH * 0.9) return swapOnce(pic, fill, cover(fill, m));
      // 一般的圖：拿掉作者的裁切，**整張照片**照原比例放進原本的框裡、置中（原圖跟框同比例就剛好填滿，框不動）
      const full = m.W / m.H;
      const r = full / m.frameAspect;
      let [nx, ny, ncx, ncy] = [m.x, m.y, m.cx, m.cy];
      if (Math.abs(Math.log(r)) >= Math.log(1.02)) {
        if (r > 1) { ncy = Math.round((m.cx * scale.sx) / full / scale.sy); ny = Math.round(m.y + (m.cy - ncy) / 2); }
        else { ncx = Math.round((m.cy * scale.sy * full) / scale.sx); nx = Math.round(m.x + (m.cx - ncx) / 2); }
      }
      let next = m.srcTag ? swapOnce(pic, fill, swapOnce(fill, m.srcTag, "")) : pic;
      if (ncx !== m.cx || ncy !== m.cy) {
        const newXfrm = swapOnce(swapOnce(m.xfrm, m.offTag, withAttrs(m.offTag, { x: nx, y: ny })), m.extTag, withAttrs(m.extTag, { cx: ncx, cy: ncy }));
        next = swapOnce(next, m.spPr, swapOnce(m.spPr, m.xfrm, newXfrm));
      }
      return next;
    };
    const fixShape = async (sp, scale) => {
      const spPr = /<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/.exec(sp)?.[0];
      const fill = spPr && /<a:blipFill\b[^>]*>[\s\S]*?<\/a:blipFill>/.exec(spPr)?.[0];
      const m = fill && (await measure(sp, fill, scale));
      return m ? swapOnce(sp, fill, cover(fill, m)) : sp;
    };
    // 依序走過群組（群組的縮放＝ext ÷ chExt，一層一層乘上去）、圖與形狀。
    // 自己結束的 <p:grpSpPr/> 要排在前面：不然會一路吃到下一個 </p:grpSpPr>，把中間的圖一起吞掉
    const stack = [{ sx: 1, sy: 1 }];
    let out = "", last = 0, fixed = 0;
    for (const m of xml.matchAll(/<p:grpSpPr\b[^>]*\/>|<p:grpSpPr\b[^>]*>[\s\S]*?<\/p:grpSpPr>|<p:grpSp\b[^>]*>|<\/p:grpSp>|<p:pic\b[^>]*>[\s\S]*?<\/p:pic>|<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)) {
      const tok = m[0];
      if (tok.startsWith("<p:grpSpPr")) {
        if (stack.length < 2) continue; // spTree 自己那一份不算
        const ext = /<a:ext\b[^>]*\/>/.exec(tok)?.[0], ch = /<a:chExt\b[^>]*\/>/.exec(tok)?.[0];
        const e = ext ? attrsOf(ext) : {}, c = ch ? attrsOf(ch) : {};
        const parent = stack[stack.length - 2];
        stack[stack.length - 1] = { sx: parent.sx * (+c.cx > 0 && +e.cx > 0 ? +e.cx / +c.cx : 1), sy: parent.sy * (+c.cy > 0 && +e.cy > 0 ? +e.cy / +c.cy : 1) };
        continue;
      }
      if (tok === "</p:grpSp>") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (tok.startsWith("<p:grpSp")) {
        if (!tok.endsWith("/>")) stack.push({ ...stack[stack.length - 1] }); // 空的 <p:grpSp/> 沒有內容，不算一層
        continue;
      }
      const next = tok.startsWith("<p:pic") ? await fixPic(tok, stack[stack.length - 1]) : await fixShape(tok, stack[stack.length - 1]);
      if (next !== tok) {
        out += xml.slice(last, m.index) + next;
        last = m.index + tok.length;
        fixed++;
      }
    }
    if (fixed) this.set(path, out + xml.slice(last));
    return fixed;
  }

  /** 表格填值：保留表頭列，資料列不夠就複製最後一列，多的刪掉。rows = [[cell, ...], ...]。 */
  async fillTable(path, rows, { header = 1 } = {}) {
    const xml = await this.text(path);
    const tbl = /<a:tbl>[\s\S]*?<\/a:tbl>/.exec(xml);
    if (!tbl) return false;
    const trs = [...tbl[0].matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].map((m) => m[0]);
    const head = trs.slice(0, header);
    const body = trs.slice(header);
    if (!body.length) return false;
    const filled = rows.map((cells, i) => {
      const src = body[Math.min(i, body.length - 1)];
      let ci = 0;
      return src.replace(/<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g, (tc) => {
        const val = cells[ci++];
        if (val == null) return tc;
        const runs = [...tc.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)];
        if (!runs.length) return tc.replace(/<a:p\b[^>]*>/, (p) => `${p}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(val)}</a:t></a:r>`);
        let out = tc;
        for (let k = runs.length - 1; k > 0; k--) out = out.replace(runs[k][0], "");
        return out.replace(runs[0][0], setRunText(runs[0][0], val));
      });
    });
    const newTbl = tbl[0].replace(/<a:tr\b[\s\S]*<\/a:tr>/, [...head, ...filled].join(""));
    this.set(path, xml.replace(tbl[0], newTbl));
    return true;
  }

  // ── clean / validate / save ──
  /** 從根 rels 走一遍，刪掉所有到不了的 part（及其 rels 與 Override）。回傳刪掉的 part。 */
  async clean() {
    // 保險：不在 sldIdLst 裡的投影片關聯先剪掉
    const listed = new Set((await this.slides()).map((s) => s.path));
    for (const r of await this.rels("ppt/presentation.xml")) if (r.type === REL_SLIDE && r.part && !listed.has(r.part)) await this.removeRel("ppt/presentation.xml", r.id);
    const reachable = new Set(["[Content_Types].xml"]);
    const stack = [];
    for (const r of await this.rels("")) if (r.part && this.has(r.part)) stack.push(r.part);
    while (stack.length) {
      const p = stack.pop();
      if (reachable.has(p)) continue;
      reachable.add(p);
      if (this.has(relsPath(p))) reachable.add(relsPath(p));
      for (const r of await this.rels(p)) if (r.part && this.has(r.part) && !reachable.has(r.part)) stack.push(r.part);
    }
    if (this.has("_rels/.rels")) reachable.add("_rels/.rels");
    const removed = [];
    for (const f of this.files()) {
      if (reachable.has(f)) continue;
      if (f.startsWith("docProps/")) continue;
      removed.push(f);
      this.remove(f);
    }
    // 指向不存在 part 的 Override 一律清掉：抽掉影片、圖片換副檔名都會留下這種殘骸，
    // 留著 PowerPoint 會說檔案壞了（真母簡報把 mp4 宣告成 Override，不是 Default）
    const left = new Set(this.files());
    const { overrides } = await this.contentTypes();
    for (const [partName] of overrides) if (!left.has(partName.slice(1))) await this.removeOverride(partName);
    return removed;
  }

  async validate() {
    const errors = [];
    const warnings = [];
    const files = new Set(this.files());
    const { defaults, overrides } = await this.contentTypes();
    for (const f of files) {
      if (f === "[Content_Types].xml") continue;
      const ext = f.split(".").pop().toLowerCase();
      if (!overrides.has(`/${f}`) && !defaults.has(ext)) errors.push(`沒有 content type：${f}`);
      if (f.endsWith(".xml") || f.endsWith(".rels")) {
        try {
          parseXml(await this.text(f), f);
        } catch (e) {
          errors.push(`XML 壞掉：${e.message}`);
        }
      }
    }
    for (const [partName] of overrides) if (!files.has(partName.slice(1))) errors.push(`Override 指向不存在的 part：${partName}`);
    for (const f of files) {
      if (!f.endsWith(".rels")) continue;
      const owner = f.replace(/_rels\/([^/]+)\.rels$/, "$1");
      const ownerPart = owner === "" ? "" : owner;
      for (const r of await this.rels(ownerPart)) {
        if (r.external || !r.part) continue;
        if (!files.has(r.part)) errors.push(`${f}：${r.id} 指向不存在的 ${r.part}`);
      }
    }
    const slides = await this.slides();
    const ids = new Set();
    for (const s of slides) {
      if (!s.path || !files.has(s.path)) errors.push(`sldId ${s.id} 的 ${s.rId} 沒有對應投影片`);
      if (ids.has(s.id) || !(s.id > 255)) errors.push(`sldId id 不合法或重複：${s.id}`);
      ids.add(s.id);
    }
    if (!slides.length) errors.push("沒有投影片");
    const reachable = new Set();
    for (const s of slides) if (s.path) reachable.add(s.path);
    for (const f of files) if (/^ppt\/slides\/slide\d+\.xml$/.test(f) && !reachable.has(f)) warnings.push(`孤兒投影片：${f}`);
    return { errors, warnings, slideCount: slides.length };
  }

  /** 回傳 Uint8Array（Node 可直接 fs.writeFile；瀏覽器包成 Blob 下載）。onProgress(percent) 可選。 */
  async save(onProgress) {
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }, onProgress ? (meta) => onProgress(meta.percent) : undefined);
  }
}

/** 只看 zip 目錄：母簡報裡有沒有內嵌影片／音訊（要不要先瘦身）。 */
export async function hasEmbeddedMedia(buf) {
  const deck = await Deck.load(buf);
  return deck.files().some((f) => f.startsWith("ppt/media/") && MEDIA_EXT.has((f.split(".").pop() || "").toLowerCase()));
}

/** 把所有 rels 裡指到 oldPart 的 Target 改成 newPart（同目錄改名）。 */
async function retarget(deck, oldPart, newPart) {
  const oldName = oldPart.split("/").pop();
  const newName = newPart.split("/").pop();
  // 檔名前面要是「/」或什麼都沒有：image3.png 不能連 myimage3.png 一起改到
  const re = new RegExp(`(Target="(?:[^"]*/)?)${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
  for (const f of deck.files()) {
    if (!f.endsWith(".rels")) continue;
    const text = await deck.text(f);
    if (!text.includes(oldName)) continue;
    const next = text.replace(re, `$1${newName}"`);
    if (next !== text) deck.set(f, next);
  }
}

/**
 * 瘦身（scripts/slim-master.py 的同一套規則，給瀏覽器用）：
 *   1. 抽掉內嵌影片／音訊：留海報影格當靜態圖，加一行「▶ Video」文字（videoLinks[頁次] 有給連結就做成超連結）
 *   2. 超過 imageThreshold 的點陣圖交給 resizeImage(bytes, ext, maxEdge) → {bytes, ext}（瀏覽器用 canvas；回 null 表示不動）
 *   3. 清掉沒被引用的 media、驗證、重新壓縮
 * @returns {Promise<{ pptx: Uint8Array, report: { before, after, slides, videos_removed, images_resized, removed_parts, warnings } }>}
 */
export async function slimDeck(buf, { maxEdge = 2000, imageThreshold = 3_000_000, resizeImage = null, videoLinks = {}, log = () => {} } = {}) {
  const deck = await Deck.load(buf);
  const report = { before: buf.byteLength ?? buf.length, after: 0, slides: 0, videos_removed: 0, images_resized: 0, removed_parts: 0, warnings: [] };
  const slides = await deck.slides();
  report.slides = slides.length;

  // 1. 影片／音訊
  for (const s of slides) {
    if (!s.path) continue;
    const media = (await deck.rels(s.path)).filter((r) => {
      const typ = (r.type || "").split("/").pop();
      const ext = ((r.target || "").split("?")[0].split(".").pop() || "").toLowerCase();
      return ["video", "audio", "media"].includes(typ) || (!r.external && MEDIA_EXT.has(ext));
    });
    if (!media.length) continue;
    log(`第 ${s.n} 頁：抽掉 ${media.length} 個影片／音訊物件`);
    let xml = await deck.text(s.path);
    const labels = [];
    xml = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (pic) => {
      if (!/<a:videoFile\b|<a:audioFile\b|p14:media\b|ppaction:\/\/media/.test(pic)) return pic;
      let out = pic.replace(/<a:videoFile\b[^>]*\/>|<a:audioFile\b[^>]*\/>|<a:quickTimeFile\b[^>]*\/>/g, "");
      out = out.replace(/<p:extLst>(?:(?!<\/p:extLst>)[\s\S])*p14:media(?:(?!<\/p:extLst>)[\s\S])*<\/p:extLst>/g, "");
      out = out.replace(/<a:hlinkClick\b[^>]*ppaction:\/\/media[^>]*\/>/g, "");
      const m = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(out);
      if (m) labels.push({ x: +m[1], y: +m[2] + +m[4] + Math.round(EMU_PER_INCH * 0.08), cx: +m[3], cy: Math.round(EMU_PER_INCH * 0.45) });
      return out;
    });
    // 自動播放的 timing（只針對含媒體節點的）
    xml = xml.replace(/<p:timing>(?:(?!<\/p:timing>)[\s\S])*(?:<p:video\b|<p:audio\b|p14:media)(?:(?!<\/p:timing>)[\s\S])*<\/p:timing>/g, "");
    deck.set(s.path, xml);
    for (const r of media) await deck.removeRel(s.path, r.id);
    const link = videoLinks[s.n] || videoLinks[String(s.n)] || "";
    for (const box of labels) {
      if (link) {
        const rid = await deck.addRel(s.path, REL_HYPERLINK, link, true);
        await deck.addTextBox(s.path, [`▶ Video · 影片：${link}`], box, { size: 1400, hlinkRId: rid });
      } else await deck.addTextBox(s.path, ["▶ Video · 影片（另附連結）"], box, { size: 1400 });
    }
    // 同一支影片通常有兩條關聯（videoFile 的 r:link 與 p14:media 的 r:embed），算「幾支」要看不同的檔
    report.videos_removed += new Set(media.map((r) => r.part || r.target)).size;
  }

  // 2. 大圖
  if (resizeImage) {
    for (const part of deck.files()) {
      const m = /^ppt\/media\/([^/]+)\.(png|jpe?g|tiff?|bmp|gif)$/i.exec(part);
      if (!m) continue;
      const bytes = await deck.bytes(part);
      if (bytes.length <= imageThreshold) continue;
      // 照片帶著 EXIF 轉向的不縮：瀏覽器解圖時會照 EXIF 轉好、存回去就沒有 EXIF 了，各家軟體顯示的方式不一樣，
      // 一不小心就轉錯或拉變形——寧可留著大一點的原檔
      const pre = imageInfo(bytes);
      if (pre && pre.orientation !== 1) {
        report.warnings.push(`${part} 帶著拍照時的轉向資訊，維持原檔`);
        continue;
      }
      log(`縮圖 ${part}（${(bytes.length / 1e6).toFixed(1)} MB）`);
      let out = null;
      try {
        out = await resizeImage(bytes, m[2].toLowerCase(), maxEdge);
      } catch (e) {
        report.warnings.push(`縮圖失敗，維持原檔：${part}（${e.message || e}）`);
        continue;
      }
      if (!out || !out.bytes || out.bytes.length >= bytes.length) {
        report.warnings.push(`${part} 壓不小，維持原檔`);
        continue;
      }
      // 縮完的比例要跟原圖一樣（照片不拉變形）：解不出來、或寬高比差超過 1%（瀏覽器解大圖時偷偷縮了一邊之類），就維持原檔
      const before = pre, after = imageInfo(out.bytes);
      if (!before || !after || !(before.w && before.h && after.w && after.h) || Math.abs(after.w / after.h / (before.w / before.h) - 1) > 0.01) {
        report.warnings.push(`${part} 縮完比例不對，維持原檔`);
        continue;
      }
      const ext = out.ext === "png" ? "png" : "jpeg";
      // 換副檔名時不能撞到別張圖（image3.png → image3.jpeg，但 image3.jpeg 可能本來就是另一張）：
      // 撞到就換一個沒人用的名字——不然那一張會被蓋掉，用到它的那一頁變成顯示這一張、還被拉成那一張的框
      let newPart = `ppt/media/${m[1]}.${ext}`;
      for (let k = 2; newPart !== part && deck.has(newPart); k++) newPart = `ppt/media/${m[1]}-${k}.${ext}`;
      if (newPart !== part) {
        deck.remove(part);
        await retarget(deck, part, newPart);
        await deck.ensureDefault(ext, ext === "png" ? "image/png" : "image/jpeg");
      }
      deck.set(newPart, out.bytes);
      report.images_resized++;
    }
  }

  // 3. 清孤兒、驗證、重壓
  report.removed_parts = (await deck.clean()).length;
  const v = await deck.validate();
  if (v.errors.length) throw new Error(`瘦身後的檔案沒過驗證：\n- ${v.errors.join("\n- ")}`);
  log("重新壓縮…");
  const pptx = await deck.save((pct) => log(`重新壓縮 ${Math.round(pct)}%`));
  report.after = pptx.length;
  return { pptx, report };
}

function roleN(slidesIndex, role) {
  return slidesIndex?.slides?.find((s) => s.role === role)?.n;
}

/**
 * 封面那一塊這一場要寫的字（`Deck.fillVisitBox`）：單位、來賓（主賓排第一，最多三行）、日期。
 * 跟母簡報同一個寫法——英文為主，中／韓／日版在後面接「 · 」與對方的寫法（「Rural Development Administration · 韓國農村振興廳」
 * 「7 September 2026 · 2026 年 9 月 7 日」）；英文版只有英文。來賓一行是「姓名　職稱」。
 * 四位以上只寫前兩位，第三行寫「and N colleagues」——那一塊的大小是固定的，寧可少寫也不要縮字。
 */
export function coverLines(spec, lang = "zh") {
  const two = lang !== "en";
  const name = String(spec?.org?.name || "").trim(), local = String(spec?.org?.name_local || "").trim();
  const org = two ? [name, local && local !== name ? local : ""].filter(Boolean).join(" · ") : name || local;
  const list = (Array.isArray(spec?.guests) ? spec.guests : []).filter((g) => g && String(g.name || "").trim());
  const sorted = [...list.filter((g) => g.role === "lead"), ...list.filter((g) => g.role !== "lead")];
  let guests = sorted.map((g) => [String(g.name).trim(), String(g.title || "").trim()].filter(Boolean).join("　"));
  if (guests.length > 3) {
    const n = guests.length - 2;
    const tail = { zh: `及其他 ${n} 位來賓`, ko: `외 ${n}명`, ja: `ほか ${n} 名` }[lang];
    guests = [...guests.slice(0, 2), two && tail ? `and ${n} colleagues · ${tail}` : `and ${n} colleagues`];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(spec?.date || ""));
  let date = "";
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const loc = { zh: `${y} 年 ${mo} 月 ${d} 日`, ko: `${y}년 ${mo}월 ${d}일`, ja: `${y}年${mo}月${d}日` }[lang];
    date = `${d} ${MONTHS[mo - 1]} ${y}${two && loc ? ` · ${loc}` : ""}`;
  }
  return { org, guests, date };
}

/**
 * 核心：spec ＋ 母簡報 → { pptx: Uint8Array, report, dump }
 * @param {object} spec  visits 表的一筆（visit_id、slides、language、text_edits、programme、page_url、deck.*）
 * @param {Uint8Array|ArrayBuffer} masterBuf
 * @param {object} opts  { slidesIndex, lang, site, translate(texts, lang) → string[], translationCache: Map, qrPng(url) → Uint8Array|null, log }
 *   qrPng 由呼叫端提供（Node：qrcode 套件；瀏覽器：qrcodejs 的 canvas）。沒有就只放網址文字並記一筆 warning。
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

  // 3.5 照片不拉變形（明確指示）：母簡報裡被拉成別的比例的照片，照原比例放回框裡（Deck.fixPictureAspect）
  let picturesFixed = 0;
  for (const p of new Set(order)) picturesFixed += await deck.fixPictureAspect(p);
  if (picturesFixed) report.pictures_fixed = picturesFixed;

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

  // 4.5 母簡報內文的標準更正（public/data/master-fixes.json）：**與哪一場無關，每一份都套**。
  // 母簡報自己寫成「四間研究室／301-304」，但中心是五間、301-305——產出去給來賓的檔案不能是錯的。
  // 對不到不算錯（母簡報改好之後本來就對不到），報告只說套用了幾處、哪幾條有中。
  const fixes = (Array.isArray(opts.masterFixes) ? opts.masterFixes : []).filter((f) => f && f.find);
  if (fixes.length) {
    const hits = [];
    for (const f of fixes) {
      let n = 0;
      for (const p of order) n += await deck.editText(p, [f]);
      if (n) hits.push({ find: f.find, replace: f.replace, count: n });
    }
    if (hits.length) report.fixes = hits;
  }

  // 5. 今日流程表（第 2 頁若是表格）：時間、英文、第二語言、頁碼
  // 頁碼沒填就自己算（後台不再請人填這一欄）：總體簡報講的就是這一份從第 1 頁到最後一張選用頁，
  // 其他區塊沒有投影片寫「—」。最後那兩頁（您最想看哪一部分、QR）是另外加的，不算在裡面——跟以前 AI 填的算法一樣。
  const pad2 = (n) => String(n).padStart(2, "0");
  const slidesRange = (b) => String(b.slides_range || "").trim() || (b.kind === "briefing" ? `${pad2(1)} – ${pad2(chosen.length)}` : "—");
  const progN = roleN(slidesIndex, "programme") ?? 2;
  const progPath = byN.get(progN);
  if (progPath && order.includes(progPath) && Array.isArray(spec.programme) && spec.programme.length) {
    const cols = spec.deck?.programme_columns || ["time", "title_en", "title_2nd", "slides_range"];
    const rows = spec.programme.map((b) => cols.map((c) => (c === "time" ? `${b.start} – ${b.end}` : c === "slides_range" ? slidesRange(b) : String(b[c] ?? ""))));
    const ok = await deck.fillTable(progPath, rows);
    report.programme_table = ok ? "filled" : "no table on programme slide（用 text_edits）";
  }

  // 5.5 封面：先認出寫來賓的那一塊、記下每一種行的格式——下一步換語言時，英文版會把含中文的單位、日期整行刪掉（6.5 才重寫）。
  // 英文版的「歡迎蒞臨」也會被刪掉，封面就沒有歡迎的字了：先換成 Welcome
  const lang = opts.lang || spec.language || "zh";
  const coverPath = byN.get(Number(roleN(slidesIndex, "cover") ?? 1));
  const onCover = !!coverPath && order.includes(coverPath);
  const cover = coverLines(spec, lang);
  const coverWanted = onCover && !!(cover.org || cover.guests.length || cover.date);
  const coverBox = coverWanted ? await deck.visitBox(coverPath) : null;
  if (onCover && lang === "en") {
    const x = await deck.text(coverPath);
    const y = x.replace(/<a:t>\s*歡迎蒞臨\s*<\/a:t>/g, "<a:t>Welcome</a:t>");
    if (y !== x) deck.set(coverPath, y);
  }

  // 6. 第二語言
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

  // 6.5 封面換成這一場的單位、來賓、日期（明確指示：「首頁的部分應該要根據本次參訪者，更改首頁的內容」）。
  // 換完語言才寫，寫進去的字就不會被刪掉或拿去翻譯；照的是參訪紀錄（不是 AI 挑頁時的 cover_text——名單之後改過就舊了）
  if (coverBox) {
    const lines = await deck.fillVisitBox(coverPath, coverBox, cover, lang);
    if (lines) report.cover = lines;
  } else if (coverWanted) report.warnings.push("封面找不到寫來賓的那一塊（單位、來賓、日期），封面沒有換");

  // 7. 「您最想看哪一部分」頁標題
  if (askPath) {
    const lines = lang === "en" ? [ASK_TITLE.en] : [ASK_TITLE.en, ASK_TITLE[lang] || ASK_TITLE.zh];
    await deck.setTitle(askPath, lines);
  }

  // 8. QR 頁
  const site = (opts.site || DEFAULT_SITE).replace(/\/$/, "");
  const url = spec.page_url || `${site}/${spec.visit_id}`;
  const { cx, cy } = await deck.slideSize();
  const side = Math.round(cy * 0.42);
  const margin = Math.round(cx * 0.05);
  const x = cx - side - margin;
  const y = Math.round((cy - side) / 2) - Math.round(cy * 0.05);
  const png = opts.qrPng ? await opts.qrPng(url) : null;
  if (png && png.length) await deck.addPicture(qrPath, png, { x, y, cx: side, cy: side }, "Visit QR");
  else report.warnings.push("沒有 QR 產生器，QR 頁只放了網址文字");
  const captionLines = [url.replace(/^https?:\/\//, ""), lang === "en" ? QR_CAPTION.en : `${QR_CAPTION.en} · ${QR_CAPTION[lang] || QR_CAPTION.zh}`];
  await deck.addTextBox(qrPath, captionLines, { x: x - Math.round(side * 0.25), y: y + side + Math.round(cy * 0.02), cx: Math.round(side * 1.5), cy: Math.round(cy * 0.12) }, { size: 1400, align: "ctr" });
  report.page_url = url;

  // 9. 清孤兒、驗證
  report.removed_parts = (await deck.clean()).length;
  // 留在輸出裡的影片／音訊：現場播得動的那幾支。母簡報是瘦過的（影片抽掉了）就會是 0，
  // 這時海報那一頁靠「設定」填的影片連結。
  report.videos = deck.files().filter((f) => f.startsWith("ppt/media/") && MEDIA_EXT.has((f.split(".").pop() || "").toLowerCase())).length;
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

function findTitleShape(xml) {
  for (const m of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    if (/<p:ph\b[^>]*type="(title|ctrTitle)"/.test(m[0])) return { xml: m[0] };
  }
  return null;
}

function setRunText(run, text) {
  if (/<a:t>[\s\S]*?<\/a:t>/.test(run)) return run.replace(/<a:t>[\s\S]*?<\/a:t>/, `<a:t>${esc(text)}</a:t>`);
  return run.replace(/<a:t\/>/, `<a:t>${esc(text)}</a:t>`);
}

/** 這一行要換成哪一種東亞字型：有韓文用韓文的、有假名用日文的；只有漢字時跟著這一份的語言（中文版、英文版沿用原本的字型）。 */
function scriptOf(text, lang) {
  if (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (HAN.test(text) && (lang === "ko" || lang === "ja")) return lang;
  return "";
}

function setRunFont(run, lang, ea) {
  const eaEl = ea ? `<a:ea typeface="${esc(ea)}"/>` : "";
  if (/<a:rPr\b[^>]*\/>/.test(run)) {
    return run.replace(/<a:rPr\b([^>]*)\/>/, (_, attrs) => `<a:rPr${setLang(attrs, lang)}>${eaEl}</a:rPr>`);
  }
  if (/<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.test(run)) {
    return run.replace(/<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>/, (_, attrs, inner) => {
      let body = inner.replace(/<a:ea\b[^>]*\/>/, "");
      // <a:ea> 必須在 <a:latin> 之後、<a:cs> 之前；放在 latin 後面最安全
      if (eaEl) body = /<a:latin\b[^>]*\/>/.test(body) ? body.replace(/(<a:latin\b[^>]*\/>)/, `$1${eaEl}`) : /<a:cs\b/.test(body) ? body.replace(/(<a:cs\b)/, `${eaEl}$1`) : /<a:(sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b/.test(body) ? body.replace(/(<a:(?:sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b)/, `${eaEl}$1`) : body + eaEl;
      return `<a:rPr${setLang(attrs, lang)}>${body}</a:rPr>`;
    });
  }
  return run.replace(/<a:t>/, `<a:rPr lang="${lang}">${eaEl}</a:rPr><a:t>`);
}

function setLang(attrs, lang) {
  return /\blang="/.test(attrs) ? attrs.replace(/\blang="[^"]*"/, `lang="${lang}"`) : `${attrs} lang="${lang}"`;
}

function nextShapeId(xml) {
  const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => +m[1]);
  return (ids.length ? Math.max(...ids) : 1) + 1;
}
