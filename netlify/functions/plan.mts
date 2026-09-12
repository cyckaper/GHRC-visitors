import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getJob, publicJob, startJob, triggerBackground } from "../lib/jobs.mts";
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
  if (req.method === "GET") {
    const job = await getJob(new URL(req.url).searchParams.get("job") || "");
    if (!job) return fail(404, "找不到這個排程工作（可能已經過期，請再排一次）");
    return json({ ok: true, ...publicJob(job) });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ visit?: Partial<Visit> }>(req);
  if (!body?.visit) return fail(400, "需要 visit");
  const job = await startJob("plan", { visit: body.visit });
  await triggerBackground("plan-background", { job_id: job.id }, req);
  return json({ ok: true, job_id: job.id, status: job.status }, { status: 202 });
};
