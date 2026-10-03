import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import type { Visit } from "../lib/types.mts";
import { briefingBlockMinutes, deckFingerprint, emptyVisit, ensureBriefingFirst, isValidVisitId, makeVisitId, publicVisit, sanitizeMaterials, staleOutputs, toCSV, minutesBetween, endTimeOf, wrapupNA, retimeProgramme, withLabMinutes, needsGeo, sanitizeGeo, sanitizePublic, institutionKeys, visitEndAt, isForum, toForumProgramme, defaultProgramme } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";
import { purgePublicVisits } from "../lib/cdn.mts";
import { dropDraft, moveDraft } from "./draft.mts";

/**
 * GET  /api/visits?id=X&public=1   來賓端可見子集（不需授權）
 * GET  /api/visits?id=X            完整資料（admin）
 * GET  /api/visits                 列表（admin）
 * GET  /api/visits?export=csv&table=visits|responses|slide_performance（admin）
 * POST /api/visits                 新增或更新（admin）。**只寫後台表單管的欄位**：別的端點寫的（KEPT）帶了也不算
 * POST /api/visits {visit_id, action:"wrapup", na:[...]}  後續那四件事標「本次沒有」（只動 wrapup 這一格）
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
        table === "responses" ? await store.listResponses() : table === "slide_performance" ? await store.listSlidePerformance() : await store.listVisits();
      if (exp === "csv") return new Response(toCSV(rows as any[]), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${table}.csv"` } });
      return json({ ok: true, table, rows });
    }
    if (id) {
      const v = await store.getVisit(id);
      if (!v) return fail(404, "找不到這次參訪");
      const responses = await store.listResponses(id);
      // stale：已經交出去、但行程之後又改過的東西（畫面上要說一句，不能繼續顯示綠勾）。
      // 算在伺服器這一邊，指紋的算法就只有一份。
      return json({ ok: true, visit: v, responses, stale: staleOutputs(v) });
    }
    // geo：訪客地圖上這個單位在哪裡（/api/geo 查的）；geo_stale：還沒查、或單位改過名字，資料分頁會自己去查
    // group：匯入的舊紀錄裡，原表同一列拆出來的那幾筆（算同一場）；imported：這一場是從以前的名單匯入的
    const all = await store.listVisits();
    // inst：同一個單位的每一場都一樣（中文名稱一樣、或英文名稱去掉空白與標點後一樣），資料分頁的地圖照這個合成一個點
    const inst = institutionKeys(all);
    const list = all.map((v) => ({ visit_id: v.visit_id, date: v.date, org: v.org?.name, org_local: v.org?.name_local || "", type: v.org?.type, country: v.org?.country, headcount: v.headcount, status: v.status, language: v.language, guests: (v.guests || []).length, slides: (v.slides || []).length, summary: !!v.summary, updated_at: v.updated_at, geo: (v as any).geo ? { lat: (v as any).geo.lat, lon: (v as any).geo.lon, place: (v as any).geo.place, precision: (v as any).geo.precision } : null, geo_stale: needsGeo(v), group: (v as any).imported?.group || "", imported: !!(v as any).imported, inst: inst.get(v.visit_id) || "" }));
    return json({ ok: true, visits: list, backend: store.backend });
  }

  if (req.method === "POST" || req.method === "PUT") {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const body = await readJSON<Partial<Visit>>(req);
    if (!body || typeof body !== "object") return fail(400, "需要 JSON body");
    if ((body as any).action === "wrapup") return saveWrapupNA(store, String(body.visit_id || ""), (body as any).na);
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
    const fromForm = normalizeVisit(body, siteUrl(req));
    if (!fromForm.org?.name) return fail(400, "單位名稱必填");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromForm.date)) return fail(400, "日期格式需為 YYYY-MM-DD");
    const renamedFrom = current && fromForm.visit_id !== previousId ? previousId : "";
    if (renamedFrom && (await store.getVisit(fromForm.visit_id))) return fail(409, `已經有一場叫 ${fromForm.visit_id} 了，請換一個網址代碼`);
    // 後台表單那一份 ＋ 伺服器上現有的那一份。**一定要拿最新的那一份來合**：這一段在 updateVisit 裡跑，
    // 中間有人存過（研究室剛在支援人力表上填、背景剛備份完 Drive）就重讀重合，不會把人家剛存的蓋回去
    let unseen: string[] = [];
    const mergeWith = (existing: Visit | null): Visit => {
      const merged = structuredClone(fromForm);
      // 後台表單不管這幾件事（簽名簿、口述、名片、當天資料、信件、摘要、Drive、自動提醒、狀態都是別的端點或
      // 背景工作寫的）：**帶了也不算**，一律沿用伺服器上那一份；新的一場就從空的開始（見 KEPT）
      const blank = emptyVisit() as any;
      for (const k of KEPT) {
        const kept = existing ? (existing as any)[k] : blank[k];
        if (kept === undefined) delete (merged as any)[k];
        else (merged as any)[k] = kept;
      }
      if (!(["draft", "confirmed", "done"] as const).includes(merged.status)) merged.status = "draft"; // 舊資料（例如 Sheet 上空白那一格）
      // 訪前功課：還沒存檔就查好的那一份只在畫面上，靠存檔帶進來；伺服器上比較新的那一份蓋不掉（見 newerBackground）
      if (existing) {
        const background = newerBackground((body as any).background, (existing as any).background);
        if (background === undefined) delete (merged as any).background;
        else (merged as any).background = background;
      }
      // 簡報（deck）是「簡報」分頁在寫的：沒帶就沿用，帶了只改帶來的那幾格（勾「不用簡報」只送 skip、
      // 產檔只送 generated_at 與頁數）——訪前分頁的存檔不送 deck，產過的簡報就不會被它洗掉。指紋只由伺服器蓋（下面）
      const { fingerprint: _sentFingerprint, ...sentDeck } = ((body as any).deck && typeof (body as any).deck === "object" && !Array.isArray((body as any).deck) ? (body as any).deck : {}) as Visit["deck"];
      merged.deck = { ...(existing?.deck || {}), ...sentDeck };
      // 座談與否是訪前分頁在改的：沒帶就沿用伺服器上的（還開著舊版後台的那一台送來的沒有這一格，不能把座談改回參觀）
      if ((body as any).format === undefined && existing?.format) {
        merged.format = existing.format;
        enforceFormat(merged);
      }
      // 各研究室自己填的那幾格：帶了也不算，一律沿用伺服器上的（見 ROTA_FIELDS）
      if (existing) for (const k of ROTA_FIELDS) if ((existing as any)[k] !== undefined) (merged as any)[k] = (existing as any)[k];
      // 訪客地圖上的位置只有 geo-background 在寫：後台送回來的那一份一律不算（單位改了名字，key 對不上就會重查）
      if (existing) (merged as any).geo = (existing as any).geo;
      // 公開頁上的說明只有 /api/visit-log 在寫（「資料」分頁那一塊）：「訪前」開著的那一份是舊的，存檔時帶回來也不算
      if (existing) (merged as any).public = (existing as any).public;
      // 研究室填的分鐘已經自動排進行程（/api/rota）。**後台手上那一份還沒看過**（它的 updated_at 比那一間
      // 填的時間早）就不能把它蓋回去：那幾間照伺服器上的分鐘、今日流程重推一次。看過之後主辦端要改就照他的。
      // 座談的場次不參觀研究室：以前填過的分鐘不排回去
      const base = String((body as any).updated_at || "");
      const filledAt: Record<string, string> = (existing as any)?.lab_minutes_at || {};
      unseen = existing && !isForum(merged) ? Object.keys(filledAt).filter((room) => !base || filledAt[room] > base) : [];
      for (const room of unseen) {
        const step = (existing!.itinerary || []).find((s) => String(s.room) === room);
        if (step && Number(step.minutes) > 0) merged.itinerary = withLabMinutes(merged.itinerary, room, Number(step.minutes)) as Visit["itinerary"];
      }
      if (unseen.length) merged.programme = retimeProgramme(merged) as Visit["programme"];
      merged.created_at = existing?.created_at || nowISO();
      merged.updated_at = nowISO();
      // 剛產出來的那一份簡報：把**這一刻的行程指紋**記下來，之後行程改了才知道手上那個 .pptx 是舊的。
      // 指紋由伺服器蓋（前端只送 generated_at），算法就不會有兩份。
      if (merged.deck?.generated_at && merged.deck.generated_at !== existing?.deck?.generated_at) merged.deck = { ...merged.deck, fingerprint: deckFingerprint(merged) };
      return merged;
    };
    let merged: Visit;
    if (renamedFrom) {
      // 改網址代碼＝搬家：新的那一筆照舊那一筆（剛剛重讀的）合起來寫，再刪掉舊的
      merged = mergeWith((await store.getVisit(renamedFrom)) || current);
      await store.putVisit(merged);
      await store.deleteVisit(renamedFrom);
      await moveDraft(renamedFrom, merged.visit_id); // 手上還沒交出去的東西不該跟著舊網址消失
    } else {
      const updated = await store.updateVisit(fromForm.visit_id, (existing) => mergeWith(existing));
      if (updated) merged = updated;
      else {
        merged = mergeWith(null); // 新的一場
        await store.putVisit(merged);
      }
    }
    await triggerDriveSync(merged.visit_id);
    // 已經來過的那一場改了（單位名稱、國家、去了哪幾間……）：首頁的地圖與來訪紀錄頁跟著換，不必等 CDN 那一份過期。
    // 還沒來的不在公開頁上，存再多次也不必清
    if (hasHappened(merged) || (current && hasHappened(current))) await purgePublicVisits();
    // rota_applied：這一次存檔時，哪幾間研究室剛填的分鐘被保留下來（後台照這個說一聲「行程已照研究室填的更新」）
    return json({ ok: true, visit: merged, renamed_from: renamedFrom, url_fixed: renameBlocked, stale: staleOutputs(merged), rota_applied: unseen });
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
    if (hasHappened(visit)) await purgePublicVisits(); // 公開頁上也拿掉
    return json({ ok: true, deleted: id });
  }

  return fail(405, "method not allowed");
};

/** 這一場已經結束了（公開頁只列這種的；`visitEndAt` 跟後續提醒同一個算法）。 */
function hasHappened(v: Visit): boolean {
  const end = visitEndAt(v).getTime();
  return Number.isFinite(end) && end <= Date.now();
}

/**
 * 後台表單管不到的欄位——別的端點或背景工作在寫：摘要（summary）、後續提醒（reminder-cron）、Drive 備份、
 * 名片、簽名簿、口述、當天資料（materials）、信件與寄出紀錄（letter）、寄信時跟著改的狀態（status）、
 * 後續那四件事的「本次沒有」（wrapup，走 `action: "wrapup"`）、從以前的名單匯入的來源（imported，匯入時寫的）。
 * 一般存檔**帶了也不算**，一律沿用伺服器上那一份。
 *
 * 以前是「body 沒帶才沿用」，可是後台的 readForm() 一直是把手上那一份**整個**送回來的，這幾格幾乎每次都帶著，
 * 而且常常是舊的：確認信剛寄出，訪前分頁改一個字自動存檔，`letters.confirmation.sent_at` 就被洗掉——
 * isUnused() 又把網址當成還沒用出去，下一次改日期或代碼就搬家，寄出去的那個連結跟著失效。
 * 提醒紀錄被洗掉則會害後續提醒重寄一次。要改這幾格，走寫它的那一支端點。
 */
const KEPT = ["summary", "summary_at", "reminders", "drive", "cards", "signbook", "dictation", "letters", "materials", "status", "wrapup", "imported"] as const;

/**
 * 訪前功課（background）要保留哪一份。research-background 會把結果寫回存過檔的那一場；
 * **還沒存檔就查好的那一份只在畫面上**，要靠存檔帶進來——查的時候還沒存檔、查完之前自動存檔先建好了這一場，
 * 也是走這一條路。所以送上來的那一份**只有比伺服器上的新**才算（查完的時間較晚，兩邊都不是還在查）；
 * 開著舊資料的分頁送回來的是比較舊的那一份，蓋不掉新的，也蓋不掉「查資料中」。
 */
function newerBackground(sent: any, stored: any): any {
  if (!sent || typeof sent !== "object" || Array.isArray(sent)) return stored;
  if (!stored) return sent;
  if (sent.status === "running" || stored.status === "running") return stored;
  return String(sent.researched_at || "") > String(stored.researched_at || "") ? sent : stored;
}

/**
 * 後續分頁那幾個「本次沒有」的勾：**只動 wrapup 這一格**。以前是把後續分頁手上那一份整筆送回一般存檔，
 * 那一份常常是舊的（信件剛寄出、名單剛併進名片上的人）——現在一般存檔不收 wrapup，改走這一支。
 */
async function saveWrapupNA(store: ReturnType<typeof getStore>, id: string, na: unknown): Promise<Response> {
  if (!isValidVisitId(id)) return fail(400, "visit_id 格式不對");
  const picked = wrapupNA({ wrapup: { na } });
  const saved = await store.updateVisit(id, (v) => {
    if (JSON.stringify(wrapupNA(v)) === JSON.stringify(picked)) return false;
    (v as any).wrapup = { na: picked };
    v.updated_at = nowISO();
  });
  if (!saved) return fail(404, "找不到這次參訪");
  await triggerDriveSync(saved.visit_id);
  return json({ ok: true, visit: saved, stale: staleOutputs(saved) });
}

/**
 * **只有 `/api/rota` 在寫**的欄位——各研究室自己在支援人力表上填的接待人員（`presenters`）與
 * 共需幾分鐘（`lab_minutes`）。這幾個**帶了也不算**，一律沿用伺服器上那一份：
 * 後台開著的那一份常常是老師填之前載入的，改一個字觸發自動存檔就會把老師剛填的蓋掉（跟上面 KEPT 同一個道理）。
 * 後台自己要改這幾格也走 `/api/rota`（admin 打得動，設定分頁那張表就是）。
 * `lab_minutes_at`：各間是什麼時候填的（存檔時比對，後台還沒看過的分鐘不蓋回去）；
 * `lab_added`：哪幾間是研究室自己填進動線的（支援人力表判斷「這一場排了沒」用）。
 * `lab_hours` 是改成「共需幾分鐘」之前問的「方便的時段」：不再收，存過的也不刪。
 * `attendance`：座談的場次各間的老師能否出席（yes／no），一樣只有 `/api/rota` 在寫。
 */
const ROTA_FIELDS = ["presenters", "lab_minutes", "lab_minutes_at", "lab_added", "lab_hours", "attendance"] as const;

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

/**
 * 座談的場次：動線上只留總體介紹，流程裡的研究室參訪換成座談（`lib/visit.mjs toForumProgramme`）。
 * 還沒有流程的就照座談的預設排一份（總體介紹 → 座談）——不然換出來只有孤零零一段座談，總體介紹不見了。
 */
function enforceFormat(v: Visit): void {
  if (!isForum(v)) return;
  v.itinerary = (v.itinerary || []).filter((s) => s.room === "briefing");
  const programme = (v.programme || []).filter(Boolean);
  if (!programme.length) v.programme = defaultProgramme(v) as Visit["programme"];
  else if (programme.some((b) => b?.kind === "tour") || !programme.some((b) => b?.kind === "forum")) v.programme = toForumProgramme(programme, v.start_time) as Visit["programme"];
}

export function normalizeVisit(input: Partial<Visit>, site: string): Visit {
  const base = emptyVisit() as Visit;
  const v: Visit = { ...base, ...input } as Visit;
  v.org = { ...base.org, ...(input.org || {}) } as Visit["org"];
  v.guests = Array.isArray(input.guests) ? input.guests.map((g) => ({ name: String(g.name || "").trim(), title: String(g.title || "").trim(), email: String(g.email || "").trim().toLowerCase(), role: (g.role === "lead" ? "lead" : "member") as "lead" | "member", affiliation: g.affiliation ? String(g.affiliation) : "", phone: g.phone ? String(g.phone).slice(0, 60) : "", contact: g.contact === true || String(g.contact) === "true" })).filter((g) => g.name || g.email) : [];
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
  // 訪客地圖上的位置（geo-background 寫的）：只留認得的欄位；存檔時一律沿用伺服器上那一份
  (v as any).geo = sanitizeGeo((input as any).geo);
  // 公開頁上的說明（/api/visit-log 寫的；匯入時帶原表的）：只留認得的欄位
  (v as any).public = sanitizePublic((input as any).public);
  v.language = (["en", "zh", "ko", "ja"] as const).includes(v.language) ? v.language : "en";
  // 座談的場次（跟老師們座談，不參觀研究室）：動線上只留總體介紹，流程裡的「研究室參訪」換成座談
  // （後台勾的時候已經換好了；這裡是保險——不管誰送來的，座談的場次都不會留著研究室的分鐘）
  v.format = (input as any).format === "forum" ? "forum" : "tour";
  enforceFormat(v);
  v.status = (["draft", "confirmed", "done"] as const).includes(v.status) ? v.status : "draft";
  v.deck = input.deck || {};
  v.signbook = input.signbook || {};
  v.dictation = input.dictation || {};
  v.letters = input.letters || {};
  v.summary = typeof input.summary === "string" ? input.summary : "";
  // 後續那四件事裡標了「本次沒有」的（只留認得的那四個 key，其他一律丟掉）
  (v as any).wrapup = { na: wrapupNA({ wrapup: (input as any).wrapup }) };
  // 各研究室自己填的（接待人員、共需幾分鐘）**只有 `/api/rota` 在寫**：這裡一律從空的開始，
  // 存檔時由上面的 ROTA_FIELDS 沿用伺服器上那一份
  (v as any).presenters = {};
  (v as any).lab_minutes = {};
  (v as any).lab_minutes_at = {};
  (v as any).lab_added = [];
  (v as any).attendance = {};
  delete (v as any).lab_hours;
  const code = String((input as any).code || "").trim();
  if (!isValidVisitId(v.visit_id) || code) v.visit_id = makeVisitId(v.date, v.org.name, code);
  v.page_url = `${site}/${v.visit_id}`;
  return v;
}
