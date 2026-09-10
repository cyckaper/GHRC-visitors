import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import type { Visit } from "../lib/types.mts";
import { emptyVisit, isValidVisitId, makeVisitId, publicVisit, toCSV } from "../../lib/visit.mjs";

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
    const list = (await store.listVisits()).map((v) => ({ visit_id: v.visit_id, date: v.date, org: v.org?.name, type: v.org?.type, country: v.org?.country, headcount: v.headcount, status: v.status, language: v.language }));
    return json({ ok: true, visits: list, backend: store.backend });
  }

  if (req.method === "POST" || req.method === "PUT") {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const body = await readJSON<Partial<Visit>>(req);
    if (!body || typeof body !== "object") return fail(400, "需要 JSON body");
    // 已存在的參訪不能改 visit_id（網址已經發出去了）：忽略 code
    if (body.visit_id && (await store.getVisit(String(body.visit_id)))) delete (body as any).code;
    const merged = normalizeVisit(body, siteUrl(req));
    if (!merged.org?.name) return fail(400, "單位名稱必填");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(merged.date)) return fail(400, "日期格式需為 YYYY-MM-DD");
    const existing = await store.getVisit(merged.visit_id);
    merged.created_at = existing?.created_at || nowISO();
    merged.updated_at = nowISO();
    await store.putVisit(merged);
    return json({ ok: true, visit: merged });
  }

  return fail(405, "method not allowed");
};

export function normalizeVisit(input: Partial<Visit>, site: string): Visit {
  const base = emptyVisit() as Visit;
  const v: Visit = { ...base, ...input } as Visit;
  v.org = { ...base.org, ...(input.org || {}) } as Visit["org"];
  v.guests = Array.isArray(input.guests) ? input.guests.map((g) => ({ name: String(g.name || "").trim(), title: String(g.title || "").trim(), email: String(g.email || "").trim().toLowerCase(), role: (g.role === "lead" ? "lead" : "member") as "lead" | "member", affiliation: g.affiliation ? String(g.affiliation) : "" })).filter((g) => g.name || g.email) : [];
  if (v.guests.length && !v.guests.some((g) => g.role === "lead")) v.guests[0].role = "lead";
  v.headcount = Number(input.headcount) || v.guests.length || 0;
  v.duration_minutes = Number(input.duration_minutes) || 90;
  v.interests = Array.isArray(input.interests) ? input.interests.map(String) : [];
  v.programme = Array.isArray(input.programme) ? input.programme : [];
  v.itinerary = Array.isArray(input.itinerary) ? input.itinerary.map((s) => ({ room: String(s.room), minutes: Number(s.minutes) || 0, focus: s.focus || "" })) : [];
  v.slides = Array.isArray(input.slides) ? [...new Set(input.slides.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))] : [];
  v.text_edits = Array.isArray(input.text_edits) ? input.text_edits : [];
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
