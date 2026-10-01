import { nowISO } from "../lib/http.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { getStore } from "../lib/store.mts";
import { locateOrgs } from "../lib/ai.mts";
import type { Visit } from "../lib/types.mts";
import { geoKey, needsGeo, sanitizeGeo } from "../../lib/visit.mjs";

/** 一次最多查幾個單位：問太多 AI 回得慢，剩下的前端會再叫一次。 */
const BATCH = 30;

/**
 * 查各單位在哪裡（背景函式，15 分鐘上限）。由 /api/geo 觸發。
 * 同一個單位來過好幾次只查一次；查的時候有人改過那一場就重讀、只寫 `geo`，
 * 而且單位還是同一個才寫（改了名字的，下一輪照新名字查）。
 * AI 沒回到的也記成「只知道國家」，不然每打開一次資料分頁就再問一次同一個查不到的單位。
 */
export default backgroundHandler("查位置", async () => {
  const store = getStore();
  const byKey = new Map<string, Visit[]>();
  for (const v of await store.listVisits()) {
    if (!needsGeo(v)) continue;
    const key = geoKey(v);
    byKey.set(key, [...(byKey.get(key) || []), v]);
  }
  const keys = [...byKey.keys()].slice(0, BATCH);
  const items = keys.map((key, i) => {
    const v = byKey.get(key)![0];
    return { id: String(i), name: v.org.name, name_local: v.org.name_local || "", country: v.org.country || "", profile: String(v.background?.org_profile || "").slice(0, 600) };
  });
  const places = await locateOrgs(items);
  const found = new Map(places.map((p) => [p.id, p]));
  const at = nowISO();
  let updated = 0;
  for (const [i, key] of keys.entries()) {
    const geo = sanitizeGeo({ ...(found.get(String(i)) || { lat: null, lon: null, place: "", precision: "country" }), key, at });
    for (const v of byKey.get(key)!) {
      // 只寫 geo，而且寫進最新的那一份；查的時候單位改了名字就不寫（下一輪照新名字查）
      const saved = await store.updateVisit(v.visit_id, (fresh) => {
        if (geoKey(fresh) !== key) return false;
        (fresh as any).geo = geo;
      });
      if (saved && (saved as any).geo === geo) updated++;
    }
  }
  return { updated, remaining: Math.max(0, byKey.size - keys.length) };
});
