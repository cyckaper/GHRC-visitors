/** visits 資料的共用小工具（Netlify function、CLI、測試共用，純 JS 無相依）。 */

export const ROOMS = ["301", "302", "303", "304", "305"];
/** 動線的固定第一步：總體介紹（總體簡報）。room 欄位用 "briefing" 標記，不是實驗室。 */
export const BRIEFING = "briefing";
export const ROUTE = [BRIEFING, ...ROOMS];
export const DEFAULT_BRIEFING_MINUTES = 20;
/** 總體介紹的地點（造園館三樓 302；可在後台改）。 */
export const DEFAULT_BRIEFING_LOCATION = "302";
export const DEFAULT_ROOM_MINUTES = 20;
export const DEFAULT_PHOTO_MINUTES = 5;
export const MIN_DISCUSSION_MINUTES = 10;
export const DEFAULT_DURATION_MINUTES = 150; // 20 ＋ 5×20 ＋ 綜合討論 25 ＋ 合照 5

/**
 * 今日流程的時間分配規則：總體介紹 20 分、每間研究室 20 分、合照 5 分，
 * 前面扣掉之後剩下的時間全部給綜合討論。總時間不夠時才依序縮短：先研究室（每間至少 5 分）、再總體介紹（至少 10 分），
 * 綜合討論至少留 10 分。
 * @returns {{briefing:number, perRoom:number, rooms:number[], discussion:number, photo:number}}
 */
export function allocateProgramme(totalMinutes, roomCount, { briefing = DEFAULT_BRIEFING_MINUTES, perRoom = DEFAULT_ROOM_MINUTES, photo = DEFAULT_PHOTO_MINUTES } = {}) {
  const total = Math.max(0, Number(totalMinutes) || 0);
  const n = Math.max(0, roomCount | 0);
  let photoMin = total >= 60 ? photo : 0;
  let brief = briefing;
  let room = perRoom;
  let discussion = total - brief - n * room - photoMin;
  if (discussion < MIN_DISCUSSION_MINUTES) {
    discussion = MIN_DISCUSSION_MINUTES;
    const forRooms = total - discussion - brief - photoMin;
    room = n ? Math.max(5, Math.floor(forRooms / n)) : 0;
    if (brief + n * room + photoMin + discussion > total) brief = Math.max(10, total - discussion - n * room - photoMin);
    discussion = Math.max(0, total - brief - n * room - photoMin);
  }
  return { briefing: brief, perRoom: room, rooms: Array.from({ length: n }, () => room), discussion, photo: photoMin };
}
export const LANGUAGES = ["en", "zh", "ko", "ja"];
export const ORG_TYPES = ["government", "university", "enterprise", "school", "ngo", "other"];

/** visit_id：YYYY-MM-DD-代碼，例如 2026-10-07-uwa */
export function makeVisitId(date, orgName, code) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : new Date().toISOString().slice(0, 10);
  let slug = (code || "").trim().toLowerCase();
  if (!slug) {
    const ascii = String(orgName || "")
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !["the", "of", "and", "university", "college", "department", "national"].includes(w));
    slug = ascii[0] || "visit";
  }
  slug = slug.replace(/[^a-z0-9-]/g, "").slice(0, 24) || "visit";
  return `${d}-${slug}`;
}

export function isValidVisitId(id) {
  return /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,32}$/.test(String(id || ""));
}

/** 專屬頁面的「當天資料」空值。 */
export function emptyMaterials() {
  return { deck_pdf: "", photos: [], links: [] };
}

/**
 * 整理 visit.materials：deck_pdf 與 photos 是媒體庫 key（materials/<visit_id>/<file>）或 https 連結；links 是 {title, url}。
 * 不合格的一律丟掉，不補、不猜。
 */
export function sanitizeMaterials(m) {
  const src = m && typeof m === "object" ? m : {};
  const isKey = (x) => /^materials\/[\w-]+\/[\w.-]+$/.test(x);
  const isUrl = (x) => /^https?:\/\/\S+$/i.test(x);
  const str = (x, n) => String(x == null ? "" : x).trim().slice(0, n);
  const deck = str(src.deck_pdf, 500);
  return {
    deck_pdf: isKey(deck) || isUrl(deck) ? deck : "",
    photos: (Array.isArray(src.photos) ? src.photos : []).map((x) => str(x, 500)).filter((x) => isKey(x) || isUrl(x)).slice(0, 30),
    links: (Array.isArray(src.links) ? src.links : [])
      .map((l) => ({ title: str(l && l.title, 160), url: str(l && l.url, 500) }))
      .filter((l) => isUrl(l.url))
      .map((l) => ({ title: l.title || l.url.replace(/^https?:\/\//, "").slice(0, 80), url: l.url }))
      .slice(0, 30),
  };
}

/**
 * 把名片上讀到的人併進參訪名單：email 相同（不分大小寫）或「姓名＋單位」相同就當同一個人，
 * 只補空欄位，**不覆寫已經確認過的資料**；主賓身分不會被名片改掉。
 * @returns {{guests: Array, added: number, merged: number}}
 */
export function mergeGuests(existing = [], incoming = []) {
  const str = (x, n = 200) => String(x == null ? "" : x).trim().slice(0, n);
  const keyOf = (g) => str(g.email).toLowerCase() || `${str(g.name).toLowerCase()}|${str(g.affiliation).toLowerCase()}`;
  const guests = (Array.isArray(existing) ? existing : []).map((g) => ({ ...g }));
  const seen = new Map(guests.map((g) => [keyOf(g), g]));
  let added = 0;
  let merged = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const g = {
      name: str(raw && raw.name, 120),
      title: str(raw && raw.title, 160),
      email: str(raw && raw.email, 200).toLowerCase(),
      affiliation: str(raw && raw.affiliation, 200),
      phone: str(raw && raw.phone, 60),
      role: "member",
    };
    if (!g.name && !g.email) continue;
    const hit = seen.get(keyOf(g));
    if (hit) {
      let touched = false;
      for (const f of ["title", "email", "affiliation", "phone"]) {
        if (!hit[f] && g[f]) {
          hit[f] = g[f];
          touched = true;
        }
      }
      if (touched) merged += 1;
    } else {
      guests.push(g);
      seen.set(keyOf(g), g);
      added += 1;
    }
  }
  return { guests, added, merged };
}

/**
 * 專屬頁面上「實際有」的內容清單（給訪後信的提示詞用：信裡只能承諾這裡列出的東西）。
 * @param {object} visit
 * @param {{labs?: Array}} labs public/data/labs.json
 * @returns {Array<{key:string, zh:string}>}
 */
export function pageContents(visit, labs) {
  const m = sanitizeMaterials(visit && visit.materials);
  const route = (visit && visit.itinerary ? visit.itinerary : []).map((s) => String(s.room)).filter((r) => r !== BRIEFING);
  const all = (labs && labs.labs) || [];
  const onRoute = route.length ? all.filter((l) => route.includes(String(l.room))) : all;
  const out = [{ key: "programme", zh: "當天流程，以及五間研究室的介紹（負責老師、研究一句話、專長）" }];
  if (m.deck_pdf) out.push({ key: "deck_pdf", zh: "當天簡報 PDF" });
  if (m.photos.length) out.push({ key: "photos", zh: `現場合照 ${m.photos.length} 張` });
  if (m.links.length) out.push({ key: "links", zh: `相關連結（${m.links.map((l) => l.title).join("、")}）` });
  if (onRoute.some((l) => Array.isArray(l.papers) && l.papers.length)) out.push({ key: "papers", zh: "研究室的代表論文清單" });
  if (onRoute.some((l) => l.lead && l.lead.email)) out.push({ key: "contacts", zh: "老師的聯絡方式（email）" });
  out.push({ key: "respond", zh: "三個回應項目的表單（想合作的研究室、希望我們做什麼、可不具名的開放建議）" });
  return out;
}

/** 來賓端可見的子集：不含 email、信件、逐字稿、摘要。 */
export function publicVisit(v) {
  if (!v) return null;
  return {
    visit_id: v.visit_id,
    date: v.date,
    start_time: v.start_time,
    duration_minutes: v.duration_minutes,
    org: v.org ? { name: v.org.name, name_local: v.org.name_local, country: v.org.country } : null,
    headcount: v.headcount,
    contact_teacher: v.contact_teacher,
    language: v.language || "en",
    programme: v.programme || [],
    itinerary: v.itinerary || [],
    materials: sanitizeMaterials(v.materials),
    status: v.status,
  };
}

/** 空白 visit 物件（後台新建時的預設值）。 */
export function emptyVisit() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    visit_id: "",
    date: today,
    start_time: "10:00",
    duration_minutes: DEFAULT_DURATION_MINUTES,
    org: { name: "", name_local: "", type: "university", country: "" },
    guests: [],
    headcount: 0,
    contact_teacher: "張俊彥",
    purpose: "",
    interests: [],
    language: "en",
    programme: [],
    itinerary: [{ room: BRIEFING, minutes: DEFAULT_BRIEFING_MINUTES, location: DEFAULT_BRIEFING_LOCATION }, ...ROOMS.map((room) => ({ room, minutes: DEFAULT_ROOM_MINUTES }))],
    slides: [],
    text_edits: [],
    page_url: "",
    materials: emptyMaterials(),
    deck: {},
    signbook: {},
    dictation: {},
    letters: {},
    summary: "",
    status: "draft",
    created_at: "",
    updated_at: "",
  };
}

/**
 * 研究室動線一定先一場總體介紹：把 briefing 步驟放到第一位（沒有就補上），地點沒填就是 302。
 * @param {Array<{room:string, minutes:number, location?:string}>} itinerary
 * @param {number} defaultMinutes 沒有 briefing 步驟時用的分鐘數（通常取今日流程 briefing 區塊的長度）
 */
export function ensureBriefingFirst(itinerary, defaultMinutes = DEFAULT_BRIEFING_MINUTES) {
  const steps = Array.isArray(itinerary) ? itinerary.map((s) => ({ ...s, room: String(s.room) })) : [];
  const existing = steps.find((s) => s.room === BRIEFING);
  const rest = steps.filter((s) => s.room !== BRIEFING);
  const briefing = existing
    ? { ...existing, minutes: Number(existing.minutes) || defaultMinutes, location: String(existing.location || "").trim() || DEFAULT_BRIEFING_LOCATION }
    : { room: BRIEFING, minutes: defaultMinutes, location: DEFAULT_BRIEFING_LOCATION };
  return [briefing, ...rest];
}

/** 今日流程裡 briefing 區塊的長度（分鐘），沒有就回 null。 */
export function briefingBlockMinutes(programme) {
  const b = (programme || []).find((x) => x && x.kind === "briefing" && x.start && x.end);
  if (!b) return null;
  const [sh, sm] = b.start.split(":").map(Number);
  const [eh, em] = b.end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}

/**
 * 把「時間分配預設」套到 AI 排好的流程上：**AI 決定哪幾間、順序與重點，分鐘數一律照規則重算**
 * （總體介紹 20、每間研究室 20、合照 5，剩下給綜合討論；時間不夠才依序縮短，見 allocateProgramme）。
 * 不這樣做的話每一場的長度都由 AI 隨手決定，同樣 150 分鐘的兩場會排出不一樣的每間時間。
 * @returns {{programme: Array, itinerary: Array, alloc: {briefing:number, perRoom:number, rooms:number[], discussion:number, photo:number}, changed: boolean}}
 */
export function applyProgrammeTimes(visit) {
  const toMin = (t) => {
    const [h, m] = String(t || "").split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const fmt = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(((mins % 60) + 60) % 60).padStart(2, "0")}`;
  const blockMinutes = (b) => {
    const s = toMin(b && b.start);
    const e = toMin(b && b.end);
    return s != null && e != null && e > s ? e - s : 0;
  };
  const steps = Array.isArray(visit.itinerary) ? visit.itinerary : [];
  const briefingStep = steps.find((s) => String(s.room) === BRIEFING) || {};
  const rooms = steps.filter((s) => String(s.room) !== BRIEFING && (Number(s.minutes) || 0) > 0);
  const alloc = allocateProgramme(visit.duration_minutes, rooms.length);
  const blocks = Array.isArray(visit.programme) ? visit.programme : [];
  const otherTotal = blocks.filter((b) => b && b.kind === "other").reduce((n, b) => n + blockMinutes(b), 0);
  const discussion = Math.max(MIN_DISCUSSION_MINUTES, alloc.discussion - otherTotal);
  let cur = toMin(visit.start_time) ?? toMin("10:00");
  const programme = blocks.map((b) => {
    const kind = b && b.kind;
    const len =
      kind === "briefing" ? alloc.briefing
      : kind === "tour" ? rooms.length * alloc.perRoom
      : kind === "discussion" ? discussion
      : kind === "photo" ? alloc.photo || blockMinutes(b)
      : blockMinutes(b);
    const start = fmt(cur);
    cur += len;
    return { ...b, start, end: fmt(cur) };
  });
  const itinerary = [
    { ...briefingStep, room: BRIEFING, minutes: alloc.briefing },
    ...rooms.map((s) => ({ ...s, room: String(s.room), minutes: alloc.perRoom })),
  ];
  const changed = rooms.some((s) => (Number(s.minutes) || 0) !== alloc.perRoom) || (Number(briefingStep.minutes) || 0) !== alloc.briefing;
  return { programme, itinerary, alloc, changed };
}

/** 訪後信寄送清單：名單上每一個人 ＋ 現場自己留信箱的人（去重、去空）。 */
export function recipientList(visit, responses = []) {
  const seen = new Set();
  const out = [];
  const push = (name, email, from) => {
    const e = String(email || "").trim().toLowerCase();
    if (!e || !e.includes("@") || seen.has(e)) return;
    seen.add(e);
    out.push({ name: name || "", email: e, from });
  };
  for (const g of visit?.guests || []) push(g.name, g.email, "list");
  for (const r of responses) if (r.visit_id === visit?.visit_id && !r.anonymous) push(r.name, r.email, r.source || "onsite");
  return out;
}

/** 把一筆回覆整理成可落庫的樣子。不具名時姓名／email 一律清空，時間只留日期。 */
export function sanitizeResponse(input, now = new Date()) {
  const anonymous = input.anonymous === true || input.anonymous === "true" || input.anonymous === 1;
  const row = {
    visit_id: String(input.visit_id || ""),
    source: String(input.source || "letter"),
    anonymous,
    name: anonymous ? "" : String(input.name || "").trim().slice(0, 200),
    email: anonymous ? "" : String(input.email || "").trim().toLowerCase().slice(0, 200),
    most_wanted_rooms: normRooms(input.most_wanted_rooms),
    cooperate_rooms: normRooms(input.cooperate_rooms),
    next_actions: Array.isArray(input.next_actions) ? input.next_actions.map(String).slice(0, 10) : [],
    next_other: String(input.next_other || "").trim().slice(0, 2000),
    signbook_text: String(input.signbook_text || "").trim().slice(0, 4000),
    suggestion: String(input.suggestion || "").trim().slice(0, 4000),
    note: String(input.note || "").trim().slice(0, 2000),
    submitted_at: anonymous ? now.toISOString().slice(0, 10) : now.toISOString(),
  };
  return row;
}

function normRooms(x) {
  const arr = Array.isArray(x) ? x : typeof x === "string" && x ? x.split(/[,\s]+/) : [];
  return [...new Set(arr.map(String).filter((r) => ROOMS.includes(r)))];
}

export function toCSV(rows, columns) {
  if (!rows.length) return "";
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

/**
 * 選頁以「區塊」為單位（後台只勾區塊、不勾單頁）：某一區只要有一頁被挑到，整個區塊就算選上；
 * 必選頁（always）永遠在。這樣主辦端要決定的是「這一場要不要講 302 規劃室」，
 * 而不是二十幾個核取方塊；母簡報改版時比對的也是區塊，不是頁碼。
 */
export function snapSlidesToGroups(slides, slidesIndex) {
  const all = slidesIndex?.slides || [];
  const groups = slidesIndex?.groups || [];
  if (!groups.length) return [...new Set((slides || []).map(Number))].sort((a, b) => a - b);
  const want = new Set((slides || []).map(Number));
  const out = new Set(all.filter((s) => s.always).map((s) => s.n));
  for (const g of groups) if (g.required || g.slides.some((n) => want.has(n))) for (const n of g.slides) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/** 開始時間（台北）。 */
export function visitStartAt(visit) {
  return new Date(`${visit?.date}T${visit?.start_time || "10:00"}:00+08:00`);
}

/**
 * 結束時間（台北）：今日流程最後一個區塊的結束時間、與「開始 ＋ 總分鐘」，**取晚的那一個**。
 * 「依議程結束時間提醒」就是靠這一個。取晚的是刻意的：流程表被刪掉幾列（只剩前面兩段）也不會
 * 算出比實際早的時間——提醒早到會在來賓還在的時候響，晚幾分鐘無所謂。
 */
export function visitEndAt(visit) {
  const start = visitStartAt(visit);
  const byDuration = new Date(start.getTime() + (Number(visit?.duration_minutes) || 90) * 60000);
  const ends = (visit?.programme || []).map((b) => String(b?.end || "")).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).sort();
  const last = ends[ends.length - 1];
  if (!last) return byDuration;
  const byProgramme = new Date(`${visit.date}T${last.padStart(5, "0")}:00+08:00`);
  return byProgramme > byDuration ? byProgramme : byDuration;
}

/** 收工那四件事各自做了沒（提醒信與進度線講的是同一份清單）。 */
export function wrapupTodo(visit) {
  const m = visit?.materials || {};
  const cards = (visit?.cards || []).length;
  return [
    { key: "signbook", label: "拍一張簽名簿（AI 把手寫字讀成留言）", done: !!visit?.signbook?.photo_key, detail: "" },
    { key: "cards", label: "拍名片（現場拿到的名片變成名單上的人）", done: cards > 0, detail: cards ? `已經讀了 ${cards} 張` : "" },
    { key: "dictation", label: "三十秒口述（誰來、最想看哪一間、問了什麼）", done: !!visit?.dictation?.transcript, detail: "" },
    { key: "materials", label: "當天資料放上專頁（PDF、合照、連結）", done: !!(m.deck_pdf || (m.photos || []).length || (m.links || []).length), detail: "" },
  ];
}

/**
 * 這一場該不該（重新）產一頁摘要。摘要是 Drive 備份與跨場次彙整的來源，但沒有人會記得回來按，
 * 所以每晚掃一次自己產：**參訪過完了、有東西可寫、而且比最新的回覆舊**才做。
 */
export function needsSummary(visit, responses = [], now = new Date()) {
  if (!visit?.date) return false;
  if (visitEndAt(visit) > now) return false; // 還沒結束
  const mine = responses.filter((r) => r.visit_id === visit.visit_id);
  const material = mine.length > 0 || !!visit.dictation?.transcript || !!(visit.signbook?.entries || []).length;
  if (!material) return false; // 沒有回饋就沒什麼可寫，等有了再說
  if (!visit.summary || !visit.summary_at) return true;
  const at = Date.parse(visit.summary_at) || 0;
  // 回覆的時間戳：不具名那一筆只有日期（真匿名的代價），當天最後一刻算
  const newest = Math.max(0, ...mine.map((r) => Date.parse(/T/.test(String(r.submitted_at)) ? r.submitted_at : `${r.submitted_at}T23:59:59+08:00`) || 0));
  return newest > at;
}

/** 產生 ICS（收工提醒）：預定結束時間鬧鈴，附收工頁連結。 */
export function wrapupICS(visit, siteUrl) {
  const start = visitStartAt(visit);
  const end = visitEndAt(visit);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const url = `${siteUrl.replace(/\/$/, "")}/admin.html#wrapup=${visit.visit_id}`;
  const title = `GHRC 參訪收工：${visit.org?.name || visit.visit_id}`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GHRC Visit//EN",
    "BEGIN:VEVENT",
    `UID:${visit.visit_id}@visit.healsdesign.org`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:來賓離開後：1) 拍一張簽名簿 2) 講三十秒口述。\\n${url}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${title}（拍簽名簿、三十秒口述）`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
