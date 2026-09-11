import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { sanitizeMaterials } from "../../lib/visit.mjs";

/**
 * 專屬頁面的「當天資料」（訪後信只能承諾頁面上真的有的東西，所以資料要先放上來）。
 *
 * POST /api/materials {visit_id, action:"upload", kind:"photo"|"pdf", name, data: dataURL|base64} → {key, url, materials}
 *      photo 進 photos[]；pdf 成為 deck_pdf（換掉舊的）。單檔上限 4.5 MB（Netlify 請求上限），更大的 PDF 請改貼雲端連結。
 * POST /api/materials {visit_id, action:"save", materials:{deck_pdf, photos, links}}             → 覆寫（連結、排序、刪除都走這裡）
 * POST /api/materials {visit_id, action:"remove", key}                                            → 拿掉並刪檔
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");
  const current = sanitizeMaterials(visit.materials);
  const isKey = (x: string) => /^materials\/[\w-]+\/[\w.-]+$/.test(x);

  if (body.action === "save") {
    const next = sanitizeMaterials(body.materials);
    // 被拿掉的媒體檔一起刪
    const keep = new Set([next.deck_pdf, ...next.photos]);
    for (const k of [current.deck_pdf, ...current.photos]) if (k && isKey(k) && !keep.has(k)) await store.deleteMedia(k).catch(() => {});
    visit.materials = next;
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, materials: next });
  }

  if (body.action === "remove") {
    const key = String(body.key || "");
    const next = sanitizeMaterials({ ...current, deck_pdf: current.deck_pdf === key ? "" : current.deck_pdf, photos: current.photos.filter((p: string) => p !== key) });
    if (isKey(key)) await store.deleteMedia(key).catch(() => {});
    visit.materials = next;
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, materials: next });
  }

  if (body.action === "upload") {
    const kind = body.kind === "pdf" ? "pdf" : "photo";
    const raw = String(body.data || "");
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
    const mediaType = (m ? m[1] : body.media_type || (kind === "pdf" ? "application/pdf" : "image/jpeg")).toLowerCase();
    const b64 = (m ? m[2] : raw).replace(/\s/g, "");
    if (!b64) return fail(400, "需要 data");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > 4.5 * 1024 * 1024) return fail(413, kind === "pdf" ? "PDF 超過 4.5 MB：請放到雲端（Drive／OneDrive）再貼連結" : "照片超過 4.5 MB，請先縮小（後台會自動縮到長邊 1600px）");
    if (kind === "pdf" && !mediaType.includes("pdf")) return fail(400, "簡報請上傳 PDF");
    if (kind === "photo" && !mediaType.startsWith("image/")) return fail(400, "合照請上傳圖片檔");
    const ext = kind === "pdf" ? "pdf" : mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
    const base = String(body.name || "").replace(/\.[^.]+$/, "").normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || (kind === "pdf" ? "slides" : "photo");
    const key = `materials/${visit.visit_id}/${Date.now()}-${base}.${ext}`;
    await store.putMedia(key, new Uint8Array(bytes), kind === "pdf" ? "application/pdf" : mediaType);
    const next = { ...current };
    if (kind === "pdf") {
      if (current.deck_pdf && isKey(current.deck_pdf)) await store.deleteMedia(current.deck_pdf).catch(() => {});
      next.deck_pdf = key;
    } else {
      if (current.photos.length >= 30) return fail(400, "合照最多 30 張");
      next.photos = [...current.photos, key];
    }
    visit.materials = sanitizeMaterials(next);
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, key, url: `/api/media?key=${encodeURIComponent(key)}`, materials: visit.materials });
  }

  return fail(400, "action 需要是 upload、save 或 remove");
};
