import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import type { Visit } from "../lib/types.mts";
import { briefingBlockMinutes, emptyVisit, ensureBriefingFirst, isValidVisitId, makeVisitId, publicVisit, sanitizeMaterials, toCSV, minutesBetween, endTimeOf } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";
import { dropDraft, moveDraft } from "./draft.mts";

/**
 * GET  /api/visits?id=X&public=1   來賓端可見子集（不需授權）
 * GET  /api/visits?id=X            完整資料（admin）
 * GET  /api/visits                 列表（admin）
 * GET  /api/visits?export=csv&table=visits|responses|timeline|slide_performance（admin）
 * POST /api/visits                 新增或更新（admin）
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const store = getStore();

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id && url.searchParams.get("public") === "1") {
      if (!isValidVisitId(id)) return fail(400, "visit_id 格式不對");
      const v = await store.getVisit(id);
      if (!v) return fail(404, "找不到這次參訪");
      return json({ ok: true, visit: publicVisit(v) }, { headers: { "cache-control": "public, max-age=60" } });
    }
    const denied = requireAdmin(req);
    if (denied) return denied;
    const exp = url.searchParams.get("export");
    if (exp) {
      const table = url.searchParams.get("table") || "visits";
      const rows =
        table === "responses" ? await store.listResponses() : table === "timeline" ? await store.listTimeline() : table === "slide_performance" ? await store.listSlidePerformance() : await store.listVisits();
      if (exp === "csv") return new Response(toCSV(rows as any[]), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${table}.csv"` } });
      return json({ ok: true, table, rows });
    }
    if (id) {
      const v = await store.getVisit(id);
      if (!v) return fail(404, "找不到這次參訪");
      const responses = await store.listResponses(id);
      return json({ ok: true, visit: v, responses });
    }
    const list = (await store.listVisits()).map((v) => ({ visit_id: v.visit_id, date: v.date, org: v.org?.name, type: v.org?.type, country: v.org?.country, headcount: v.headcount, status: v.status, language: v.language, guests: (v.guests || []).length, slides: (v.slides || []).length, summary: !!v.summary, updated_at: v.updated_at }));
    return json({ ok: true, visits: list, backend: store.backend });
  }

  if (req.method === "POST" || req.method === "PUT") {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const body = await readJSON<Partial<Visit>>(req);
    if (!body || typeof body !== "object") return fail(400, "需要 JSON body");
    const previousId = String(body.visit_id || "");
    const current = previousId ? await store.getVisit(previousId) : null;
    let renameBlocked = false;
    if (current) {
      // 網址還沒用出去（沒人回覆、沒寄信、沒放東西）就跟著日期與代碼走；用出去了就固定，不能再換
      if (await isUnused(store, current)) (body as any).code = String((body as any).code || "").trim() || previousId.slice(11);
      else {
        delete (body as any).code;
        renameBlocked = true;
      }
    }
    const merged = normalizeVisit(body, siteUrl(req));
    if (!merged.org?.name) return fail(400, "單位名稱必填");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(merged.date)) return fail(400, "日期格式需為 YYYY-MM-DD");
    const renamedFrom = current && merged.visit_id !== previousId ? previousId : "";
    if (renamedFrom && (await store.getVisit(merged.visit_id))) return fail(409, `已經有一場叫 ${merged.visit_id} 了，請換一個網址代碼`);
    const existing = renamedFrom ? current : await store.getVisit(merged.visit_id);
    // 後台表單不管這幾件事（簽名簿、口述、名片、當天資料、信件、摘要、Drive、自動提醒都是別的端點或
    // 背景工作寫的）。body 沒帶就沿用現有的：不然在別的分頁開著舊資料按一下存檔，就會把它們清掉——
    // 提醒紀錄被清掉還會害收工提醒重寄一次。
    if (existing) for (const k of KEPT) if ((body as any)[k] === undefined) (merged as any)[k] = (existing as any)[k];
    merged.created_at = existing?.created_at || nowISO();
    merged.updated_at = nowISO();
    await store.putVisit(merged);
    if (renamedFrom) {
      await store.deleteVisit(renamedFrom);
      await moveDraft(renamedFrom, merged.visit_id); // 手上還沒交出去的東西不該跟著舊網址消失
    }
    await triggerDriveSync(merged.visit_id);
    return json({ ok: true, visit: merged, renamed_from: renamedFrom, url_fixed: renameBlocked });
  }

  if (req.method === "DELETE") {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const id = url.searchParams.get("id") || "";
    const visit = await store.getVisit(id);
    if (!visit) return fail(404, "找不到這次參訪");
    // 來賓的回覆與寄出去的信不是我們的東西，有這些就不給刪
    if ((await store.listResponses(id)).length) return fail(409, "這一場已經有來賓回覆了，不刪。要清掉請直接改 Google Sheet 或聯絡管理者。");
    if (visit.letters?.thanks?.sent_at) return fail(409, "這一場的感謝信已經寄出去了，不刪。");
    for (const key of mediaKeys(visit)) await store.deleteMedia(key).catch(() => {});
    await dropDraft(id);
    await store.deleteVisit(id);
    return json({ ok: true, deleted: id });
  }

  return fail(405, "method not allowed");
};

/** 這幾個欄位由別的端點或背景工作維護，一般存檔不該動到。 */
const KEPT = ["summary", "summary_at", "reminders", "drive", "cards", "signbook", "dictation", "letters", "materials", "background"] as const;

/** 這一場的網址還沒「用出去」：沒人回覆、兩封信都還沒寄出、沒放任何檔案、還沒備份到 Drive。 */
async function isUnused(store: ReturnType<typeof getStore>, v: Visit): Promise<boolean> {
  const a = v as any;
  // 確認信裡就有來賓專頁的網址，寄出去之後對方手上那個連結不能失效
  if (v.letters?.thanks?.sent_at || v.letters?.confirmation?.sent_at) return false;
  if (v.materials?.deck_pdf || v.materials?.photos?.length || v.materials?.links?.length) return false;
  if (v.signbook?.photo_key || v.dictation?.audio_key || v.dictation?.transcript) return false;
  if (a.cards?.length || a.drive?.backed_up_at) return false;
  return !(await store.listResponses(v.visit_id)).length;
}

/** 這一場自己的檔案（簽名簿、口述、名片、當天資料）——刪掉這一場就一起清掉。 */
function mediaKeys(v: Visit): string[] {
  const a = v as any;
  const keys = [v.signbook?.photo_key, v.dictation?.audio_key, v.materials?.deck_pdf, ...(v.materials?.photos || []), ...((a.cards || []) as { key: string }[]).map((c) => c.key)];
  return keys.filter((k): k is string => typeof k === "string" && !!k && !/^https?:/i.test(k));
}

export function normalizeVisit(input: Partial<Visit>, site: string): Visit {
  const base = emptyVisit() as Visit;
  const v: Visit = { ...base, ...input } as Visit;
  v.org = { ...base.org, ...(input.org || {}) } as Visit["org"];
  v.guests = Array.isArray(input.guests) ? input.guests.map((g) => ({ name: String(g.name || "").trim(), title: String(g.title || "").trim(), email: String(g.email || "").trim().toLowerCase(), role: (g.role === "lead" ? "lead" : "member") as "lead" | "member", affiliation: g.affiliation ? String(g.affiliation) : "", phone: g.phone ? String(g.phone).slice(0, 60) : "" })).filter((g) => g.name || g.email) : [];
  if (v.guests.length && !v.guests.some((g) => g.role === "lead")) v.guests[0].role = "lead";
  v.headcount = Number(input.headcount) || v.guests.length || 0;
  // **主辦端填的是幾點開始、幾點結束**；總分鐘由這兩個算出來（下游的排程、提醒、ICS 都還是吃 duration_minutes）
  v.start_time = String(input.start_time || base.start_time).trim();
  const spanned = minutesBetween(v.start_time, input.end_time);
  if (!spanned) v.end_time = ""; // 結束早於開始＝填錯：丟掉它，下一行用原本的長度算回一個對的
  v.duration_minutes = spanned || Number(input.duration_minutes) || 90;
  v.end_time = endTimeOf(v);
  v.interests = Array.isArray(input.interests) ? input.interests.map(String) : [];
  v.programme = Array.isArray(input.programme) ? input.programme : [];
  v.itinerary = Array.isArray(input.itinerary) ? input.itinerary.map((s) => ({ room: String(s.room), minutes: Number(s.minutes) || 0, focus: s.focus || "", location: s.location ? String(s.location).slice(0, 60) : "" })) : [];
  // 研究室動線一定先一場總體介紹
  v.itinerary = ensureBriefingFirst(v.itinerary, briefingBlockMinutes(v.programme) || 20);
  v.slides = Array.isArray(input.slides) ? [...new Set(input.slides.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))] : [];
  v.text_edits = Array.isArray(input.text_edits) ? input.text_edits : [];
  v.materials = sanitizeMaterials((input as any).materials);
  v.language = (["en", "zh", "ko", "ja"] as const).includes(v.language) ? v.language : "en";
  v.status = (["draft", "confirmed", "done"] as const).includes(v.status) ? v.status : "draft";
  v.deck = input.deck || {};
  v.signbook = input.signbook || {};
  v.dictation = input.dictation || {};
  v.letters = input.letters || {};
  v.summary = typeof input.summary === "string" ? input.summary : "";
  const code = String((input as any).code || "").trim();
  if (!isValidVisitId(v.visit_id) || code) v.visit_id = makeVisitId(v.date, v.org.name, code);
  v.page_url = `${site}/${v.visit_id}`;
  return v;
}
