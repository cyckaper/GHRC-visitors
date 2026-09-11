import { fail, json, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { loadMasterText, loadPublicData } from "../lib/data.mts";
import { planVisit } from "../lib/ai.mts";
import type { Visit } from "../lib/types.mts";
import { normalizeVisit } from "./visits.mts";
import { briefingBlockMinutes, ensureBriefingFirst } from "../../lib/visit.mjs";

/** POST /api/plan {visit} → {plan, visit}（排行程、選頁；結果回傳給人確認） */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ visit?: Partial<Visit> }>(req);
  if (!body?.visit) return fail(400, "需要 visit");
  const visit = normalizeVisit(body.visit, siteUrl(req));
  const [slidesIndex, labs, masterText] = await Promise.all([loadPublicData("slides"), loadPublicData("labs"), loadMasterText()]);
  try {
    const plan = await planVisit(visit, slidesIndex, labs, masterText);
    // 後端再驗一次：頁次必須存在、always 頁一定在、順序依母簡報頁序
    const known = new Map<number, any>((slidesIndex.slides as any[]).map((s) => [s.n, s]));
    const chosen = new Set<number>(plan.slides.filter((n) => known.has(n)));
    for (const s of slidesIndex.slides as any[]) if (s.always) chosen.add(s.n);
    const slides = [...chosen].sort((a, b) => a - b);
    const merged: Visit = {
      ...visit,
      programme: plan.programme,
      // 動線第一步固定是總體介紹；AI 沒排就依 briefing 區塊長度補上
      itinerary: ensureBriefingFirst(plan.itinerary.map((s) => ({ room: s.room, minutes: s.minutes, focus: s.focus })), briefingBlockMinutes(plan.programme) || 20),
      slides,
      text_edits: plan.text_edits,
      cover_text: plan.cover_text,
      plan_rationale: plan.rationale,
    };
    const minutes = slides.reduce((sum, n) => sum + (known.get(n)?.minutes || 1), 0);
    return json({ ok: true, plan: { ...plan, slides }, visit: merged, estimated_briefing_minutes: Math.round(minutes), master_text_available: !!masterText });
  } catch (e: any) {
    return fail(502, `排程失敗：${e?.message || e}`);
  }
};
