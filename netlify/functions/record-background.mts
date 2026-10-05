import { nowISO } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { writeRecord, type RecordProse } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { triggerDriveSync } from "../lib/drive.mts";
import { visitRecord } from "../../lib/visit.mjs";

/**
 * 完整的參訪紀錄（背景函式，15 分鐘上限）：主持人一項一項打的重點 → AI 寫成完整的句子 →
 * 跟日期、地點、人員、流程（照參訪資料排）一起組成一份紀錄，存在 visit.dictation.record。
 *
 * AI 沒寫成（沒接好、逾時）**不算整件失敗**：照主持人原本的重點排成紀錄，結果裡附一句 warning——
 * 事實那幾段本來就不靠 AI，紀錄照樣用得上。
 */
export default backgroundHandler<{ visit_id: string }>("完整紀錄", async (input) => {
  const store = getStore();
  const visit = await store.getVisit(String(input.visit_id || ""));
  if (!visit) throw new Error("找不到這次參訪");
  const labs = await loadPublicData("labs");
  let prose: RecordProse | null = null;
  let warning = "";
  try {
    prose = await writeRecord(visit, labs);
  } catch (e: any) {
    warning = `AI 沒有寫成（${e?.message || e}），先照你打的重點排成紀錄`;
  }
  const record = { text: visitRecord(visit, labs, prose), at: nowISO(), edited: false };
  // 寫回去的時候只動完整紀錄這一格，而且寫進最新的那一份（AI 寫的這一兩分鐘裡，別的東西可能也改了）
  await store.updateVisit(visit.visit_id, (v) => {
    v.dictation = { ...(v.dictation || {}), record };
    v.updated_at = record.at;
  });
  await triggerDriveSync(visit.visit_id);
  return { record, warning };
});
