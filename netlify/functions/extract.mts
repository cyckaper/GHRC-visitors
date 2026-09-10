import { fail, json, readJSON, requireAdmin, siteUrl, taipeiToday } from "../lib/http.mts";
import { extractVisit } from "../lib/ai.mts";
import { normalizeVisit } from "./visits.mts";

/** POST /api/extract {email_text} → {extracted, visit}（抽取結果只回傳給人確認，不落庫） */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ email_text?: string }>(req);
  const text = String(body?.email_text || "").trim();
  if (text.length < 20) return fail(400, "請貼上 email 內容");
  if (text.length > 200000) return fail(413, "內容太長，請只貼相關的往來");
  try {
    const extracted = await extractVisit(text, taipeiToday());
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
    return json({ ok: true, extracted, visit });
  } catch (e: any) {
    return fail(502, `抽取失敗：${e?.message || e}`);
  }
};
