import type { ResponseRow, SlidePerf, Visit } from "./types.mts";
import type { Store } from "./store.mts";

/**
 * 歷次參訪的實際表現——功能 4 回饋功能 2 的那條線。
 *
 * 資料有兩種來源，都用：
 * - **選過哪幾頁**：直接看每一場存的 `visit.slides`，所以不必等人按「一頁摘要」就有資料。
 * - **哪幾頁被提問／在回饋中被提到**：`slide_performance`（由一頁摘要寫入）。
 *
 * 同類單位（org_type 相同）另外算一份：政府單位與學生團想看的東西本來就不一樣，
 * 全部混在一起平均就什麼也看不出來。
 */
export interface SlideHistory {
  visits: number;
  same_type: { org_type: string; visits: number };
  /** 只列有數字的頁：used＝過去選過幾次，asked／mentioned＝那一間被提問／被提到幾次 */
  slides: { n: number; used: number; used_same_type: number; asked: number; mentioned: number }[];
  /**
   * 每一間被點名的次數，**來源分開算**（明確要求）：
   * - `wanted`／`cooperate`：**來賓自己回的**（訪後信的三個回應項目、現場自填）。
   * - `host_noted`：**主持人口述**裡聽到的「他們最想看那一間」。
   *
   * 「主持人覺得對方有興趣」不等於「對方說他有興趣」，合併成一個數字就再也分不出來了。
   * 兩個都給提示詞，但要說清楚哪一個是誰說的。
   */
  rooms: { room: string; wanted: number; cooperate: number; host_noted: number }[];
}

export async function slideHistory(store: Store, orgType: string, excludeVisitId = ""): Promise<SlideHistory | null> {
  const [visits, perf, responses] = await Promise.all([store.listVisits(), store.listSlidePerformance(), store.listResponses()]);
  const past = visits.filter((v) => v.visit_id !== excludeVisitId && (v.slides || []).length);
  if (!past.length) return null;

  const slides = new Map<number, { n: number; used: number; used_same_type: number; asked: number; mentioned: number }>();
  const row = (n: number) => {
    if (!slides.has(n)) slides.set(n, { n, used: 0, used_same_type: 0, asked: 0, mentioned: 0 });
    return slides.get(n)!;
  };
  const typeOf = new Map(visits.map((v: Visit) => [v.visit_id, v.org?.type || "other"]));
  for (const v of past) for (const n of v.slides || []) {
    const r = row(n);
    r.used++;
    if ((v.org?.type || "other") === orgType) r.used_same_type++;
  }
  for (const p of perf as SlidePerf[]) {
    if (p.visit_id === excludeVisitId) continue;
    const r = row(p.slide);
    if (p.asked) r.asked++;
    if (p.mentioned) r.mentioned++;
  }

  const rooms = new Map<string, { room: string; wanted: number; cooperate: number; host_noted: number }>();
  const bump = (room: string, key: "wanted" | "cooperate" | "host_noted") => {
    if (!/^30[1-5]$/.test(room)) return;
    if (!rooms.has(room)) rooms.set(room, { room, wanted: 0, cooperate: 0, host_noted: 0 });
    rooms.get(room)![key]++;
  };
  for (const r of responses as ResponseRow[]) {
    if (r.visit_id === excludeVisitId) continue;
    for (const room of r.most_wanted_rooms || []) bump(room, "wanted");
    for (const room of r.cooperate_rooms || []) bump(room, "cooperate");
  }
  // 主持人口述裡的「最想看哪一間」記在自己的欄位（有些場次只有口述、沒有來賓回覆），**不併進來賓的數字**
  for (const v of visits) {
    if (v.visit_id === excludeVisitId) continue;
    for (const room of v.dictation?.extracted?.most_wanted_rooms || []) bump(room, "host_noted");
  }

  return {
    visits: past.length,
    same_type: { org_type: orgType, visits: past.filter((v) => (typeOf.get(v.visit_id) || "other") === orgType).length },
    slides: [...slides.values()].filter((s) => s.used || s.asked || s.mentioned).sort((a, b) => a.n - b.n),
    rooms: [...rooms.values()].sort((a, b) => b.wanted + b.host_noted - (a.wanted + a.host_noted)),
  };
}
