import { briefingMoveTargets, BRIEFING, DEFAULT_BRIEFING_LOCATION, OLD_BRIEFING_LOCATION } from "../../lib/visit.mjs";
import { nowISO } from "./http.mts";
import type { Store } from "./store.mts";

/**
 * 只做一次的資料更正。後台一打開就會叫的 `GET /api/visits`（清單）先跑這裡，做過就在媒體庫留一個記號
 * （`migrations/<名字>.json`，記著什麼時候做的、改了哪幾場），之後每一次只多讀一個小檔。
 * 只改資料、不寄信、不動別的欄位；兩個分頁同時打開、同時跑也沒關係（`updateVisit` 每一次都重新看一眼要不要改）。
 * **出錯不能擋住後台**：哪一場沒改成就不留記號，下一次打開再試，清單照樣回。
 */

const BRIEFING_301 = "migrations/briefing-301.json";

/**
 * 2026-11-13：總體介紹從 302 改到 301（明確指示：「在整個訪客的流程開始簡報改在301，簡報完之後直接接著301的介紹，
 * 302交給林寶秀老師介紹他們的研究」）。還沒開始、總體介紹還寫著舊預設 302 的那幾場換成 301（`briefingMoveTargets`）；
 * 已經過去的不動。寄出確認信、印了流程的海報之後才換的，畫面上照舊會說「行程已改」「需重印」——對方手上寫的就是 302。
 * @returns 這一次改了哪幾場（已經做過就是空的）
 */
export async function moveBriefingTo301(store: Store): Promise<string[]> {
  if (await store.getMedia(BRIEFING_301)) return [];
  const all = await store.listVisits();
  const changed: string[] = [];
  let failed = false;
  for (const id of briefingMoveTargets(all) as string[]) {
    let moved = false;
    try {
      await store.updateVisit(id, (v) => {
        moved = false; // 可能被叫好幾次：最後那一次說了算
        const brief = (v.itinerary || []).find((s) => String(s.room) === BRIEFING);
        if (!brief || String(brief.location || "").trim() !== OLD_BRIEFING_LOCATION) return false; // 這中間有人改過了：照他的
        brief.location = DEFAULT_BRIEFING_LOCATION;
        const at = nowISO();
        v.updated_at = at; // Drive 備份與一頁摘要照「改過了」看
        // 還開著舊畫面的分頁（手上那一份比這個時間早）存檔時送回來的 302 不算（visits.mts 照這個擋）
        (v as any).briefing_moved_at = at;
        moved = true;
      });
    } catch {
      failed = true;
      continue;
    }
    if (moved) changed.push(id);
  }
  if (!failed) {
    const mark = { at: nowISO(), from: OLD_BRIEFING_LOCATION, to: DEFAULT_BRIEFING_LOCATION, changed };
    await store.putMedia(BRIEFING_301, new TextEncoder().encode(JSON.stringify(mark)), "application/json");
  }
  return changed;
}

/** 清單打開前先做的那幾件（目前只有一件）。出錯就當沒做，後台照樣打得開。 */
export async function runMigrations(store: Store): Promise<void> {
  try {
    await moveBriefingTo301(store);
  } catch {
    /* 下一次打開再試 */
  }
}
