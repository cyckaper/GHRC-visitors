import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { researchVisitor } from "../lib/ai.mts";
import type { Visit } from "../lib/types.mts";
import { normalizeVisit } from "./visits.mts";

/**
 * POST /api/research {visit} → {background}
 *
 * 訪前功課：用網路搜尋查來訪單位與名單上的人的**公開專業資料**，整理出可能的參訪目的、
 * 可能想看的研究室、可以先準備什麼、還查不到什麼，附上讀過的網址。
 * 結果只回傳給主辦端確認（跟抽取一樣不自動落庫），按「儲存」才會寫進 visit.background。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ visit?: Partial<Visit> }>(req);
  if (!body?.visit) return fail(400, "需要 visit");
  const visit = normalizeVisit(body.visit, siteUrl(req));
  if (!visit.org?.name && !(visit.guests || []).length) return fail(400, "至少要有單位名稱或一個名單上的人，才查得到東西");
  try {
    const background = await researchVisitor(visit);
    return json({ ok: true, background: { ...background, researched_at: nowISO() } });
  } catch (e: any) {
    return fail(502, `查不到背景：${e?.message || e}`);
  }
};
