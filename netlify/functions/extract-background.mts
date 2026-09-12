import { fail, json, readJSON, requireAdmin, siteUrl, taipeiToday } from "../lib/http.mts";
import { extractVisit } from "../lib/ai.mts";
import type { Extracted } from "../lib/files.mts";
import { failJob, finishJob, getJob } from "../lib/jobs.mts";
import { normalizeVisit } from "./visits.mts";

/**
 * 讀信抽取（背景函式，15 分鐘上限）：長信＋附件交給 Claude 常常超過一般函式的 10 秒。
 * 由 /api/extract 觸發，只帶 job_id；信件內容與附件（已在那裡轉成純文字或 document／image block）
 * 從 job 自己讀。做完寫回 job，前端輪詢 GET /api/extract?job=<id> 拿結果。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ job_id?: string }>(req);
  const jobId = String(body?.job_id || "");
  if (!jobId) return fail(400, "需要 job_id");
  const job = await getJob(jobId);
  if (!job) return fail(404, "找不到這個抽取工作");
  const input = (job.input || {}) as { text?: string; attachments?: Extracted[]; warnings?: string[] };
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  try {
    const extracted = await extractVisit(String(input.text || ""), taipeiToday(), attachments);
    const visit = normalizeVisit(
      {
        org: extracted.org,
        guests: extracted.guests,
        headcount: extracted.headcount,
        date: extracted.date || taipeiToday(),
        start_time: extracted.start_time || "10:00",
        duration_minutes: extracted.duration_minutes || 90,
        contact_teacher: extracted.contact_teacher || "張俊彥",
        purpose: extracted.purpose,
        interests: extracted.interests,
        language: extracted.language,
        uncertainties: [...extracted.uncertainties, ...(extracted.date ? [] : ["參訪日期未定"]), ...extracted.candidate_dates.map((d) => `候選日期：${d}`)],
      } as any,
      siteUrl(req),
    );
    const files_read = attachments.map((a) => ({ name: a.name, kind: a.kind, chars: a.kind === "text" ? a.text.length : undefined }));
    await finishJob(jobId, { extracted, visit, files_read, warnings });
    return json({ ok: true });
  } catch (e: any) {
    await failJob(jobId, `抽取失敗：${e?.message || e}`);
    return fail(502, `抽取失敗：${e?.message || e}`);
  }
};
