import { siteUrl, taipeiToday } from "../lib/http.mts";
import { extractVisit } from "../lib/ai.mts";
import type { Extracted } from "../lib/files.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { normalizeVisit } from "./visits.mts";

/**
 * 讀信抽取（背景函式，15 分鐘上限）：長信＋附件交給 Claude 常常超過一般函式的 10 秒。
 * 由 /api/extract 觸發，只帶 job_id；信件內容與附件（已在那裡轉成純文字或 document／image block）
 * 從 job 自己讀。做完寫回 job，前端輪詢 GET /api/extract?job=<id> 拿結果。
 */
export default backgroundHandler<{ text?: string; attachments?: Extracted[]; warnings?: string[] }>("抽取", async (input, req) => {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  const extracted = await extractVisit(String(input.text || ""), taipeiToday(), attachments);
  const visit = normalizeVisit(
    {
      org: extracted.org,
      guests: extracted.guests,
      headcount: extracted.headcount,
      date: extracted.date || taipeiToday(),
      start_time: extracted.start_time || "10:00",
      // 信裡寫「10:00-12:30」就照著填；只寫分鐘數的用分鐘數；都沒有就預設一場的長度
      end_time: extracted.end_time || "",
      duration_minutes: extracted.duration_minutes || 0,
      contact_teacher: extracted.contact_teacher || "張俊彥",
      purpose: extracted.purpose,
      interests: extracted.interests,
      language: extracted.language,
      uncertainties: [...extracted.uncertainties, ...(extracted.date ? [] : ["參訪日期未定"]), ...extracted.candidate_dates.map((d) => `候選日期：${d}`)],
    } as any,
    siteUrl(req),
  );
  const files_read = attachments.map((a) => ({ name: a.name, kind: a.kind, chars: a.kind === "text" ? a.text.length : undefined }));
  return { extracted, visit, files_read, warnings };
});
