import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { publicVisitsHeaders, purgePublicVisits } from "../lib/cdn.mts";
import { sanitizePublic, visitLogEntries } from "../../lib/visit.mjs";

/**
 * 來訪紀錄（明確要求：「參訪者多，把這些參訪另外作一頁連過去詳細說明」）。
 *
 * GET  /api/visit-log                          **公開**：已經來過的每一場（`/visits` 頁用；規則在 `lib/visit.mjs visitLogEntries`）
 * POST /api/visit-log {visit_id, public}       admin：改這一場公開頁上的說明、或整場不公開（後台「資料」分頁）
 *
 * 公開的只有日期、單位、國家、查到的位置、去了哪幾間，以及**主辦端願意公開的說明**（`visit.public`）。
 * 名單、email、來訪目的、背景研判、摘要、回覆一律不給；還沒來的不先公告（跟首頁的地圖同一條規矩）。
 * 匯入的舊紀錄裡原表同一列拆成好幾個單位的算同一場：交流重點與「不公開」是那一場的事，一起改；來訪人員各筆各自的。
 */
export default async (req: Request) => {
  const store = getStore();
  if (req.method === "GET") {
    const visits = visitLogEntries(await store.listVisits());
    // 跟首頁的地圖一樣讓站台的 CDN 擋；資料一改就清掉（見 lib/cdn.mts）
    return new Response(JSON.stringify({ ok: true, visits }), { headers: publicVisitsHeaders() });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ visit_id?: string; public?: Record<string, unknown> }>(req);
  const id = String(body?.visit_id || "");
  const target = id ? await store.getVisit(id) : null;
  if (!target) return fail(404, "找不到這次參訪");
  const next: { note_zh?: string; note_en?: string; hidden?: boolean } = sanitizePublic(body?.public) || {};
  const group = (target as any).imported?.group || "";
  const others = group ? (await store.listVisits()).filter((v) => v.visit_id !== id && (v as any).imported?.group === group).map((v) => v.visit_id) : [];
  const saved = await store.updateVisit(id, (v) => {
    (v as any).public = sanitizePublic(next);
  });
  // 同一場（原表同一列拆出來的）：交流重點與「不公開」一起改，來訪人員留著各自的
  for (const other of others) {
    await store.updateVisit(other, (v) => {
      const cur = (v as any).public || {};
      (v as any).public = sanitizePublic({ ...cur, note_zh: next.note_zh, note_en: next.note_en, hidden: next.hidden === true });
    });
  }
  await purgePublicVisits(); // 改完重新整理就看得到
  return json({ ok: true, public: (saved as any)?.public || null, also: others });
};
