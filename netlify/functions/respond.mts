import { fail, json, readJSON } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { guestEmailFor, isValidVisitId, sanitizeResponse } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * POST /api/respond  來賓端回覆（訪後信三個項目、現場留信箱）。公開端點。
 *
 * 真匿名：anonymous=true 時，姓名與 email 在 sanitizeResponse 就被清空，
 * 後端不記錄 IP、不記錄 user agent、時間只留日期，也不得從別的欄位補回身分。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (!body) return fail(400, "需要 JSON body");
  const visitId = String(body.visit_id || "");
  if (!isValidVisitId(visitId)) return fail(400, "visit_id 格式不對");
  const store = getStore();
  const visit = await store.getVisit(visitId);
  if (!visit) return fail(404, "找不到這次參訪");
  const row = sanitizeResponse({ ...body, visit_id: visitId, source: body.source === "onsite" ? "onsite" : "letter" });
  const hasContent = row.email || row.suggestion || row.cooperate_rooms.length || row.next_actions.length || row.next_other || row.note;
  if (!hasContent) return fail(400, "沒有內容");
  if (!row.anonymous && row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return fail(400, "email 格式不對");
  // 具名、沒寫 email：名單上已經有他的 email 就直接填入（明確指示：「都已經有email 了不要再問，直接填入」——
  // 名單上每一位都有 email 的那幾場，來賓專頁本來就不問）。**不具名的不補**：真匿名，後端不得補回身分
  if (!row.anonymous && row.name && !row.email) row.email = guestEmailFor(visit, row.name);
  await store.appendResponse(row);
  // 來賓的回覆也自動備份（不具名的內容在 sanitizeResponse 就已經沒有身分）
  await triggerDriveSync(visitId);
  return json({ ok: true, anonymous: row.anonymous });
};
