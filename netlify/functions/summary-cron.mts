import type { Config } from "@netlify/functions";
import { requireCron } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { startBackground } from "../lib/jobs.mts";
import { aiConfigured } from "../lib/ai.mts";
import { needsSummary } from "../../lib/visit.mjs";

/**
 * 一頁摘要自己產（每晚台北時間凌晨一點掃一次）。
 *
 * 摘要是 Drive 備份、跨場次彙整與 slide_performance 的來源，但它在「資料」分頁裡面，
 * 而且沒有任何提示——**沒有人會記得回來按**。所以不靠人按：參訪過完、有回饋可寫，
 * 系統自己產一份；來賓的回覆是好幾天之內陸續進來的，所以比最新那筆回覆舊就重寫一次
 * （判斷在 `lib/visit.mjs needsSummary`）。後台那顆「AI 產一頁摘要」留著給「現在就要」用。
 *
 * 排在 drive-cron（兩點）之前，當晚的備份就會帶到新的摘要。
 */
const MAX_PER_NIGHT = 20; // 一場一次 Claude 呼叫；真的積了很多場就分幾晚補，不要一次打爆

export default async (req: Request) => {
  const denied = await requireCron(req);
  if (denied) return denied;
  if (!aiConfigured()) return new Response("Claude 尚未設定，略過");
  const store = getStore();
  const [visits, responses] = await Promise.all([store.listVisits(), store.listResponses()]);
  const now = new Date();
  const sent: string[] = [];
  for (const v of visits) {
    if (sent.length >= MAX_PER_NIGHT) break;
    if (!needsSummary(v, responses, now)) continue;
    await startBackground("summary", { visit_id: v.visit_id }, req); // 回的 202 這裡用不到，工作已經開出去了
    sent.push(v.visit_id);
  }
  return new Response(sent.length ? `已送出 ${sent.length} 份摘要：${sent.join("、")}` : "沒有需要產摘要的場次");
};

export const config: Config = { schedule: "0 17 * * *" };
