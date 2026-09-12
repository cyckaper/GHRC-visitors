import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import type { Visit } from "../lib/types.mts";

/**
 * 訪前功課（查公開資料，判斷可能的參訪目的）。查網路要一到三分鐘，一般函式只有 10 秒，
 * 所以真正的工作在 research-background。
 *
 * POST /api/research {visit}      → 202 {job_id}；**還沒存檔也查得了**，要查的那一筆跟著工作走
 * POST /api/research {visit_id}   → 202 {job_id}；已經存檔的就順便寫回 visit.background
 * GET  /api/research?job=<id>     → 進度與結果
 * GET  /api/research?id=<visit_id> → { background }（重新整理後接回進度用；只有存過檔的才有）
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const store = getStore();

  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.has("job")) return pollJob(req, "背景研判");
    const visit = await store.getVisit(url.searchParams.get("id") || "");
    if (!visit) return fail(404, "找不到這次參訪");
    return json({ ok: true, background: (visit as any).background || null });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ visit_id?: string; visit?: Partial<Visit> }>(req);
  const id = String(body?.visit_id || "");
  let draft: Partial<Visit> | null = body?.visit || null;

  if (id) {
    const visit = await store.getVisit(id);
    if (!visit) return fail(404, "找不到這次參訪");
    draft = visit;
    // 存過檔的順便把「查資料中」記在那一筆上：重新整理、換台機器都看得到進度
    (visit as any).background = { ...((visit as any).background || {}), status: "running", started_at: nowISO() };
    await store.putVisit(visit);
  }
  if (!draft?.org?.name && !(draft?.guests || []).length) return fail(400, "至少要有單位名稱或一個名單上的人，才查得到東西");
  return startBackground("research", { visit_id: id, visit: id ? null : draft }, req);
};
