import { fail, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";

/**
 * 一頁摘要與跨場次彙整。兩件事都是「Claude 讀一堆東西再寫一整頁」，一般函式的 10 秒不夠，
 * 所以交給 summary-background。
 *
 * GET  /api/summary?job=<id>       → 進度與結果
 * POST /api/summary {visit_id}     → 202 {job_id}；一頁摘要（存在 visit.summary），並寫 slide_performance
 * POST /api/summary {digest: true} → 202 {job_id}；跨場次彙整開放建議
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "摘要");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (body?.digest) return startBackground("summary", { digest: true }, req);
  if (!body?.visit_id) return fail(400, "需要 visit_id 或 digest");
  const visit = await getStore().getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");
  return startBackground("summary", { visit_id: visit.visit_id }, req);
};
