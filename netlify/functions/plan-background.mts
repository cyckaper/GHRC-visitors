import { siteUrl } from "../lib/http.mts";
import { loadMasterText, loadPublicData } from "../lib/data.mts";
import { planVisit } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { slideHistory } from "../lib/history.mts";
import { getStore } from "../lib/store.mts";
import type { Visit } from "../lib/types.mts";
import { normalizeVisit } from "./visits.mts";
import { applyProgrammeTimes, briefingBlockMinutes, ensureBriefingFirst, retimeProgramme, snapSlidesToGroups, withLabMinutes } from "../../lib/visit.mjs";

/**
 * 排行程與選頁（背景函式，15 分鐘上限）：提示詞裡有整份頁次索引與母簡報文字，
 * Claude 要吐的又是一整份行程＋選頁，一般函式的 10 秒撐不住。
 * 由 /api/plan 觸發，只帶 job_id；要排的那一筆從 job 自己讀，結果寫回 job。
 */
export default backgroundHandler<{ visit?: Partial<Visit> }>("排程", async (input, req) => {
  const visit = normalizeVisit(input.visit || {}, siteUrl(req));
  const [slidesIndex, labs, masterText, history, stored] = await Promise.all([
    loadPublicData("slides"),
    loadPublicData("labs"),
    loadMasterText(),
    // 歷次累積回饋這一次的挑頁：同類單位選過什麼、哪幾頁引發提問、哪幾間被點名
    slideHistory(getStore(), visit.org?.type || "other", visit.visit_id).catch(() => null),
    // 各研究室在支援人力表上填的（接待人員、共需幾分鐘）只在伺服器上那一份：送上來的那一份不帶
    input.visit?.visit_id ? getStore().getVisit(String(input.visit.visit_id)).catch(() => null) : null,
  ]);
  const plan = await planVisit(visit, slidesIndex, labs, masterText, history);
  // 後端再驗一次：頁次必須存在、always 頁一定在、順序依母簡報頁序。
  // 而且**選頁以區塊為單位**（後台只勾區塊）：AI 挑到某一區的任何一頁，就整個區塊一起進去，
  // 這樣「也挑了 N 頁」跟簡報分頁上看到的才會是同一件事。
  const known = new Map<number, any>((slidesIndex.slides as any[]).map((s) => [s.n, s]));
  const slides = snapSlidesToGroups(plan.slides.filter((n) => known.has(n)), slidesIndex);
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
  // **研究室在支援人力表上填了分鐘的，照研究室填的**（明確指示：各研究室填的時間自動排進行程）——
  // 上面那一步的預設蓋不掉。填了分鐘就是要接待，AI 沒排到那一間也放回動線（不去的話主辦端改成 0）
  const rota = { presenters: (stored as any)?.presenters || {}, lab_minutes: (stored as any)?.lab_minutes || {}, lab_minutes_at: (stored as any)?.lab_minutes_at || {}, lab_added: (stored as any)?.lab_added || [] };
  const filled = Object.entries(rota.lab_minutes as Record<string, number>).filter(([, m]) => Number(m) > 0);
  if (filled.length) {
    let itinerary = merged.itinerary;
    for (const [room, m] of filled) itinerary = withLabMinutes(itinerary, room, Number(m)) as Visit["itinerary"];
    merged = { ...merged, itinerary };
    merged.programme = retimeProgramme(merged) as Visit["programme"];
    warnings.push(`${filled.map(([room]) => room).join("、")} 的分鐘照研究室在支援人力表上填的。`);
  }
  // 回傳的這一份帶著伺服器上的那幾格，行程表上「研究室填」的標記才不會在存檔回來之前閃掉
  merged = { ...merged, ...rota } as Visit;
  const minutes = slides.reduce((sum, n) => sum + (known.get(n)?.minutes || 1), 0);
  return { plan: { ...plan, programme: merged.programme, slides }, visit: merged, estimated_briefing_minutes: Math.round(minutes), master_text_available: !!masterText, history: history ? { visits: history.visits, same_type: history.same_type } : null, warnings };
});
