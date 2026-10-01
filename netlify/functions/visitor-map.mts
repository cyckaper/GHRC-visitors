import { fail } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { needsGeo, visitEndAt } from "../../lib/visit.mjs";

/**
 * 中心首頁的世界地圖（**公開**，不必登入）：來訪過的單位在哪裡
 * （明確要求：「GHRC 介紹首頁加入設定中的世界地圖，標出來訪單位」）。畫法跟後台「資料」分頁同一份（public/lib/worldmap.mjs）。
 *
 * GET /api/visitor-map → { ok, institutions: [{ name, local, country, geo, visits }] }
 *
 * 首頁誰都打得開，所以**只給地圖用得到的**：單位名稱、在地名稱、國家、位置（查到的城市與座標）、來過幾次。
 * **不給**日期、人數、名單、email、來訪目的、背景研判——那些是後台的東西。
 * **只列已經來過的**（結束時間已過，`visitEndAt`）：還沒來的不先公告，部長級的行程不該先出現在首頁上。
 * 位置是單位改名之前查的（`needsGeo`）就先不用、退回國家的位置——不要把新的單位畫在舊單位的地方。
 * 同一個單位來過好幾次合成一筆（名稱＋國家相同）；國名各種寫法的歸併與落點由頁面用 world.json 算，跟後台同一套。
 */
export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const now = Date.now();
  const by = new Map<string, { name: string; local: string; country: string; geo: unknown; visits: number }>();
  for (const v of await getStore().listVisits()) {
    const name = String(v.org?.name || "").trim();
    const end = visitEndAt(v).getTime();
    if (!name || !Number.isFinite(end) || end > now) continue;
    const country = String(v.org?.country || "").trim();
    const key = `${name.toLowerCase()}|${country.toLowerCase()}`;
    const g = (v as any).geo;
    const geo = g && !needsGeo(v) ? { lat: g.lat ?? null, lon: g.lon ?? null, place: String(g.place || ""), precision: g.precision || "country" } : null;
    const row = by.get(key) || { name, local: String(v.org?.name_local || "").trim(), country, geo, visits: 0 };
    row.visits += 1;
    if (!row.geo && geo) row.geo = geo;
    by.set(key, row);
  }
  const institutions = [...by.values()].sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
  return new Response(JSON.stringify({ ok: true, institutions }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      // 站台的 CDN 幫忙擋：首頁誰都打得開，不必每看一次就把所有參訪讀一遍；剛結束的那一場晚十分鐘出現沒關係
      "netlify-cdn-cache-control": "public, durable, s-maxage=600, stale-while-revalidate=86400",
    },
  });
};
