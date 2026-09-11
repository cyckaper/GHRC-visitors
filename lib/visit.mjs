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

/** 產生 ICS（收工提醒）：預定結束時間鬧鈴，附收工頁連結。 */
export function wrapupICS(visit, siteUrl) {
  const start = new Date(`${visit.date}T${visit.start_time || "10:00"}:00+08:00`);
  const end = new Date(start.getTime() + (Number(visit.duration_minutes) || 90) * 60000);
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
