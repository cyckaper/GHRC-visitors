import { nowISO } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { researchVisitor } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { triggerDriveSync } from "../lib/drive.mts";
import type { Visit } from "../lib/types.mts";

/**
 * 訪前功課（背景函式，15 分鐘上限）：查網路要一到三分鐘，一般函式的 10 秒撐不住。
 * 還沒存檔的那一筆跟著工作走；存過檔的另外把結果寫回 visit.background，
 * 這樣重新整理或換台機器也接得回進度（`GET /api/research?id=`）。
 */
export default backgroundHandler<{ visit_id?: string; visit?: Partial<Visit> }>("背景研判", async (input) => {
  const store = getStore();
  const id = String(input.visit_id || "");
  const saved = id ? await store.getVisit(id) : null;
  // 要查的內容以工作帶進來的那一份為準（後台送的是畫面上現在的名單），存檔的那一筆只用來寫回結果
  const visit = (input.visit || saved) as Visit;
  if (!visit) throw new Error("沒有可以查的參訪資料");

  const write = async (background: any) => {
    if (!id) return;
    const fresh = (await store.getVisit(id)) || saved;
    if (!fresh) return;
    (fresh as any).background = background;
    fresh.updated_at = nowISO();
    await store.putVisit(fresh);
  };

  try {
    const background = { ...(await researchVisitor(visit)), status: "done", researched_at: nowISO() };
    await write(background);
    if (id) await triggerDriveSync(id);
    return background;
  } catch (e: any) {
    await write({ ...((visit as any).background || {}), status: "error", error: String(e?.message || e).slice(0, 300), researched_at: nowISO() });
    throw e;
  }
});
