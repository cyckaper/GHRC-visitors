import { fail } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { publicVisitsHeaders } from "../lib/cdn.mts";
import { institutionKeys, needsGeo, visitEndAt } from "../../lib/visit.mjs";

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
 * 同一個單位來過好幾次合成一筆（`institutionKeys`：中文名稱一樣、或英文名稱去掉空白與標點後一樣）；
 * 國名各種寫法的歸併與落點由頁面用 world.json 算，跟後台同一套。
 */
export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const now = Date.now();
  const shown = (await getStore().listVisits()).filter((v) => {
    const end = visitEndAt(v).getTime();
    // 主辦端標了「不公開」的那一場，地圖上也不畫
    return String(v.org?.name || "").trim() && Number.isFinite(end) && end <= now && !(v as any).public?.hidden;
  });
  // 同一個單位：中文名稱一樣、或英文名稱去掉空白與標點後一樣（拼法不同的同一家公司不要變成兩個點）。
  // 只拿要畫的那幾場來算：還沒來的那一場不能從這裡透出來
  const inst = institutionKeys(shown);
  const by = new Map<string, { name: string; local: string; country: string; geo: { lat: number | null } | null; visits: number; latest: string }>();
  for (const v of shown) {
    const name = String(v.org?.name || "").trim();
    const country = String(v.org?.country || "").trim();
    const key = inst.get(v.visit_id) || `${name.toLowerCase()}|${country.toLowerCase()}`;
    const g = (v as any).geo;
    const geo = g && !needsGeo(v) ? { lat: g.lat ?? null, lon: g.lon ?? null, place: String(g.place || ""), precision: g.precision || "country" } : null;
    const row = by.get(key) || { name, local: String(v.org?.name_local || "").trim(), country, geo, visits: 0, latest: "" };
    row.visits += 1;
    // 名稱照最近那一場的寫法
    if (String(v.date) > row.latest) Object.assign(row, { name, local: String(v.org?.name_local || "").trim() || row.local, country: country || row.country, latest: String(v.date) });
    // 位置：有座標的優先（另一場只查到國家的不要把它蓋掉）
    if (geo && (!row.geo || (row.geo.lat == null && geo.lat != null))) row.geo = geo;
    by.set(key, row);
  }
  const institutions = [...by.values()].map(({ latest, ...row }) => row).sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
  // 站台的 CDN 幫忙擋：首頁誰都打得開，不必每看一次就把所有參訪讀一遍。匯入、改說明、改或刪來過的那一場、
  // 查到位置時就清掉（lib/cdn.mts）；剛結束的那一場晚十分鐘出現沒關係
  return new Response(JSON.stringify({ ok: true, institutions }), { headers: publicVisitsHeaders() });
};
