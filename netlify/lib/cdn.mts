import { env } from "./http.mts";

/**
 * 公開的兩支——中心首頁的地圖（`/api/visitor-map`）與來訪紀錄（`/api/visit-log`）——讓站台的 CDN 擋：
 * 誰都打得開，不必每看一次就把所有參訪讀一遍。但**資料一改就清掉**（`purgePublicVisits()`）：
 * 匯入以前的名單、改公開頁上的說明、改或刪一場已經來過的、查到位置之後，重新整理就要看得到——
 * 匯入完馬上去看，頁面上不能還是原本那兩三個單位（以前要等十分鐘，瀏覽器自己又多留五分鐘）。
 * 瀏覽器那一層因此不留（max-age=0）：CDN 那一份清掉了，瀏覽器手上的舊的也不能再用。
 * 剛結束的那一場沒有人改資料，照舊等 CDN 那一份過期（十分鐘）才出現。
 */
export const PUBLIC_VISITS_TAG = "public-visits";

export function publicVisitsHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate",
    "netlify-cdn-cache-control": "public, durable, s-maxage=600, stale-while-revalidate=86400",
    "netlify-cache-tag": PUBLIC_VISITS_TAG,
  };
}

/**
 * 清掉 CDN 上那兩支的快取（Netlify 的 purge API；token 與站台代碼是 Netlify 在函式執行環境裡給的）。
 * 本機與測試沒有 CDN，什麼都不做；清不掉也不擋存檔——頂多等十分鐘自己過期。回傳有沒有清到。
 */
export async function purgePublicVisits(): Promise<boolean> {
  const token = env("NETLIFY_PURGE_API_TOKEN");
  const site = env("SITE_ID");
  if (!token || !site) return false;
  try {
    const r = await fetch("https://api.netlify.com/api/v1/purge", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({ site_id: site, cache_tags: [PUBLIC_VISITS_TAG] }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) console.warn(`清公開頁的快取失敗：${r.status}`);
    return r.ok;
  } catch (e) {
    console.warn(`清公開頁的快取失敗：${(e as Error).message}`);
    return false;
  }
}
