import { fail, json, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { loadMasterText, loadPublicData } from "../lib/data.mts";
import { planVisit } from "../lib/ai.mts";
import type { Visit } from "../lib/types.mts";
import { normalizeVisit } from "./visits.mts";
import { applyProgrammeTimes, briefingBlockMinutes, ensureBriefingFirst } from "../../lib/visit.mjs";

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
    // 今日流程固定要有「綜合討論」：AI 漏掉就在最後補 10 分鐘並提醒主辦端調整
    const warnings: string[] = [];
    let programme = plan.programme;
    if (!programme.some((b) => b.kind === "discussion")) {
      const last = programme[programme.length - 1];
      const start = last?.end || visit.start_time || "10:00";
      const [h, m] = start.split(":").map(Number);
      const endMin = h * 60 + m + 10;
      const end = `${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      const photoIdx = programme.findIndex((b) => b.kind === "photo");
      const block = { start, end, kind: "discussion" as const, title_en: "General discussion", title_2nd: visit.language === "en" ? "" : "綜合討論", rooms: [] as string[], slides_range: "—" };
      programme = photoIdx >= 0 ? [...programme.slice(0, photoIdx), { ...block, start: programme[photoIdx].start, end: programme[photoIdx].start }, ...programme.slice(photoIdx)] : [...programme, block];
      warnings.push("AI 排程漏了「綜合討論」，已補上一個區塊，請調整它與前後區塊的時間。");
    }
    // 總體介紹的地點沿用主辦端填的（預設 302），AI 不決定地點
    const briefingLocation = visit.itinerary.find((s) => s.room === "briefing")?.location || "";
    let merged: Visit = {
      ...visit,
      programme,
      // 動線第一步固定是總體介紹；AI 沒排就依 briefing 區塊長度補上
      itinerary: ensureBriefingFirst(plan.itinerary.map((s) => ({ room: s.room, minutes: s.minutes, focus: s.focus, ...(s.room === "briefing" ? { location: briefingLocation } : {}) })), briefingBlockMinutes(plan.programme) || 20),
      slides,
      text_edits: plan.text_edits,
      cover_text: plan.cover_text,
      plan_rationale: plan.rationale,
    };
    // 分鐘數不歸 AI 決定：一律照「時間分配預設」重算（每間研究室 20 分，時間不夠才依序縮短）
    const timed = applyProgrammeTimes(merged);
    if (timed.changed) warnings.push(`每間研究室一律 ${timed.alloc.perRoom} 分、總體介紹 ${timed.alloc.briefing} 分（AI 排的分鐘數已按預設重算）；要改就直接在下面改。`);
    merged = { ...merged, programme: timed.programme, itinerary: timed.itinerary };
    const minutes = slides.reduce((sum, n) => sum + (known.get(n)?.minutes || 1), 0);
    return json({ ok: true, plan: { ...plan, programme: merged.programme, slides }, visit: merged, estimated_briefing_minutes: Math.round(minutes), master_text_available: !!masterText, warnings });
  } catch (e: any) {
    return fail(502, `排程失敗：${e?.message || e}`);
  }
};
