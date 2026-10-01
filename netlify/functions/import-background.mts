import { taipeiToday } from "../lib/http.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { getStore } from "../lib/store.mts";
import { readVisitList } from "../lib/ai.mts";
import { planImport } from "../../lib/import.mjs";

/**
 * 讀以前的參訪名單（背景函式，15 分鐘上限）：二十幾列交給 Claude 整理要一兩分鐘，一般函式的 10 秒不夠。
 * 由 /api/import 觸發，只帶 job_id；檔案轉出來的文字從 job 自己讀。
 * 回傳的是**預覽**（每一列整理好、配好網址、標出系統裡已經有的），不落庫——勾好之後 /api/import 的 commit 才寫。
 */
export default backgroundHandler<{ text?: string; name?: string }>("讀名單", async (input) => {
  const { rows, skipped } = await readVisitList(String(input.text || ""), taipeiToday());
  return { rows: planImport(rows, await getStore().listVisits()), skipped, file: String(input.name || "") };
});
