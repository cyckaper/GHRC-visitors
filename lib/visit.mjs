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

/**
 * 讀信抽出來的日期。AI 給的 date，沒有就用第一個候選日期；**都沒有就留空，絕不補「今天」**——
 * 實際踩過：信裡寫「請問您下週 10/5（一）有空嗎？……10/5 週一早上 9:00 到中心」，AI 當成還沒確認、
 * 只放進候選日期，程式把空的日期補成當天（10/3），真正的 10/5 埋在底下的「候選日期」那一行。
 * 回傳的 notes 放進「需要確認的事項」：用了候選的就說一聲，沒有日期就說填上才會存。
 */
export function extractedDate(date, candidates = []) {
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const all = (Array.isArray(candidates) ? candidates : []).map((d) => String(d || "").trim()).filter(Boolean);
  const dated = all.filter(isDate);
  const vague = all.filter((d) => !isDate(d)).map((d) => `候選日期：${d}`); // 「十月初」這種，照列給人看
  const given = String(date || "").trim();
  if (isDate(given)) return { date: given, notes: [...dated.filter((d) => d !== given).map((d) => `另一個候選日期：${d}`), ...vague] };
  if (dated.length) return { date: dated[0], notes: [`日期先填了信裡提的 ${dated[0]}，還要跟對方確認`, ...dated.slice(1).map((d) => `另一個候選日期：${d}`), ...vague] };
  return { date: "", notes: ["信裡沒有寫哪一天：填上日期才會存", ...vague] };
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
      contact: false,
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

/**
 * 訪客地圖上**這個單位在哪裡**（明確指示：「點要能縮小到學校或公司，不要佔了整個國家」）。
 * 位置由 AI 查（`/api/geo`，背景工作），存在 `visit.geo`；`key` 記著查的是哪一個單位——
 * 單位名稱或國家改了，key 就對不上，要重查（不然會把新的單位畫在舊單位的地方）。
 */
const geoNorm = (x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
export function geoKey(visit) {
  const o = visit?.org || {};
  return [geoNorm(o.name), geoNorm(o.name_local), geoNorm(o.country)].join("|");
}
/** 這一場的單位還沒查過位置，或查的是改名之前的那一個。沒有單位名稱的不查。 */
export function needsGeo(visit) {
  return !!geoNorm(visit?.org?.name) && (!visit?.geo || visit.geo.key !== geoKey(visit));
}
const GEO_PRECISION = ["site", "city", "region", "country"];
/**
 * 只留認得的欄位。座標不合理（超出範圍、或 0,0 那個「查不到」的慣用值）就當作沒查到：
 * lat／lon 留空、精度退回 country——地圖上點錯地方比放在國家的位置更糟。
 */
export function sanitizeGeo(g) {
  if (!g || typeof g !== "object") return undefined;
  const lat = Number(g.lat);
  const lon = Number(g.lon);
  const ok = g.lat != null && g.lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  return {
    key: String(g.key || "").slice(0, 400),
    lat: ok ? Math.round(lat * 1e4) / 1e4 : null,
    lon: ok ? Math.round(lon * 1e4) / 1e4 : null,
    place: String(g.place || "").slice(0, 80),
    precision: ok && GEO_PRECISION.includes(g.precision) ? g.precision : "country",
    at: String(g.at || "").slice(0, 40),
  };
}

/**
 * **哪幾場是同一個單位**（地圖上一個點、來訪紀錄上算一個單位）：中文（在地）名稱一樣，或英文名稱去掉空白與標點之後一樣
 * （國家也一樣）。讀信、匯入時英文名稱的拼法常常不一樣——只比英文名稱，同一家公司就被算成兩個單位、地圖上多一顆點
 * （實際發生過：惇陽工程一場寫「Dun Yang Engineering Consultants」、一場寫「Dunyang Engineering Consultants」）。
 * 中文名稱一樣就不看國家（國名的寫法也常常不一樣：Taiwan／臺灣）；只有英文名稱一樣的，國家要一樣才算。
 * 「臺／台」當同一個字、英文開頭的 The 不算。
 * 一路串下去：A、B 中文一樣，B、C 英文一樣，三場就是同一個單位。
 *
 * 回傳 visit_id → 單位代碼（同一個單位的每一場都一樣；沒有名稱的是空字串）。代碼是正規化過的名稱，**不是 visit_id**——
 * 公開頁也用它（visit_id 是來賓專頁的網址，不公開）；所以公開頁**只拿要公開的那幾場來算**，
 * 不然還沒來的那一場會從代碼裡透出它的名稱。
 */
export const instToken = (s) => String(s || "").normalize("NFKC").toLowerCase().trim().replace(/^the\s+/, "").replace(/臺/g, "台").replace(/[^\p{L}\p{N}]+/gu, "");
const CJK_NAME = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const instKeysOf = (v) => {
  const country = instToken(v.org?.country);
  // 中日韓文的名稱夠特定，不看國家；英文（拉丁字母）的要國家也一樣。看的是字，不是欄位：
  // 英文名稱那一格寫的是中文（讀信時常見）也照中文名稱比
  const keys = [v.org?.name_local, v.org?.name].map(instToken).filter(Boolean).map((t) => (CJK_NAME.test(t) ? `l|${t}` : `e|${country}|${t}`));
  return [...new Set(keys)];
};
export function institutionKeys(visits) {
  const list = (visits || []).filter((v) => v && v.visit_id);
  const parent = new Map(list.map((v) => [v.visit_id, v.visit_id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const first = new Map(); // 名稱 → 第一個用這個名稱的那一場
  for (const v of list) {
    for (const k of instKeysOf(v)) {
      if (!first.has(k)) { first.set(k, v.visit_id); continue; }
      const a = find(first.get(k));
      const b = find(v.visit_id);
      if (a !== b) parent.set(b, a);
    }
  }
  // 代碼取這個單位所有名稱裡排最前面的那一個：跟資料的先後順序無關，每次算都一樣
  const label = new Map();
  for (const v of list) {
    const root = find(v.visit_id);
    for (const k of instKeysOf(v)) if (!label.has(root) || k < label.get(root)) label.set(root, k);
  }
  return new Map(list.map((v) => [v.visit_id, label.get(find(v.visit_id)) || ""]));
}

/**
 * 公開頁上的說明（中心首頁的地圖與 `/visits` 來訪紀錄頁；明確要求：「參訪者多，把這些參訪另外作一頁連過去詳細說明」）。
 * **只放主辦端願意公開的字**：匯入的舊紀錄帶原表的「來訪人員」「交流重點／成果」（那是中心自己簡報上的內容，中英兩份）；
 * 系統裡排的一場預設是空的——公開頁只有日期、單位、國家、去了哪幾間，說明要主辦端在後台「資料」分頁寫。
 * `hidden`：這一場整個不公開（地圖上也不畫）。名單、email、來訪目的、背景研判、摘要、回覆一律不在這裡。
 */
export function sanitizePublic(p) {
  if (!p || typeof p !== "object") return undefined;
  const str = (x, n) => String(x ?? "").replace(/\r\n?/g, "\n").trim().slice(0, n);
  const out = { people_zh: str(p.people_zh, 600), people_en: str(p.people_en, 600), note_zh: str(p.note_zh, 3000), note_en: str(p.note_en, 3000), hidden: p.hidden === true };
  return Object.values(out).some(Boolean) ? out : undefined;
}

/**
 * 公開的來訪紀錄（`/api/visit-log`）：**已經來過的**（結束時間已過，跟首頁地圖同一條規矩）、沒有標「不公開」的，
 * 一場一筆、新的在前。匯入的舊紀錄裡原表同一列拆成好幾個單位的（研討會的幾位講者）合成同一場。
 * 每一筆只給公開頁用得到的：日期、各單位（名稱、在地名稱、國家、查到的位置、類型）、公開的說明、去了哪幾間。
 * `id` 是頁面上的錨點（日期＋當天第幾場），**不是** visit_id——visit_id 就是來賓專頁的網址，不公開。
 */
export function visitLogEntries(visits, now = new Date()) {
  const groups = new Map();
  for (const v of visits || []) {
    const name = String(v?.org?.name || "").trim();
    const end = visitEndAt(v).getTime();
    if (!name || !Number.isFinite(end) || end > now.getTime()) continue;
    const key = v.imported?.group || v.visit_id;
    groups.set(key, [...(groups.get(key) || []), v]);
  }
  for (const [key, list] of groups) if (list.some((v) => v.public?.hidden)) groups.delete(key);
  // 同一個單位：只拿這一頁會列出來的那幾場來算（還沒來的、不公開的不能從單位代碼裡透出來）
  const inst = institutionKeys([...groups.values()].flat());
  const entries = [];
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.visit_id).localeCompare(String(b.visit_id)));
    const pub = list.map((v) => sanitizePublic(v.public) || {});
    const join = (field, sep) => [...new Set(pub.map((p) => p[field] || "").filter(Boolean))].join(sep);
    const rooms = [...new Set(list.flatMap((v) => (v.itinerary || []).filter((s) => String(s.room) !== BRIEFING && Number(s.minutes) > 0).map((s) => String(s.room))))].sort();
    entries.push({
      date: list[0].date,
      orgs: list.map((v) => {
        const g = v.geo && !needsGeo(v) ? { lat: v.geo.lat ?? null, lon: v.geo.lon ?? null, place: String(v.geo.place || ""), precision: v.geo.precision || "country" } : null;
        // inst：同一個單位的每一場都一樣（institutionKeys），頁面上地圖的點與「只看這個單位」靠它，不靠英文名稱的拼法
        return { name: String(v.org.name).trim(), local: String(v.org.name_local || "").trim(), country: String(v.org.country || "").trim(), type: v.org.type || "other", geo: g, inst: inst.get(v.visit_id) || "" };
      }),
      people: { zh: join("people_zh", "、"), en: join("people_en", "; ") },
      note: { zh: join("note_zh", "\n"), en: join("note_en", "\n") },
      rooms,
    });
  }
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.orgs[0].name.localeCompare(b.orgs[0].name));
  const perDay = new Map();
  for (const e of [...entries].reverse()) {
    const n = (perDay.get(e.date) || 0) + 1;
    perDay.set(e.date, n);
    e.id = `${e.date}-${n}`;
  }
  return entries;
}

/** 來賓端可見的子集：不含 email、信件、逐字稿、摘要。 */
export function publicVisit(v) {
  if (!v) return null;
  return {
    visit_id: v.visit_id,
    date: v.date,
    start_time: v.start_time,
    duration_minutes: v.duration_minutes,
    end_time: endTimeOf(v),
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
    end_time: minutesToHHMM(10 * 60 + DEFAULT_DURATION_MINUTES),
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
    wrapup: { na: [] },
    summary: "",
    status: "draft",
    created_at: "",
    updated_at: "",
  };
}

/**
 * 這一場的預設今日流程：總體簡報 → 研究室參訪 → 綜合討論（時間照 allocateProgramme 算）。
 * 新建一場時後台就照這個把表填滿——**一張空表看不出要填什麼**，有預設值才有東西可以改。
 * 合照要不要留給人自己加（不是每一場都拍）。
 * @param {{start_time?:string, duration_minutes?:number, itinerary?:Array}} visit
 */
export function defaultProgramme(visit) {
  const v = visit || {};
  const rooms = (Array.isArray(v.itinerary) ? v.itinerary : []).filter((s) => String(s.room) !== BRIEFING && (Number(s.minutes) || 0) > 0).length || ROOMS.length;
  const alloc = allocateProgramme(Number(v.duration_minutes) || DEFAULT_DURATION_MINUTES, rooms);
  let cur = hhmmToMinutes(v.start_time) ?? 10 * 60;
  const blocks = [
    { kind: "briefing", minutes: alloc.briefing, title_en: "Welcome and centre overview", title_2nd: "歡迎與中心總體介紹" },
    { kind: "tour", minutes: rooms * alloc.perRoom, title_en: "Laboratory visits", title_2nd: "研究室參訪" },
    { kind: "discussion", minutes: alloc.discussion, title_en: "General discussion", title_2nd: "綜合討論" },
  ];
  return blocks.map((b) => {
    const start = minutesToHHMM(cur);
    cur += b.minutes;
    return { start, end: minutesToHHMM(cur), kind: b.kind, title_en: b.title_en, title_2nd: b.title_2nd, slides_range: "", rooms: [] };
  });
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

/**
 * 這一場**動線上的研究室**：房號、老師、幾點到幾點、幾分鐘。
 * 行前通告要告訴各研究室的就是這個，一頁摘要與提示詞也用同一份。
 * 起訖時間由今日流程的「研究室參訪」那一段往後推算（動線的分鐘數是唯一的來源）。
 * @param {object} visit
 * @param {{labs?: Array}} labs public/data/labs.json
 * @returns {Array<{room:string, minutes:number, name_zh:string, name_en:string, lead:string, start:string, end:string}>}
 */
export function labStops(visit, labs) {
  const all = (labs && labs.labs) || [];
  const steps = (visit?.itinerary || []).filter((s) => String(s.room) !== BRIEFING && (Number(s.minutes) || 0) > 0);
  const tour = (visit?.programme || []).find((b) => b && b.kind === "tour");
  let cur = hhmmToMinutes(tour?.start);
  if (cur == null) {
    // 沒有流程表就從「開始時間 ＋ 總體介紹」接下去
    const brief = (visit?.itinerary || []).find((s) => String(s.room) === BRIEFING);
    cur = (hhmmToMinutes(visit?.start_time) ?? 10 * 60) + (Number(brief?.minutes) || DEFAULT_BRIEFING_MINUTES);
  }
  return steps.map((s) => {
    const room = String(s.room);
    const minutes = Number(s.minutes) || 0;
    const lab = all.find((l) => String(l.room) === room);
    const start = minutesToHHMM(cur);
    cur += minutes;
    return {
      room,
      minutes,
      name_zh: lab?.name_zh || "",
      name_en: lab?.name_en || "",
      lead: [lab?.lead?.name_zh, lab?.lead?.name_en].filter(Boolean).join(" "),
      start,
      end: minutesToHHMM(cur),
    };
  });
}

/**
 * **研究室在支援人力表上填的「共需幾分鐘」自動排進行程**（明確指示：各研究室填的時間要能自動回填到
 * 訪前的行程與來賓專頁的參訪流程）：那一間在動線上的分鐘數改成研究室填的；動線上還沒有那一間，
 * 就照房號插進去（301、302…的順序，不插在總體介紹前面）。回傳新的一份，不改原本的。
 */
export function withLabMinutes(itinerary, room, minutes) {
  const steps = (Array.isArray(itinerary) ? itinerary : []).map((s) => ({ ...s, room: String(s.room) }));
  const r = String(room);
  const i = steps.findIndex((s) => s.room === r);
  if (i >= 0) steps[i] = { ...steps[i], minutes };
  else {
    const at = steps.findIndex((s) => s.room !== BRIEFING && Number(s.room) > Number(r));
    steps.splice(at < 0 ? steps.length : at, 0, { room: r, minutes, focus: "", location: "" });
  }
  return steps;
}

/**
 * 今日流程**從開始時間往後重推一次**——跟後台行程表的 `retimeProgramme()` 同一套：
 * 「研究室參訪」那一段的長度＝動線上各間分鐘的合計、那一段的 `rooms`＝動線；其他區塊維持原本的長度。
 * 研究室填了分鐘、伺服器自己排進行程時用（後台開著的話，行程表自己會做同一件事）。
 * 這一場還沒有流程就先照預設排一份（`defaultProgramme`），不然來賓專頁上什麼都看不到。
 */
export function retimeProgramme(visit) {
  const route = (visit?.itinerary || []).filter((s) => String(s.room) !== BRIEFING && (Number(s.minutes) || 0) > 0);
  const tour = route.reduce((n, s) => n + (Number(s.minutes) || 0), 0);
  const blocks = Array.isArray(visit?.programme) && visit.programme.length ? visit.programme : defaultProgramme(visit);
  let cur = hhmmToMinutes(visit?.start_time) ?? hhmmToMinutes(blocks[0]?.start) ?? 10 * 60;
  return blocks.map((b) => {
    const had = (hhmmToMinutes(b?.end) ?? NaN) - (hhmmToMinutes(b?.start) ?? NaN);
    const len = b?.kind === "tour" ? tour : had > 0 ? had : b?.kind === "photo" ? DEFAULT_PHOTO_MINUTES : DEFAULT_ROOM_MINUTES;
    const start = minutesToHHMM(cur);
    cur += len;
    return { ...b, start, end: minutesToHHMM(cur), ...(b?.kind === "tour" ? { rooms: route.map((s) => String(s.room)) } : {}) };
  });
}

/**
 * 支援人力表上**這一場列哪幾間**。
 * - 主辦端（或 AI 排行程）已經把研究室排進動線：列動線上那幾間，再加上已經填過東西的（填過的不能看不見）。
 * - 還沒排：**五間都列**，還沒填的才看得出來（明確指示）。研究室自己填分鐘會自動排進動線，
 *   所以「排了沒」不能只看動線——**研究室自己填進來的那幾間（`visit.lab_added`）不算主辦端排的**，
 *   不然第一間一填，其他四間就看不到格子了。反過來，主辦端排了 301、303、兩間也都填了，
 *   仍然是「排好了」：其他三間是免填，不是未填。
 * @returns {{rooms: string[], planned: boolean}}
 */
export function rotaRooms(visit, labs) {
  const all = ((labs && labs.labs) || []).map((l) => String(l.room));
  const answered = (room) => visit?.lab_minutes?.[room] != null || !!visit?.presenters?.[room];
  const route = labStops(visit, labs).map((s) => String(s.room));
  const added = new Set((visit?.lab_added || []).map(String));
  if (!route.some((room) => !added.has(room))) return { rooms: all.length ? all : [...ROOMS], planned: false };
  const extra = (all.length ? all : ROOMS).filter((room) => !route.includes(room) && answered(room));
  return { rooms: [...route, ...extra], planned: true };
}

/**
 * 行前通告的收件人：**這一場會走到的那幾間**的負責老師。
 *
 * 信箱只有 `labs.json` 裡的 `lead.email`（那一份會出現在來賓專頁上，本來就是公開的）。
 * 以前後台「設定」還能另外填一份私下的，**明確指示拿掉了**——通告本來就是貼 LINE 群組。
 * 沒有信箱的那幾間照樣列出來、標 `email: ""`——畫面要說「這幾間沒有信箱」，
 * 而不是安靜地少寄幾個人。
 */
export function labRecipients(visit, labs) {
  const all = (labs && labs.labs) || [];
  return labStops(visit, labs).map((s) => {
    const lab = all.find((l) => String(l.room) === s.room);
    const email = String(lab?.lead?.email || "").trim().toLowerCase();
    return { room: s.room, name: s.lead || s.name_zh || s.room, email, from: "lab", start: s.start, end: s.end, minutes: s.minutes };
  });
}

/**
 * 訪後信寄送清單：名單上每一個人 ＋ 現場自己留信箱的人（去重、去空）。
 *
 * 每一筆多帶一個 `contact`（是不是這一場的**主要聯絡人**）。**協調參訪的人不一定等於參加參訪的人**：
 * 日期還在往返時，通常只跟對方承辦人講，把還沒定案的行程寄給全團只會造成困擾；
 * 所以確認信預設只寄 `contact`，感謝信才寄全部。名單上一個都沒標時 `contact` 全是 false，
 * 由畫面自己退回「全選」——寧可多寄，也不要按下寄出卻一個人都沒寄到。
 */
export function recipientList(visit, responses = []) {
  const seen = new Set();
  const out = [];
  const push = (name, email, from, contact = false) => {
    const e = String(email || "").trim().toLowerCase();
    if (!e || !e.includes("@") || seen.has(e)) return;
    seen.add(e);
    out.push({ name: name || "", email: e, from, contact: !!contact });
  };
  for (const g of visit?.guests || []) push(g.name, g.email, "list", g.contact);
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
 *
 * **回傳的頁序照 `slides.json` 的區塊順序**，不是母簡報的頁碼順序——產檔就照這個順序排
 * （`buildDeck` 以 `spec.slides` 的順序決定輸出頁序）。母簡報的實體頁序跟講述順序本來就不一樣
 * （例如 Lab 304 的 49–53 要排在 Lab 305 的 43–48 前面），要改講述順序就調 `slides.json` 的區塊順序，
 * 不必動母簡報。同一區塊裡面仍照頁碼由小到大。
 */
export function snapSlidesToGroups(slides, slidesIndex) {
  const all = slidesIndex?.slides || [];
  const groups = slidesIndex?.groups || [];
  if (!groups.length) return [...new Set((slides || []).map(Number))].sort((a, b) => a - b);
  const want = new Set((slides || []).map(Number));
  const always = new Set(all.filter((s) => s.always).map((s) => s.n));
  const out = [];
  const seen = new Set();
  const push = (n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  for (const g of groups) {
    if (!g.required && !g.slides.some((n) => want.has(n) || always.has(n))) continue;
    for (const n of [...g.slides].sort((a, b) => a - b)) push(n);
  }
  for (const n of [...always].sort((a, b) => a - b)) push(n); // 沒被任何區塊收的必選頁（理論上不該有）
  return out;
}

/** 開始時間（台北）。 */
export function visitStartAt(visit) {
  return new Date(`${visit?.date}T${visit?.start_time || "10:00"}:00+08:00`);
}

const HHMM = /^\d{1,2}:\d{2}$/;
/** "10:30" → 630；不是時間就回 null。 */
export function hhmmToMinutes(t) {
  const s = String(t == null ? "" : t).trim();
  if (!HHMM.test(s)) return null;
  const [h, m] = s.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
/** 630 → "10:30"。 */
export const minutesToHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/**
 * 開始到結束有幾分鐘。**主辦端填的是幾點開始、幾點結束**（總分鐘不是他在意的東西），
 * 中心不辦跨午夜的參訪，所以結束早於開始一律當填錯，回 null 讓上層沿用原本的長度。
 */
export function minutesBetween(start, end) {
  const a = hhmmToMinutes(start), b = hhmmToMinutes(end);
  if (a == null || b == null || b <= a) return null;
  return b - a;
}
/** 這一場幾點結束：有填就用填的，沒填就用「開始 ＋ 總分鐘」算。 */
export function endTimeOf(visit) {
  const given = hhmmToMinutes(visit?.end_time);
  if (given != null) return minutesToHHMM(given);
  const start = hhmmToMinutes(visit?.start_time) ?? 10 * 60;
  return minutesToHHMM(start + (Number(visit?.duration_minutes) || DEFAULT_DURATION_MINUTES));
}

/**
 * 結束時間（台北）：今日流程最後一個區塊的結束時間、與「開始 ＋ 總分鐘」，**取晚的那一個**。
 * 「依議程結束時間提醒」就是靠這一個。取晚的是刻意的：流程表被刪掉幾列（只剩前面兩段）也不會
 * 算出比實際早的時間——提醒早到會在來賓還在的時候響，晚幾分鐘無所謂。
 */
export function visitEndAt(visit) {
  const start = visitStartAt(visit);
  const mins = minutesBetween(visit?.start_time, visit?.end_time) || Number(visit?.duration_minutes) || 90;
  const byDuration = new Date(start.getTime() + mins * 60000);
  const ends = (visit?.programme || []).map((b) => String(b?.end || "")).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).sort();
  const last = ends[ends.length - 1];
  if (!last) return byDuration;
  const byProgramme = new Date(`${visit.date}T${last.padStart(5, "0")}:00+08:00`);
  return byProgramme > byDuration ? byProgramme : byDuration;
}

/** 後續那四件事各自做了沒（提醒信與進度線講的是同一份清單）。 */
export function wrapupTodo(visit) {
  const m = visit?.materials || {};
  const cards = (visit?.cards || []).length;
  const na = new Set(wrapupNA(visit));
  const items = [
    { key: "signbook", label: "拍一張簽名簿（AI 把手寫字讀成留言）", done: !!visit?.signbook?.photo_key, detail: "" },
    { key: "cards", label: "拍名片（現場拿到的名片變成名單上的人）", done: cards > 0, detail: cards ? `已經讀了 ${cards} 張` : "" },
    { key: "dictation", label: "三十秒口述（誰來、最想看哪一間、問了什麼）", done: !!visit?.dictation?.transcript, detail: "" },
    { key: "materials", label: "當天資料放上專頁（PDF、合照、連結）", done: !!(m.deck_pdf || (m.photos || []).length || (m.links || []).length), detail: "" },
  ];
  return items.map((t) => ({ ...t, na: !t.done && na.has(t.key) }));
}

/**
 * 這一場**本來就不會有**的那幾件（`visit.wrapup.na`）。沒有簽名簿、沒交換名片、沒錄口述，
 * 參訪一樣走完了，感謝信一樣該寄——標了「本次沒有」就不算未完成：進度線顯示「本次沒有」，
 * 後續提醒也不再為它寄信。做到了就以做到的為準（`done` 優先），所以先標了又補上去不會互相打架。
 */
export function wrapupNA(visit) {
  const keys = ["signbook", "cards", "dictation", "materials"];
  const raw = visit?.wrapup?.na;
  return keys.filter((k) => (Array.isArray(raw) ? raw : []).includes(k));
}

/** 後續那四件事是不是都處理完了（做到了，或標明本次沒有）。 */
export const wrapupSettled = (visit) => wrapupTodo(visit).every((t) => t.done || t.na);

/**
 * 行程指紋：**已經交出去的東西會不會過期，只看這幾個欄位有沒有變**。
 * 網頁改了會跟著更新，但已經寄出的確認信與下載的 .pptx 不會——所以產檔與寄信時把指紋存起來，
 * 之後對不上就在畫面上說一句，而不是繼續顯示一個綠勾。
 */
export function scheduleFingerprint(visit) {
  const v = visit || {};
  const blocks = (Array.isArray(v.programme) ? v.programme : []).map((b) => [b?.start, b?.end, b?.kind, b?.title_en, b?.title_2nd, b?.slides_range].join("~"));
  const steps = (Array.isArray(v.itinerary) ? v.itinerary : []).map((s) => `${s?.room}:${Number(s?.minutes) || 0}${s?.location ? `@${s.location}` : ""}`);
  return JSON.stringify([v.date || "", v.start_time || "", endTimeOf(v), blocks, steps]);
}

/** 簡報指紋＝行程 ＋ 選了哪幾頁 ＋ 第二語言 ＋ 封面會寫的單位名稱。 */
export function deckFingerprint(visit) {
  const v = visit || {};
  return JSON.stringify([scheduleFingerprint(v), (Array.isArray(v.slides) ? v.slides : []).join(","), v.language || "", v.org?.name || ""]);
}

/**
 * 已經交出去、但底下的行程又改過的東西。回傳給畫面用：一句話說清楚哪一份是舊的、為什麼。
 * @returns {Array<{key:string, label:string, why:string}>}
 */
export function staleOutputs(visit) {
  const v = visit || {};
  const out = [];
  const deck = v.deck || {};
  if (deck.generated_at && deck.fingerprint && deck.fingerprint !== deckFingerprint(v)) out.push({ key: "deck", label: "簡報", why: "行程或選頁在產檔之後改過，這份 .pptx 是舊的" });
  const conf = v.letters?.confirmation || {};
  if (conf.sent_at && conf.fingerprint && conf.fingerprint !== scheduleFingerprint(v)) out.push({ key: "confirmation", label: "確認信", why: "寄出之後行程又改過，對方手上的時間是舊的" });
  return out;
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

/** 產生 ICS（後續提醒）：預定結束時間鬧鈴，附後續頁連結。 */
export function wrapupICS(visit, siteUrl) {
  const start = visitStartAt(visit);
  const end = visitEndAt(visit);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const url = `${siteUrl.replace(/\/$/, "")}/admin.html#wrapup=${visit.visit_id}`;
  const title = `GHRC 參訪後續：${visit.org?.name || visit.visit_id}`;
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
