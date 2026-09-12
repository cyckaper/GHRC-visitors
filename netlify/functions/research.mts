import { env, fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";

/**
 * 訪前功課的**觸發與查詢**。真正的工作在 research-background.mts。
 *
 * POST /api/research {visit_id}  → 202，背景開始查（查網路要一兩分鐘，一般函式只有 10 秒，撐不住）
 * GET  /api/research?id=<visit_id> → { background }（前端每幾秒問一次，查完就會有 researched_at）
 *
 * 結果寫進 visit.background：狀態 running／done／error 都在裡面，重新整理也看得到進度。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const store = getStore();

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const visit = await store.getVisit(id);
    if (!visit) return fail(404, "找不到這次參訪");
    return json({ ok: true, background: (visit as any).background || null });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ visit_id?: string }>(req);
  const id = String(body?.visit_id || "");
  if (!id) return fail(400, "需要 visit_id（先把這一場存檔，背景查完會寫回這一場）");
  const visit = await store.getVisit(id);
  if (!visit) return fail(404, "找不到這次參訪");
  if (!visit.org?.name && !(visit.guests || []).length) return fail(400, "至少要有單位名稱或一個名單上的人，才查得到東西");

  const prev = (visit as any).background || null;
  if (prev?.status === "running" && Date.now() - (Date.parse(prev.started_at || "") || 0) < 5 * 60000) {
    return json({ ok: true, running: true, background: prev }, { status: 202 });
  }
  (visit as any).background = { ...(prev || {}), status: "running", started_at: nowISO() };
  await store.putVisit(visit);

  const admin = env("ADMIN_TOKEN");
  try {
    await fetch(`${siteUrl(req)}/.netlify/functions/research-background`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ visit_id: id }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* 背景函式回 202 就走，這裡不等它；真的沒被叫到的話前端輪詢會停在 running，使用者可以再按一次 */
  }
  return json({ ok: true, running: true, background: (visit as any).background }, { status: 202 });
};
