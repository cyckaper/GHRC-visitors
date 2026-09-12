import { fail, readJSON, requireAdmin } from "../lib/http.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import type { Visit } from "../lib/types.mts";

/**
 * 排行程與選頁。提示詞帶整份頁次索引與母簡報文字，Claude 常常跑不只 10 秒
 * （一般函式的上限，超過畫面就回 504 Inactivity Timeout），所以真正的工作在 plan-background。
 *
 * POST /api/plan {visit}    → 202 {job_id}
 * GET  /api/plan?job=<id>   → {status, result?: {plan, visit, estimated_briefing_minutes, warnings}}
 *
 * 結果一樣只回傳給人確認，不落庫。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "排程");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ visit?: Partial<Visit> }>(req);
  if (!body?.visit) return fail(400, "需要 visit");
  return startBackground("plan", { visit: body.visit }, req);
};
