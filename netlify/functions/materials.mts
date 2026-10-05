import { fail, json, nowISO, readJSON, rejectHeic, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { isMaterialKey, sanitizeMaterials } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 專屬頁面的「當天資料」（簡報 PDF、合照），與**答應提供給對方的資料**（明確指示：「要加入答應提供給對方的資料，如檔案網頁等等」
 * 「能夠接受不同格式的檔案圖片或是檔案連結」）——後者是 `links`：網址，或上傳的檔案；感謝信逐項列出，來賓專頁也放。
 * 訪後信只能承諾頁面上真的有的東西，所以資料要先放上來。
 *
 * POST /api/materials {visit_id, action:"upload", kind:"photo"|"pdf", name, data: dataURL|base64} → {key, url, materials}
 *      photo 進 photos[]；pdf 成為 deck_pdf（換掉舊的）。單檔上限 4.5 MB（Netlify 請求上限），更大的 PDF 請改貼雲端連結。
 * POST multipart（visit_id, kind=file, file, title?）                                              → 答應提供的檔案：各種文件、圖片、壓縮檔，進 links[]
 * POST /api/materials {visit_id, action:"save", materials:{deck_pdf?, photos?, links?}}             → **只換帶來的那幾格**（拿掉的檔案一起刪）
 * POST /api/materials {visit_id, action:"remove", key}                                            → 拿掉並刪檔
 */
const MAX_BYTES = 4.5 * 1024 * 1024;
const MAX_LINKS = 30;

/**
 * 答應提供的檔案收哪些格式：副檔名 → 存檔與下載時的 content-type（**不照瀏覽器說的**，照這張表）。
 * 網頁、SVG、程式這類打開會執行東西的不收——檔案是放在站台自己的網址底下給人點的。
 */
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  key: "application/vnd.apple.keynote",
  pages: "application/vnd.apple.pages",
  numbers: "application/vnd.apple.numbers",
  rtf: "application/rtf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  epub: "application/epub+zip",
  zip: "application/zip",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** 上傳時原本的檔名（下載時就叫這個名字）：拿掉路徑與控制字元。 */
const cleanName = (n: string) => String(n || "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, "").trim().slice(-120) || "file";
/** 媒體庫 key 只能用英數字：中文檔名轉不出來就叫 file（原本的檔名另外記在 metadata）。 */
const slug = (n: string) => n.replace(/\.[^.]+$/, "").normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: any = null;
  let upload: { bytes: Uint8Array; name: string; type: string } | null = null;
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    body = { visit_id: form.get("visit_id"), action: form.get("action") || "upload", kind: form.get("kind") || "file", title: form.get("title") || "" };
    const f = form.get("file");
    if (f && typeof f !== "string") upload = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name || "file", type: f.type || "" };
  } else body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");
  const current = sanitizeMaterials(visit.materials);
  // 只認這一場自己的檔案：別場的 key 混進來的話，這裡一拿掉就會把別場的檔案刪掉
  const mine = (x: string) => isMaterialKey(x) && x.startsWith(`materials/${visit.visit_id}/`);
  const keysOf = (m: ReturnType<typeof sanitizeMaterials>) => [m.deck_pdf, ...m.photos, ...m.links.map((l: { url: string }) => l.url)].filter(mine);

  // 改 materials 這一格一律在 updateVisit 裡做（只動這一格、寫進最新的那一份）；刪檔、上傳這種事放在外面
  if (body.action === "save") {
    const incoming = body.materials && typeof body.materials === "object" ? body.materials : {};
    let before = current;
    let next = current;
    await store.updateVisit(visit.visit_id, (v) => {
      before = sanitizeMaterials(v.materials);
      // **只換帶來的那幾格**：當天資料（PDF、合照）與答應提供的資料在兩張卡片上各自存，不要互相蓋掉
      const patch: Record<string, unknown> = {};
      for (const k of ["deck_pdf", "photos", "links"]) if (k in incoming) patch[k] = incoming[k];
      const merged = sanitizeMaterials({ ...before, ...patch });
      // 上傳的檔案：原本的檔名照伺服器上那一份（畫面送回來的可能沒帶）；別場的 key 不收
      const names = new Map(before.links.map((l: { url: string; name?: string }) => [l.url, l.name]));
      merged.links = merged.links
        .filter((l: { url: string }) => !isMaterialKey(l.url) || mine(l.url))
        .map((l: { url: string; name?: string; title: string }) => (isMaterialKey(l.url) && !l.name && names.get(l.url) ? { ...l, name: names.get(l.url) } : l));
      if (merged.deck_pdf && isMaterialKey(merged.deck_pdf) && !mine(merged.deck_pdf)) merged.deck_pdf = "";
      merged.photos = merged.photos.filter((p: string) => !isMaterialKey(p) || mine(p));
      next = merged;
      v.materials = next;
      v.updated_at = nowISO();
    });
    // 被拿掉的媒體檔一起刪
    const keep = new Set(keysOf(next));
    for (const k of keysOf(before)) if (!keep.has(k)) await store.deleteMedia(k).catch(() => {});
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, materials: next });
  }

  if (body.action === "remove") {
    const key = String(body.key || "");
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      const cur = sanitizeMaterials(v.materials);
      v.materials = sanitizeMaterials({ ...cur, deck_pdf: cur.deck_pdf === key ? "" : cur.deck_pdf, photos: cur.photos.filter((p: string) => p !== key), links: cur.links.filter((l: { url: string }) => l.url !== key) });
      v.updated_at = nowISO();
    });
    if (mine(key)) await store.deleteMedia(key).catch(() => {});
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, materials: saved?.materials || current });
  }

  // 答應提供的檔案：各種文件、圖片、壓縮檔（multipart，4.5 MB 以內；更大的放雲端貼連結）
  if (body.action === "upload" && body.kind === "file") {
    if (!upload) return fail(400, "需要 file");
    if (!upload.bytes.length) return fail(400, "這個檔案是空的");
    if (upload.bytes.length > MAX_BYTES) return fail(413, "檔案超過 4.5 MB：請放到雲端（Drive／OneDrive）再貼連結");
    const name = cleanName(upload.name);
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] || "").toLowerCase();
    const heic = rejectHeic(upload.type) || (/^hei[cf]$/.test(ext) ? rejectHeic("image/heic") : null);
    if (heic) return heic;
    const type = FILE_TYPES[ext];
    if (!type) return fail(415, `這種檔案（${ext ? `.${ext}` : "沒有副檔名"}）不收：請存成 PDF、Word、PowerPoint、Excel、圖片或壓縮檔，或放到雲端再貼連結`);
    if (current.links.length >= MAX_LINKS) return fail(400, `答應提供的資料最多 ${MAX_LINKS} 項`);
    const key = `materials/${visit.visit_id}/${Date.now()}-${slug(name) || "file"}.${ext}`;
    await store.putMedia(key, upload.bytes, type, name);
    const title = String(body.title || "").trim().slice(0, 160) || name.replace(/\.[^.]+$/, "");
    let full = false;
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      const cur = sanitizeMaterials(v.materials);
      full = cur.links.length >= MAX_LINKS;
      if (full) return false;
      v.materials = sanitizeMaterials({ ...cur, links: [...cur.links, { title, url: key, name }] });
      v.updated_at = nowISO();
    });
    if (full) {
      await store.deleteMedia(key).catch(() => {});
      return fail(400, `答應提供的資料最多 ${MAX_LINKS} 項`);
    }
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, key, url: `/api/media?key=${encodeURIComponent(key)}`, materials: saved?.materials || current });
  }

  if (body.action === "upload") {
    const kind = body.kind === "pdf" ? "pdf" : "photo";
    const raw = String(body.data || "");
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
    const mediaType = (m ? m[1] : body.media_type || (kind === "pdf" ? "application/pdf" : "image/jpeg")).toLowerCase();
    const b64 = (m ? m[2] : raw).replace(/\s/g, "");
    if (!b64) return fail(400, "需要 data");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > MAX_BYTES) return fail(413, kind === "pdf" ? "PDF 超過 4.5 MB：請放到雲端（Drive／OneDrive）再貼連結" : "照片超過 4.5 MB，請先縮小（後台會自動縮到長邊 1600px）");
    if (kind === "pdf" && !mediaType.includes("pdf")) return fail(400, "簡報請上傳 PDF");
    if (kind === "photo" && !mediaType.startsWith("image/")) return fail(400, "合照請上傳圖片檔");
    const heic = rejectHeic(mediaType);
    if (heic) return heic;
    const ext = kind === "pdf" ? "pdf" : mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
    const base = slug(String(body.name || "")) || (kind === "pdf" ? "slides" : "photo");
    if (kind === "photo" && current.photos.length >= 30) return fail(400, "合照最多 30 張");
    const key = `materials/${visit.visit_id}/${Date.now()}-${base}.${ext}`;
    await store.putMedia(key, new Uint8Array(bytes), kind === "pdf" ? "application/pdf" : mediaType, body.name ? cleanName(String(body.name)) : undefined);
    let replaced = "";
    let full = false;
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      const cur = sanitizeMaterials(v.materials);
      const next = { ...cur };
      replaced = "";
      if (kind === "pdf") {
        replaced = cur.deck_pdf;
        next.deck_pdf = key;
      } else {
        full = cur.photos.length >= 30;
        if (full) return false;
        next.photos = [...cur.photos, key];
      }
      v.materials = sanitizeMaterials(next);
      v.updated_at = nowISO();
    });
    if (full) {
      await store.deleteMedia(key).catch(() => {});
      return fail(400, "合照最多 30 張");
    }
    if (replaced && replaced !== key && mine(replaced)) await store.deleteMedia(replaced).catch(() => {});
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, key, url: `/api/media?key=${encodeURIComponent(key)}`, materials: saved?.materials || current });
  }

  return fail(400, "action 需要是 upload、save 或 remove");
};
