/**
 * 匯入以前的參訪名單（系統上線之前的紀錄；明確要求：「把所有參訪者加入中心首頁地圖，以及主辦端網頁資料地圖中」）。
 *
 * 一筆＝一個來訪單位在某一天來中心。原表一列通常就是一筆；一列裡有好幾個各自來訪的單位
 * （研討會的幾位講者分別來自不同學校、不同國家）就拆成幾筆，`source_row` 相同——**算同一場**
 * （`imported.group`），資料分頁的「K 場」才會跟原表的場次對得上。
 *
 * 讀表的是 AI（`netlify/lib/ai.mts readVisitList`：英文正式名稱、中文名稱、類型、該不該拆）；
 * 測試（AI_MOCK）與 Claude 還沒接好時照欄名讀（`parseVisitTable`）。兩邊回來的都是同一種「列」：
 *   { source_row, date, code, org: { name, name_local, type, country }, people: [{ name, title }],
 *     people_text, people_en, headcount, companions, purpose, purpose_en }
 *
 * **讀完只給人看，勾好才寫進去**（「抽取結果一律在 admin.html 上顯示給人確認後才寫入」）：
 * `planImport` 檢查、配網址、找出系統裡已經有的（同一天、同一個單位），給後台預覽；
 * 勾好之後 `/api/import` 再用同一個函式對一次最新的資料，`importedVisit` 做成要存的那一筆。
 */
import { instToken, makeVisitId, ORG_TYPES } from "./visit.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** 一格裡用頓號（或指定的符號）分開的幾樣東西；括號裡的不算（「（Konkuk University、Seoul）」是同一個單位）。 */
export function splitList(s, sep = /[、；;]/) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(s ?? "")) {
    if ("（(「【[".includes(ch)) depth++;
    if ("）)」】]".includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 各種寫法的日期 → YYYY-MM-DD；看不出來就是空字串。
 * 收：2024-01-08、2024/1/8、2024.1.8、2024年1月8日、民國年（113/1/8）、Excel 的日期數字（45299，CSV 匯出常見）。
 */
export function normalizeDate(s) {
  const t = String(s ?? "").trim().replace(/\s+/g, "");
  const ok = (y, m, d) => {
    const yy = Number(y), mm = Number(m), dd = Number(d);
    if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return "";
    const iso = `${yy}-${pad(mm)}-${pad(dd)}`;
    return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : ""; // 2/30 這種不算
  };
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(t);
  if (m) return ok(m[1], m[2], m[3]);
  m = /^(?:民國)?(\d{2,3})[/.年](\d{1,2})[/.月](\d{1,2})日?$/.exec(t);
  if (m) return ok(Number(m[1]) + 1911, m[2], m[3]);
  if (/^\d{5}(?:\.\d+)?$/.test(t)) return ok(...new Date(Math.round((Number(t) - 25569) * 86400000)).toISOString().slice(0, 10).split("-"));
  return "";
}

/** 從單位名稱（再參考原表的「類別」）猜類型。AI 讀表時由 AI 判斷；這裡給照欄名讀的那一條路用。 */
export function guessOrgType(name, category = "") {
  const n = String(name || "");
  if (/股份有限公司|有限公司|公司|企業|團隊|\b(?:inc|ltd|corp|co|llc|gmbh)\b\.?|company|corporation/i.test(n)) return "enterprise";
  if (/高中|高級中學|附屬中學|附中|國中|國小|中學|小學|high school|primary school|secondary school/i.test(n)) return "school";
  if (/大學|學院|學系|研究所|研究中心|universit|college|institute of technology/i.test(n)) return "university";
  if (/部|署|局|府|改良場|委員會|辦公室|在臺協會|ministry|government|agency|bureau|council/i.test(n)) return "government";
  if (/協會|學會|基金會|association|foundation|society/i.test(n)) return "ngo";
  const c = String(category || "");
  if (/政府|government/i.test(c)) return "government";
  if (/企業|公司|company|enterprise|industry/i.test(c)) return "enterprise";
  if (/學校|中學|school/i.test(c)) return "school";
  return "other";
}

/** 試算表轉出的文字（每一列一行、tab 分格；`## 工作表名稱` 隔開）或 CSV → 一列一個陣列，工作表之間空一列。 */
function tableRows(text) {
  const t = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = t.split("\n");
  if (lines.some((l) => l.includes("\t"))) return lines.map((l) => (/^## /.test(l) ? [] : l.split("\t")));
  // CSV：引號裡可以有逗號與換行
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** 欄名 → 這一欄是什麼。先比完整的寫法，再比寬鬆的（「來訪單位」要比「單位」先認出來）。 */
const COLUMNS = [
  ["no", /^(?:編號|序號|no\.?|#)$/i],
  ["date", /日期|^date$|時間/i],
  ["org", /來訪單位|單位名稱|^單位$|機構|organi[sz]ation|institution|^org/i],
  ["country", /國家|地區|country/i],
  ["category", /類別|類型|category|^type$/i],
  ["people", /來訪人員|來賓|人員|visitors?|guests?|members?/i],
  ["companions", /同行|陪同|accompan/i],
  ["purpose", /交流重點|成果|目的|重點|purpose|focus|summary|notes?/i],
  ["headcount", /人數|headcount|participants|number of/i],
];
function headerMap(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const h = String(c || "").trim();
    if (!h) return;
    const hit = COLUMNS.find(([key, re]) => map[key] === undefined && re.test(h));
    if (hit) map[hit[0]] = i;
  });
  return map.date !== undefined && map.org !== undefined ? map : null;
}

/** 括號裡的英文名稱拿出來當英文名；中文名稱去掉括號裡的英文與說明。 */
function splitNames(raw) {
  const s = String(raw || "").trim();
  const paren = [...s.matchAll(/[（(]([^（）()]*)[）)]/g)].map((m) => m[1].trim());
  const english = paren.find((p) => /[A-Za-z]{3,}/.test(p) && !/[一-鿿]/.test(p)) || "";
  const local = s.replace(/[（(][^（）()]*[）)]/g, "").replace(/\s+/g, " ").trim();
  const cjk = /[一-鿿]/.test(local);
  return { name: english || local, name_local: cjk ? local : "" };
}

const TITLES = "副校長|校長|國際長|學務長|副院長|院長|主任|副總經理|總經理|場長|秘書|助理教授|副教授|教授|研究員|博士";
/** 「John A. Smith 教授（伊利諾大學）」→ { name, title }；只寫職稱、或「師生」「同仁」的不算一個人。 */
function personOf(part) {
  const s = String(part || "").replace(/[（(][^（）()]*[）)]/g, "").trim();
  const m = new RegExp(`^([A-Za-z][A-Za-z.'\\- ]+?|[一-鿿]{2,4}?)\\s*(${TITLES})$`).exec(s);
  // 「景觀系主任」「農學院院長」「中心主任」：前面那一段是單位，不是名字
  if (!m || /[院系部處心組所科室校團會]/.test(m[1])) return null;
  return { name: m[1].trim(), title: m[2] };
}

/**
 * 照欄名讀（不用 AI）：第一個同時有「日期」與「來訪單位」欄名的那一列當表頭，往下一列一筆，讀到下一張工作表為止。
 * 國家那一格寫了好幾國、單位也有好幾個的那一列拆開（照單位名稱開頭的國名分；來訪人員照括號裡的單位分）。
 */
export function parseVisitTable(text) {
  const rows = tableRows(text);
  const out = [];
  const skipped = [];
  let map = null;
  let n = 0;
  for (const cells of rows) {
    if (!map) {
      map = headerMap(cells);
      continue;
    }
    if (!cells.length || cells.every((c) => !String(c || "").trim())) {
      if (out.length || skipped.length) break; // 表格結束（下一張工作表是統計或說明）
      continue;
    }
    n++;
    const get = (k) => (map[k] === undefined ? "" : String(cells[map[k]] ?? "").trim());
    const source_row = get("no") || String(n);
    const date = normalizeDate(get("date"));
    const orgCell = get("org");
    if (!orgCell) { skipped.push(`第 ${source_row} 列：沒有來訪單位`); continue; }
    const countries = splitList(get("country"), /[、，,;；/]/);
    const orgs = countries.length > 1 ? splitList(orgCell) : [orgCell];
    const peopleParts = splitList(get("people"));
    const stated = /共\s*(\d+)\s*[位人名]/.exec(get("people")) || /^(\d+)$/.exec(get("headcount"));
    for (const part of orgs) {
      const country = countries.find((c) => part.startsWith(c)) || countries.find((c) => part.includes(c)) || countries[0] || "";
      // 拆開的那幾筆：來訪人員照括號裡寫的單位分（「Aino Virtanen 教授（赫爾辛基大學）」）
      const mine = orgs.length > 1 ? peopleParts.filter((p) => { const inParen = /[（(]([^（）()]+)[）)]/.exec(p)?.[1]; return inParen && part.includes(inParen.trim()); }) : peopleParts;
      const people = mine.map(personOf).filter(Boolean);
      const solo = people.length && people.length === mine.length && !/同仁|師生|成員|學員|等/.test(mine.join(""));
      out.push({
        source_row,
        date,
        code: "",
        org: { ...splitNames(part), type: guessOrgType(part, get("category")), country },
        people,
        people_text: orgs.length > 1 ? mine.join("、") : get("people"), // 沒拆開的照原表那一格逐字留著
        headcount: stated ? Number(stated[1]) : solo ? people.length : 0,
        companions: get("companions"),
        purpose: get("purpose"),
      });
    }
  }
  if (!map) skipped.push("找不到表頭：第一列要有「日期」與「來訪單位」");
  return { rows: out, skipped };
}

/** AI 或照欄名讀回來的一列，整理成乾淨的樣子（欄位不齊、型別不對都補成空的）。 */
/**
 * 名單存成 Google 試算表之後的自動同步用：試算表裡每一列資料，帶著它的「身分」——**日期＋來訪單位**那兩格。
 * 列的先後、其他欄改了都不算新的一列（改錯字、補交流重點不會再建一場）；日期或來訪單位不一樣才是新的一列。
 * 單位那一格比的時候大小寫、空白、標點、臺／台都不算。
 * 回傳 { header, map, rows: [{ key, cells, n }] }（n＝第幾列資料，從 1 起算）；找不到「日期」與「來訪單位」的表頭就是 null。
 * 跟 `parseVisitTable` 同一套讀法：第一張有表頭的表，讀到空行為止（後面是統計或說明）。
 */
export const rowKey = (date, org) => `${normalizeDate(date) || String(date ?? "").trim()}|${instToken(org)}`;
export function listRows(text) {
  let map = null;
  let header = null;
  const rows = [];
  for (const cells of tableRows(text)) {
    if (!map) {
      map = headerMap(cells);
      if (map) header = cells;
      continue;
    }
    if (!cells.length || cells.every((c) => !String(c || "").trim())) {
      if (rows.length) break;
      continue;
    }
    const get = (k) => (map[k] === undefined ? "" : String(cells[map[k]] ?? "").trim());
    rows.push({ key: rowKey(get("date"), get("org")), cells, n: rows.length + 1 });
  }
  return map ? { header, map, rows } : null;
}

/**
 * 新加的那幾列做成一張小表交給 AI 讀（跟整份名單一樣的格式）。最前面加一欄我們自己的「編號」＝這是第幾列：
 * 讀回來的 source_row 才對得回是哪一列（原表的編號欄可能空著或重複，改叫「原表編號」，讀的時候不看）。
 */
export function rowsText(table, rows) {
  const head = ["編號", ...table.header.map((h, i) => (i === table.map.no ? "原表編號" : String(h ?? "")))];
  const line = (cells) => cells.map((c) => String(c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t");
  return ["## 參訪名單", line(head), ...rows.map((r) => line([String(r.n), ...r.cells]))].join("\n");
}

export function cleanRow(r) {
  const o = r?.org || {};
  const type = ORG_TYPES.includes(o.type) ? o.type : guessOrgType(`${o.name || ""} ${o.name_local || ""}`);
  const code = String(r?.code || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  return {
    source_row: String(r?.source_row ?? "").trim().slice(0, 20),
    date: normalizeDate(r?.date),
    code: code.length >= 2 ? code : "",
    org: { name: String(o.name || "").trim().slice(0, 200), name_local: String(o.name_local || "").trim().slice(0, 200), type, country: String(o.country || "").trim().slice(0, 80) },
    people: (Array.isArray(r?.people) ? r.people : []).map((p) => ({ name: String(p?.name || "").trim().slice(0, 120), title: String(p?.title || "").trim().slice(0, 120) })).filter((p) => p.name).slice(0, 50),
    people_text: String(r?.people_text || "").trim().slice(0, 1000),
    people_en: String(r?.people_en || "").trim().slice(0, 1000),
    headcount: Math.max(0, Math.min(10000, Math.round(Number(r?.headcount) || 0))),
    companions: String(r?.companions || "").trim().slice(0, 1000),
    purpose: String(r?.purpose || "").trim().slice(0, 4000),
    purpose_en: String(r?.purpose_en || "").trim().slice(0, 4000),
  };
}

/**
 * 預覽（與真的匯入之前再對一次）：每一列整理好、配網址代碼（`visit_id`），並標出
 *   problems   不能匯入的原因（沒有日期、沒有單位名稱）
 *   exists     系統裡已經有同一天、同一個單位的那一場（visit_id）——不重複建立
 *   duplicate  這一份名單裡前面已經有同一筆
 *   split      原表同一列拆出來的（算同一場）
 * 網址代碼跟一般的一場同一套（`makeVisitId`）；撞到別的場次就接 -2、-3。
 */
export function planImport(rows, existing = []) {
  const clean = (rows || []).map(cleanRow);
  const taken = new Set(existing.map((v) => v.visit_id));
  // 同一個單位：大小寫、空白、標點、開頭的 The、臺／台都不算（拼法差一點的同一家不要再建一次；跟地圖上的「同一個單位」同一套）
  const have = new Map();
  for (const v of existing) for (const name of [v.org?.name, v.org?.name_local]) if (instToken(name)) have.set(`${v.date}|${instToken(name)}`, v.visit_id);
  const perRow = new Map();
  for (const r of clean) perRow.set(r.source_row, (perRow.get(r.source_row) || 0) + 1);
  const seen = new Set();
  return clean.map((r) => {
    const problems = [];
    if (!r.date) problems.push("沒有日期");
    if (!r.org.name && !r.org.name_local) problems.push("沒有單位名稱");
    const keys = [r.org.name, r.org.name_local].filter((x) => instToken(x)).map((x) => `${r.date}|${instToken(x)}`);
    const exists = problems.length ? "" : keys.map((k) => have.get(k)).find(Boolean) || "";
    const duplicate = !problems.length && keys.some((k) => seen.has(k));
    keys.forEach((k) => seen.add(k));
    let visit_id = "";
    if (!problems.length && !exists && !duplicate) {
      const base = makeVisitId(r.date, r.org.name || r.org.name_local, r.code);
      visit_id = base;
      for (let i = 2; taken.has(visit_id); i++) visit_id = `${base.slice(0, 40)}-${i}`;
      taken.add(visit_id);
    }
    return { ...r, visit_id, exists, duplicate, problems, split: (perRow.get(r.source_row) || 0) > 1 };
  });
}

/** 台灣來的單位：來賓專頁的輔助語言用中文（其他照預設的英文）。 */
const TAIWAN = /^(taiwan|臺灣|台灣|中華民國|republic of china|roc)$/i;

/**
 * 勾好的一列 → 要存的那一筆（再交給 `visits.mts normalizeVisit`）。
 * 原表沒有的就不補：幾點開始不知道（用預設的時間，只為了讓「結束了沒」算得出來）、對口老師留空、
 * 人數只有原表寫了才填（0＝不知道）、動線只有總體介紹（不知道當天去了哪幾間）。
 * `imported` 記著從哪裡來的：哪一個檔、第幾列（同一列拆出來的 group 相同＝同一場）、原表的來訪人員與同行單位。
 */
export function importedVisit(r, { file = "", at = "" } = {}) {
  return {
    visit_id: r.visit_id,
    date: r.date,
    start_time: "10:00",
    org: { ...r.org },
    guests: r.people.map((p, i) => ({ name: p.name, title: p.title, email: "", role: i === 0 ? "lead" : "member" })),
    headcount: r.headcount,
    contact_teacher: "",
    purpose: r.purpose,
    interests: [],
    language: TAIWAN.test(r.org.country.trim()) ? "zh" : "en",
    programme: [],
    itinerary: [],
    status: "done",
    imported: { from: String(file).slice(0, 200), row: r.source_row, group: `${String(file).slice(0, 200)}#${r.source_row}`, at, people: r.people_text, companions: r.companions },
    // 公開的來訪紀錄（/visits）上的說明：原表的「來訪人員」「交流重點／成果」是中心自己簡報上的內容，照放；
    // 英文是讀表時 AI 照譯的（照欄名讀的那一條路沒有英文，英文頁就先放中文）。之後在後台「資料」分頁可以改，也可以整場不公開
    public: { people_zh: r.people_text, people_en: r.people_en || "", note_zh: r.purpose, note_en: r.purpose_en || "", hidden: false },
  };
}
