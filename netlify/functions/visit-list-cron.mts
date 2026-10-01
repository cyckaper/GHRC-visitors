import type { Config } from "@netlify/functions";
import { requireCron } from "../lib/http.mts";
import { startBackground } from "../lib/jobs.mts";
import { sheetInfo, sheetsReady } from "../lib/drive.mts";
import { listDue, loadList, touchList } from "../lib/visitlist.mts";

/**
 * 每十五分鐘看一次參訪名單（Google 試算表）有沒有人改過（明確指示：「每一次有增加再自動加入」）。
 * 只問 Drive 一次修改時間；改過了才開背景工作去讀（真正的事情不在排程裡等）。規則在 `lib/visitlist.mts`。
 */
export default async (req: Request) => {
  const denied = await requireCron(req);
  if (denied) return denied;
  if (!(await sheetsReady())) return new Response("Google Drive 尚未設定，略過");
  const s = await loadList();
  if (!s) return new Response("還沒有連到名單");
  const info = await sheetInfo(s.file_id).catch(() => null);
  if (!info) return new Response("找不到名單");
  if (!listDue(s, info)) {
    await touchList(s);
    return new Response("名單沒有改過");
  }
  await startBackground("visit-list", {}, req); // 回的 202 這裡用不到，工作已經開出去了
  return new Response("名單改過了，開始讀新加的列");
};

export const config: Config = { schedule: "*/15 * * * *" };
