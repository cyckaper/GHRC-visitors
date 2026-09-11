import { fail, json, readJSON, requireAdmin, siteUrl, taipeiToday } from "../lib/http.mts";
import { extractVisit } from "../lib/ai.mts";
import { extractFile, type Extracted } from "../lib/files.mts";
import { normalizeVisit } from "./visits.mts";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/extract {email_text?, files?: [{name, type, data}]} → {extracted, visit, files_read, warnings}
 * files[].data 是 base64（可帶 data: 前綴）。Word／Excel／PowerPoint／CSV／文字在這裡轉純文字，
 * PDF 與照片直接交給 Claude 讀。抽取結果只回傳給人確認，不落庫。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ email_text?: string; files?: { name?: string; type?: string; data?: string }[] }>(req);
  const text = String(body?.email_text || "").trim();
  const files = Array.isArray(body?.files) ? body!.files! : [];
  if (files.length > MAX_FILES) return fail(413, `一次最多 ${MAX_FILES} 個檔案`);
  if (text.length > 200000) return fail(413, "內容太長，請只貼相關的往來");
  const attachments: Extracted[] = [];
  const warnings: string[] = [];
  let total = 0;
  for (const f of files) {
    const name = String(f?.name || "file");
    const b64 = String(f?.data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    if (!b64) continue;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES) return fail(413, `${name} 超過 4.5 MB`);
    if (total > MAX_TOTAL_BYTES) return fail(413, "檔案總量超過 5 MB，請分批或改貼文字");
    const out = await extractFile(name, String(f?.type || ""), bytes);
    if (out.kind === "unsupported") warnings.push(`${name}：${out.reason}`);
    else if (out.kind === "text" && !out.text.trim()) warnings.push(`${name}：檔案裡讀不到文字`);
    else attachments.push(out);
  }
  if (text.length < 20 && !attachments.length) return fail(400, warnings.length ? `沒有可讀的資料。${warnings.join("；")}` : "請貼上 email 內容或上傳名單檔");
  try {
    const extracted = await extractVisit(text, taipeiToday(), attachments);
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
    return json({ ok: true, extracted, visit, files_read, warnings });
  } catch (e: any) {
    return fail(502, `抽取失敗：${e?.message || e}`);
  }
};
