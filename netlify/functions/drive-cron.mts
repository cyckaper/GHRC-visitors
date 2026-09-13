import type { Config } from "@netlify/functions";
import { requireCron } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { driveConfigured, needsSync, triggerDriveSync } from "../lib/drive.mts";

/**
 * 每晚掃一次（台北時間凌晨兩點），把自上次備份後有變動的參訪送去背景備份。
 * 這是自動備份的保險：即時觸發若因為函式重啟、網路或部署而漏掉，隔天會補上。
 */
export default async (req: Request) => {
  const denied = await requireCron(req);
  if (denied) return denied;
  if (!driveConfigured()) return new Response("Google Drive 尚未設定，略過");
  const store = getStore();
  const visits = await store.listVisits();
  let n = 0;
  for (const v of visits.slice(0, 200)) {
    const responses = await store.listResponses(v.visit_id);
    if (!needsSync(v, responses)) continue;
    await triggerDriveSync(v.visit_id);
    n++;
  }
  return new Response(`已送出 ${n} 場備份`);
};

export const config: Config = { schedule: "0 18 * * *" };
