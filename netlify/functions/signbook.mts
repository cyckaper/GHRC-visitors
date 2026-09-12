import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { sanitizeResponse } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 簽名簿。照片先存下來（存檔很快），讀手寫字交給 signbook-background——
 * Claude 讀一整頁手寫常常超過一般函式的 10 秒。
 *
 * GET  /api/signbook?job=<id>                                                      → 進度與結果
 * POST /api/signbook {visit_id, image: dataURL|base64, media_type}                  → 202 {job_id, photo_key}；讀完寫進 visit.signbook
 * POST /api/signbook {visit_id, action:"save", entries:[{text, signed_by, language}]} → 確認後每則寫進 responses（來源 signbook）
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "簽名簿");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(body.visit_id);
  if (!visit) return fail(404, "找不到這次參訪");

  if (body.action === "save") {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    let n = 0;
    for (const e of entries) {
      const text = String(e?.text || "").trim();
      if (!text) continue;
      await store.appendResponse(sanitizeResponse({ visit_id: visit.visit_id, source: "signbook", anonymous: false, name: e.signed_by || "", signbook_text: text }));
      n++;
    }
    visit.signbook = { ...visit.signbook, entries, read_at: visit.signbook?.read_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, saved: n });
  }

  const raw = String(body.image || "");
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
  const mediaType = (m ? m[1] : body.media_type || "image/jpeg").toLowerCase();
  const b64 = (m ? m[2] : raw).replace(/\s/g, "");
  if (!b64) return fail(400, "需要 image");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > 4.5 * 1024 * 1024) return fail(413, "照片超過 4.5 MB，請先縮小（後台會自動縮到長邊 2000px）");
  const ext = mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
  const key = `signbook/${visit.visit_id}/${Date.now()}.${ext}`;
  await store.putMedia(key, new Uint8Array(bytes), mediaType);
  // 照片先掛到這一場：後面讀字失敗也不會弄丟它
  visit.signbook = { ...visit.signbook, photo_key: key };
  visit.updated_at = nowISO();
  await store.putVisit(visit);
  const started = await startBackground("signbook", { visit_id: visit.visit_id, photo_key: key, media_type: mediaType }, req);
  const out = await started.json();
  return json({ ...out, photo_key: key }, { status: started.status });
};
