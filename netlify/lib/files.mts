import JSZip from "jszip";

/**
 * 參訪名單／相關資料的檔案讀取（功能 1：查來信或相關資料）。
 * - Word .docx、Excel .xlsx／.xlsm、PowerPoint .pptx：解壓後抽純文字（表格列以 tab 分隔）
 * - .csv／.tsv／.txt／.md／.json／.eml：UTF-8，失敗退回 Big5（台灣舊版 Excel 匯出常見）
 * - .pdf、照片：不轉文字，原檔交給 Claude 直接讀（document／image block）
 * - .doc／.xls／其他：不支援，請另存新格式或貼上文字
 */
export type Extracted =
  | { kind: "text"; name: string; text: string }
  | { kind: "document"; name: string; media_type: "application/pdf"; data: string }
  | { kind: "image"; name: string; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }
  | { kind: "unsupported"; name: string; reason: string };

const MAX_TEXT = 200_000;
const IMAGE_TYPES: Record<string, Extracted["kind"] extends never ? never : "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};

const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export async function extractFile(name: string, mime: string, bytes: Uint8Array): Promise<Extracted> {
  const ext = extOf(name) || mimeToExt(mime);
  try {
    if (ext === "docx") return { kind: "text", name, text: clip(await docxText(bytes)) };
    if (ext === "xlsx" || ext === "xlsm") return { kind: "text", name, text: clip(await xlsxText(bytes)) };
    if (ext === "pptx") return { kind: "text", name, text: clip(await pptxText(bytes)) };
    if (["csv", "tsv", "txt", "md", "json", "eml", "text"].includes(ext)) return { kind: "text", name, text: clip(decodeText(bytes)) };
    if (ext === "pdf") return { kind: "document", name, media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") };
    if (IMAGE_TYPES[ext]) return { kind: "image", name, media_type: IMAGE_TYPES[ext], data: Buffer.from(bytes).toString("base64") };
    if (ext === "doc" || ext === "xls" || ext === "ppt") return { kind: "unsupported", name, reason: `舊版 Office 格式（.${ext}）：請在 Office 另存為 .${ext}x，或把內容貼到文字框` };
    if (!ext && looksLikeText(bytes)) return { kind: "text", name: name || "text", text: clip(decodeText(bytes)) };
    return { kind: "unsupported", name, reason: `不支援的格式（.${ext || "?"}）：支援 .docx .xlsx .pptx .csv .txt .pdf 與照片` };
  } catch (e: any) {
    return { kind: "unsupported", name, reason: `讀取失敗：${e?.message || e}` };
  }
}

function mimeToExt(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m.includes("presentationml")) return "pptx";
  if (m === "application/pdf") return "pdf";
  if (m === "text/csv") return "csv";
  if (m.startsWith("text/")) return "txt";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "";
}

function clip(s: string): string {
  const t = s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…（檔案太長，已截斷）` : t;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/** UTF-8（含 BOM）優先，解不開就試 Big5，再退回寬鬆 UTF-8。 */
export function decodeText(bytes: Uint8Array): string {
  let b = bytes;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    try {
      return new TextDecoder(b[0] === 0xff ? "utf-16le" : "utf-16be").decode(b.subarray(2));
    } catch {
      /* fall through */
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    try {
      return new TextDecoder("big5").decode(b);
    } catch {
      return new TextDecoder("utf-8").decode(b);
    }
  }
}

async function zipOf(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

function wParagraphText(p: string): string {
  return p
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>|<w:cr\/>/g, "\n")
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, t) => unesc(t))
    .replace(/<[^>]+>/g, "")
    .trim();
}

export async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await zipOf(bytes);
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("不是 .docx（沒有 word/document.xml）");
  const xml = await doc.async("string");
  const out: string[] = [];
  for (const m of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith("<w:tbl")) {
      for (const row of block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => wParagraphText(p[0])).filter(Boolean).join(" "));
        if (cells.some(Boolean)) out.push(cells.join("\t"));
      }
      out.push("");
    } else {
      out.push(wParagraphText(block));
    }
  }
  return out.join("\n");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function xlsxText(bytes: Uint8Array, { maxRows = 2000, maxSheets = 10 } = {}): Promise<string> {
  const zip = await zipOf(bytes);
  const wb = zip.file("xl/workbook.xml");
  if (!wb) throw new Error("不是 .xlsx（沒有 xl/workbook.xml）");
  const shared: string[] = [];
  const ss = zip.file("xl/sharedStrings.xml");
  if (ss) {
    const xml = await ss.async("string");
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(""));
  }
  const rels = new Map<string, string>();
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) for (const r of (await relsFile.async("string")).matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) rels.set(r[1], r[2]);
  const sheets: { name: string; path: string }[] = [];
  for (const s of (await wb.async("string")).matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(s[2]) || "";
    const path = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
    sheets.push({ name: unesc(s[1]), path });
  }
  if (!sheets.length) for (const f of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()) sheets.push({ name: f.replace(/.*\/(sheet\d+)\.xml$/, "$1"), path: f });
  const out: string[] = [];
  for (const sheet of sheets.slice(0, maxSheets)) {
    const f = zip.file(sheet.path);
    if (!f) continue;
    const xml = await f.async("string");
    out.push(`## ${sheet.name}`);
    let rows = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows++ >= maxRows) {
        out.push("…（列數太多，已截斷）");
        break;
      }
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] || "";
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || "";
        let val = "";
        if (type === "s") val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? "";
        else if (type === "inlineStr") val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join("");
        else if (type === "b") val = /<v>1<\/v>/.test(inner) ? "TRUE" : "FALSE";
        else val = unesc(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push("");
        cells[idx] = val;
      }
      if (cells.some((v) => v !== "")) out.push(cells.join("\t"));
    }
    out.push("");
  }
  return out.join("\n");
}

export async function pptxText(bytes: Uint8Array): Promise<string> {
  const zip = await zipOf(bytes);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!slides.length) throw new Error("不是 .pptx（沒有投影片）");
  const out: string[] = [];
  for (const [i, path] of slides.entries()) {
    const xml = await zip.file(path)!.async("string");
    out.push(`## Slide ${i + 1}`);
    for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const t = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unesc(m[1])).join("");
      if (t.trim()) out.push(t);
    }
    out.push("");
  }
  return out.join("\n");
}
