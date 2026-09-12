import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { mergeGuests } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 訪客名片（後台「資料」分頁）：現場拍一張名片，AI 讀成名單。
 * 照片先存下來，讀名片交給 cards-background（一般函式只有 10 秒）。
 *
 * GET  /api/cards?job=<id>                                                → 進度與結果（people）
 * POST /api/cards {visit_id, image: dataURL|base64, media_type}           → 202 {job_id, photo_key}；**不會自己寫進名單**
 * POST /api/cards {visit_id, action:"save", guests:[...], photo_key}      → 確認後併進 visit.guests（email 或姓名＋單位相同就只補空欄位）
 * POST /api/cards {visit_id, action:"remove", key}                        → 刪掉這張名片原圖
 *
 * 名片原圖留著（跟簽名簿一樣）：讀錯時可以回頭核對，Drive 備份也會一起帶走。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "名片");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");
  const cards: { key: string; names: string[]; read_at: string }[] = Array.isArray((visit as any).cards) ? (visit as any).cards : [];
  const isCardKey = (x: string) => /^cards\/[\w-]+\/[\w.-]+$/.test(x);

  if (body.action === "save") {
    // 只有「整批都沒東西可讀」才算錯；同一張名片再存一次是沒事的 no-op（added=merged=0）
    const incoming = (Array.isArray(body.guests) ? body.guests : []).filter((g: any) => String(g?.name || "").trim() || String(g?.email || "").trim());
    if (!incoming.length) return fail(400, "沒有可以加進名單的資料（姓名與 email 至少要有一個）");
    const { guests, added, merged } = mergeGuests(visit.guests, incoming);
    visit.guests = guests;
    visit.headcount = Math.max(Number(visit.headcount) || 0, guests.length);
    const key = String(body.photo_key || "");
    if (isCardKey(key) && !cards.some((c) => c.key === key)) {
      cards.push({ key, names: (body.guests || []).map((g: any) => String(g?.name || "").trim()).filter(Boolean), read_at: nowISO() });
      (visit as any).cards = cards;
    }
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, added, merged, guests: visit.guests, cards });
  }

  if (body.action === "remove") {
    const key = String(body.key || "");
    if (isCardKey(key)) await store.deleteMedia(key).catch(() => {});
    (visit as any).cards = cards.filter((c) => c.key !== key);
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, cards: (visit as any).cards });
  }

  const raw = String(body.image || "");
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
  const mediaType = (m ? m[1] : body.media_type || "image/jpeg").toLowerCase();
  const b64 = (m ? m[2] : raw).replace(/\s/g, "");
  if (!b64) return fail(400, "需要 image");
  if (!mediaType.startsWith("image/")) return fail(400, "名片請上傳照片");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > 4.5 * 1024 * 1024) return fail(413, "照片超過 4.5 MB，請先縮小（後台會自動縮到長邊 2000px）");
  const ext = mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
  const key = `cards/${visit.visit_id}/${Date.now()}.${ext}`;
  await store.putMedia(key, new Uint8Array(bytes), mediaType);
  const started = await startBackground("cards", { visit_id: visit.visit_id, photo_key: key, media_type: mediaType }, req);
  const out = await started.json();
  return json({ ...out, photo_key: key }, { status: started.status });
};
