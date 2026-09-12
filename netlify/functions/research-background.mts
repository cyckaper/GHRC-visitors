import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { researchVisitor } from "../lib/ai.mts";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 訪前功課（背景函式，15 分鐘上限）：查網路要一兩分鐘，一般函式 10 秒撐不住。
 * 由 /api/research 觸發，結果寫回 visit.background；前端輪詢 GET /api/research?id= 看進度。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ visit_id?: string }>(req);
  const id = String(body?.visit_id || "");
  if (!id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(id);
  if (!visit) return fail(404, "找不到這次參訪");

  const save = async (background: any) => {
    const fresh = (await store.getVisit(id)) || visit;
    (fresh as any).background = background;
    fresh.updated_at = nowISO();
    await store.putVisit(fresh);
  };

  try {
    const background = await researchVisitor(visit);
    await save({ ...background, status: "done", researched_at: nowISO() });
    await triggerDriveSync(id);
    return json({ ok: true });
  } catch (e: any) {
    await save({ ...((visit as any).background || {}), status: "error", error: String(e?.message || e).slice(0, 300), researched_at: nowISO() });
    return fail(502, `查不到背景：${e?.message || e}`);
  }
};
