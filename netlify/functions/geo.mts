import { fail, json, requireAdmin } from "../lib/http.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { getStore } from "../lib/store.mts";
import { aiConfigured } from "../lib/ai.mts";
import { needsGeo } from "../../lib/visit.mjs";

/**
 * 訪客地圖：**每一個單位在哪裡**（明確指示：「點要能縮小到學校或公司，不要佔了整個國家」）。
 * AI 一次查好幾個單位就超過一般函式的 10 秒，所以真正的事情在 geo-background。
 *
 * POST /api/geo            → 有還沒查過（或單位改過名字）的就開一個工作，回 202 {job_id}；
 *                            都查過了、或 Claude 還沒接好，當場回 {pending: 0}
 * GET  /api/geo?job=<id>   → {status, result?: {updated, remaining}}
 *
 * 後台「資料」分頁打開時自己叫這一支（不必有人記得按）。查到的寫進 `visit.geo`，不動 updated_at。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "查位置");
  if (req.method !== "POST") return fail(405, "method not allowed");
  if (!aiConfigured()) return json({ ok: true, pending: 0, skipped: "Claude 還沒接好：各單位先放在國家的位置" });
  const pending = (await getStore().listVisits()).filter((v) => needsGeo(v)).length;
  if (!pending) return json({ ok: true, pending: 0 });
  return startBackground("geo", {}, req);
};
