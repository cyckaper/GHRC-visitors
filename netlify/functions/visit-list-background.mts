import { siteUrl } from "../lib/http.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { linkList, listSummary, syncList } from "../lib/visitlist.mts";

/**
 * 讀參訪名單（Google 試算表）裡新加的那幾列、寫進參訪紀錄（背景函式，15 分鐘上限；AI 讀幾十列要一兩分鐘）。
 * 由 /api/visit-list 與 visit-list-cron 觸發；也做第一次的「把匯入的那一份存成 Google 試算表」。規則在 `lib/visitlist.mts`。
 */
export default backgroundHandler<{ link?: { name: string; mime: string; data: string }; force?: boolean }>("看名單", async (input, req) => {
  if (input.link) {
    const s = await linkList({ name: input.link.name, mime: input.link.mime, bytes: new Uint8Array(Buffer.from(input.link.data, "base64")) });
    return { linked: listSummary(s) };
  }
  return syncList({ force: !!input.force, site: siteUrl(req) });
});
