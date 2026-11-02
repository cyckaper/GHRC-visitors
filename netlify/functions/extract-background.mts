import { siteUrl, taipeiToday } from "../lib/http.mts";
import { extractedDate, guestTalkPlan } from "../../lib/visit.mjs";
import { extractVisit } from "../lib/ai.mts";
import type { Extracted } from "../lib/files.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { dropStaged, loadStaged, MAX_REQUEST_BASE64 } from "../lib/staged.mts";
import { normalizeVisit } from "./visits.mts";

/**
 * 讀信抽取（背景函式，15 分鐘上限）：長信＋附件（好幾張手機截圖）交給 Claude 常常超過一般函式的 10 秒。
 * 由 /api/extract 觸發，只帶 job_id；信件內容從 job 自己讀，附件照 key 的順序從媒體庫讀回來（`staged.mts`），
 * **讀完不管成功失敗都刪掉**——截圖裡有對方的電話與整段對話，抽完就不留。
 * 做完寫回 job，前端輪詢 GET /api/extract?job=<id> 拿結果。
 */
export default backgroundHandler<{ text?: string; attachments?: Extracted[]; keys?: string[]; warnings?: string[] }>("抽取", async (input, req) => {
  const keys = Array.isArray(input.keys) ? input.keys.map(String) : [];
  try {
    const staged = await loadStaged(keys);
    const attachments = [...(Array.isArray(input.attachments) ? input.attachments : []), ...staged.attachments];
    const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
    if (staged.missing) warnings.push(`有 ${staged.missing} 個附件找不到了（可能已經讀過一次）：請重新選一次再按「AI 抽取」`);
    const base64 = attachments.reduce((n, a) => n + (a.kind === "image" || a.kind === "document" ? a.data.length : 0), 0);
    if (base64 > MAX_REQUEST_BASE64) throw new Error(`附件太大（共約 ${Math.round((base64 * 3) / 4 / 1024 / 1024)} MB）：請少放幾張截圖，或把 PDF 拆開分兩次讀`);
    if (!attachments.length && String(input.text || "").trim().length < 20) throw new Error(warnings.length ? `沒有可讀的資料。${warnings.join("；")}` : "沒有可讀的資料");
    const extracted = await extractVisit(String(input.text || ""), taipeiToday(), attachments);
    // 日期：AI 給的，沒有就用候選的，再沒有就留空（後台說「填上日期才會存」）——**不補今天**
    const when = extractedDate(extracted.date, extracted.candidate_dates);
    // 對方也要報告：今日流程多一段來賓報告（後台接在總體介紹後面，pollExtract 排），特殊狀況寫一行，沒說多久就列進要確認的事
    const talk = guestTalkPlan(extracted.guest_talk);
    // 特殊狀況：信裡提到要注意的事先填進去，主辦端再增刪；後面每一則 AI 寫的東西都照這一格
    const notes = [...(talk ? [talk.note] : []), ...(extracted.special_notes || []).map((s) => String(s || "").trim()).filter(Boolean)];
    const visit = normalizeVisit(
      {
        org: extracted.org,
        guests: extracted.guests,
        headcount: extracted.headcount,
        date: when.date,
        start_time: extracted.start_time || "10:00",
        // 信裡寫「10:00-12:30」就照著填；只寫分鐘數的用分鐘數；都沒有就預設一場的長度
        end_time: extracted.end_time || "",
        duration_minutes: extracted.duration_minutes || 0,
        contact_teacher: extracted.contact_teacher || "張俊彥",
        purpose: extracted.purpose,
        interests: extracted.interests,
        language: extracted.language,
        special_notes: notes.join("\n"),
        uncertainties: [...extracted.uncertainties, ...when.notes, ...(talk?.uncertainty ? [talk.uncertainty] : [])],
      } as any,
      siteUrl(req),
    );
    const files_read = attachments.map((a) => ({ name: a.name, kind: a.kind, chars: a.kind === "text" ? a.text.length : undefined }));
    return { extracted, visit, files_read, warnings, guest_talk: talk ? talk.block : null };
  } finally {
    await dropStaged(keys);
  }
});
