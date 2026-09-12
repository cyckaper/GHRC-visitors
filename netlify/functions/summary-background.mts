import { nowISO } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { digestSuggestions, summarizeVisit } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import type { SlidePerf } from "../lib/types.mts";
import { reconcileTimeline } from "../../lib/timeline.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/** 一頁摘要與跨場次彙整（背景函式，15 分鐘上限）。 */
export default backgroundHandler<{ visit_id?: string; digest?: boolean }>("摘要", async (input) => {
  const store = getStore();

  if (input.digest) {
    const [visits, responses] = await Promise.all([store.listVisits(), store.listResponses()]);
    const byId = new Map(visits.map((v) => [v.visit_id, v]));
    const items = responses
      .filter((r) => r.suggestion)
      .map((r) => ({ visit_id: r.visit_id, date: byId.get(r.visit_id)?.date || "", org_type: byId.get(r.visit_id)?.org?.type || "", suggestion: r.suggestion }));
    if (!items.length) return { digest: "（目前還沒有收到開放建議）", count: 0 };
    return { digest: await digestSuggestions(items), count: items.length };
  }

  const visit = await store.getVisit(String(input.visit_id || ""));
  if (!visit) throw new Error("找不到這次參訪");
  const [responses, signals, slidesIndex] = await Promise.all([store.listResponses(visit.visit_id), store.listTimeline(visit.visit_id), loadPublicData("slides")]);
  const timeline = reconcileTimeline(visit, signals);
  const summary = await summarizeVisit(visit, responses, timeline);
  visit.summary = summary;
  visit.updated_at = nowISO();
  await store.putVisit(visit);

  // slide_performance：這次選了哪幾頁、哪幾頁的實驗室被提問／在回饋中被提到
  const askedText = (visit.dictation?.extracted?.questions || []).join(" ");
  const feedbackText = responses.map((r) => `${r.suggestion} ${r.note} ${r.signbook_text}`).join(" ");
  const wanted = new Set([...(visit.dictation?.extracted?.most_wanted_rooms || []), ...responses.flatMap((r) => [...(r.most_wanted_rooms || []), ...(r.cooperate_rooms || [])])]);
  const existing = await store.listSlidePerformance(visit.visit_id);
  if (!existing.length) {
    const rows: SlidePerf[] = (slidesIndex.slides as any[])
      .filter((s) => visit.slides.includes(s.n))
      .map((s) => ({
        visit_id: visit.visit_id,
        org_type: visit.org?.type || "other",
        slide: s.n,
        used: true,
        asked: !!s.lab && (askedText.includes(s.lab) || wanted.has(s.lab)),
        mentioned: !!s.lab && feedbackText.includes(s.lab),
      }));
    await store.appendSlidePerformance(rows);
  }
  await triggerDriveSync(visit.visit_id);
  return { summary, timeline };
});
