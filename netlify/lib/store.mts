import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createSign } from "node:crypto";
import { env } from "./http.mts";
import type { ResponseRow, SlidePerf, Visit } from "./types.mts";

/**
 * 資料層。三種後端，靠 STORE_BACKEND 切換：
 *   file   本機開發／測試：data/store/*.json
 *   blobs  Netlify Blobs（部署後零設定的預設值）
 *   sheets Google Sheet（工作包第 6 章的正式資料庫；需服務帳戶）
 * 媒體（簽名簿照片、口述音檔）在 Netlify 上一律進 Blobs，本機進 data/store/media。
 */
export interface Store {
  backend: string;
  listVisits(): Promise<Visit[]>;
  getVisit(id: string): Promise<Visit | null>;
  putVisit(v: Visit): Promise<void>;
  deleteVisit(id: string): Promise<void>;
  listResponses(visitId?: string): Promise<ResponseRow[]>;
  appendResponse(r: ResponseRow): Promise<void>;
  listSlidePerformance(visitId?: string): Promise<SlidePerf[]>;
  appendSlidePerformance(rows: SlidePerf[]): Promise<void>;
  putMedia(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getMedia(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  deleteMedia(key: string): Promise<void>;
}

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const onNetlify = !!(globalThis as any).Netlify?.env;
  const backend = (env("STORE_BACKEND") || (onNetlify ? "blobs" : "file")).toLowerCase();
  if (backend === "sheets") cached = sheetsStore(onNetlify ? blobsMedia() : fileMedia());
  else if (backend === "blobs") cached = blobsStore();
  else cached = fileStore();
  return cached;
}

/** 測試用：清掉快取，讓下一次 getStore() 重新依環境變數建立。 */
export function resetStore(): void {
  cached = null;
}

// ───────────────────────── file ─────────────────────────

function storeDir(): string {
  return path.resolve(process.cwd(), env("STORE_DIR") || "data/store");
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}

function fileMedia() {
  return {
    async putMedia(key: string, bytes: Uint8Array, contentType: string) {
      const file = path.join(storeDir(), "media", key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
    },
    async getMedia(key: string) {
      const file = path.join(storeDir(), "media", key);
      try {
        const bytes = new Uint8Array(await readFile(file));
        const meta = await readJsonFile<{ contentType: string }>(`${file}.meta.json`, { contentType: "application/octet-stream" });
        return { bytes, contentType: meta.contentType };
      } catch {
        return null;
      }
    },
    async deleteMedia(key: string) {
      const file = path.join(storeDir(), "media", key);
      await Promise.allSettled([unlink(file), unlink(`${file}.meta.json`)]);
    },
  };
}

function fileStore(): Store {
  const f = (name: string) => path.join(storeDir(), `${name}.json`);
  const media = fileMedia();
  return {
    backend: "file",
    async listVisits() {
      return (await readJsonFile<Visit[]>(f("visits"), [])).sort((a, b) => (a.date < b.date ? 1 : -1));
    },
    async getVisit(id) {
      return (await readJsonFile<Visit[]>(f("visits"), [])).find((v) => v.visit_id === id) || null;
    },
    async putVisit(v) {
      const all = await readJsonFile<Visit[]>(f("visits"), []);
      const i = all.findIndex((x) => x.visit_id === v.visit_id);
      if (i >= 0) all[i] = v;
      else all.push(v);
      await writeJsonFile(f("visits"), all);
    },
    async deleteVisit(id) {
      const all = await readJsonFile<Visit[]>(f("visits"), []);
      await writeJsonFile(f("visits"), all.filter((x) => x.visit_id !== id));
    },
    async listResponses(visitId) {
      const all = await readJsonFile<ResponseRow[]>(f("responses"), []);
      return visitId ? all.filter((r) => r.visit_id === visitId) : all;
    },
    async appendResponse(r) {
      const all = await readJsonFile<ResponseRow[]>(f("responses"), []);
      all.push(r);
      await writeJsonFile(f("responses"), all);
    },
    async listSlidePerformance(visitId) {
      const all = await readJsonFile<SlidePerf[]>(f("slide_performance"), []);
      return visitId ? all.filter((r) => r.visit_id === visitId) : all;
    },
    async appendSlidePerformance(rows) {
      const all = await readJsonFile<SlidePerf[]>(f("slide_performance"), []);
      all.push(...rows);
      await writeJsonFile(f("slide_performance"), all);
    },
    ...media,
  };
}

// ───────────────────────── blobs ─────────────────────────

async function blobStore() {
  const mod = await import("@netlify/blobs");
  const ctx = (globalThis as any).Netlify?.context?.deploy?.context ?? env("CONTEXT") ?? "production";
  // 正式站用全域 store；預覽／分支部署用 deploy store，避免測試資料混進正式資料
  return ctx === "production" ? mod.getStore("ghrc-visit") : mod.getDeployStore("ghrc-visit");
}

function blobsMedia() {
  return {
    async putMedia(key: string, bytes: Uint8Array, contentType: string) {
      const s = await blobStore();
      await s.set(`media/${key}`, new Blob([bytes as BlobPart]), { metadata: { contentType } });
    },
    async getMedia(key: string) {
      const s = await blobStore();
      const r = await s.getWithMetadata(`media/${key}`, { type: "arrayBuffer" });
      if (!r || !r.data) return null;
      return { bytes: new Uint8Array(r.data as ArrayBuffer), contentType: String((r.metadata as any)?.contentType || "application/octet-stream") };
    },
    async deleteMedia(key: string) {
      const s = await blobStore();
      await s.delete(`media/${key}`);
    },
  };
}

function blobsStore(): Store {
  const listJson = async <T,>(prefix: string): Promise<T[]> => {
    const s = await blobStore();
    const { blobs } = await s.list({ prefix });
    const out: T[] = [];
    for (const b of blobs) {
      const v = await s.get(b.key, { type: "json" });
      if (v) out.push(v as T);
    }
    return out;
  };
  const appendJson = async (prefix: string, row: unknown) => {
    const s = await blobStore();
    const key = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await s.setJSON(key, row);
  };
  return {
    backend: "blobs",
    async listVisits() {
      return (await listJson<Visit>("visits/")).sort((a, b) => (a.date < b.date ? 1 : -1));
    },
    async getVisit(id) {
      const s = await blobStore();
      return ((await s.get(`visits/${id}`, { type: "json" })) as Visit | null) || null;
    },
    async putVisit(v) {
      const s = await blobStore();
      await s.setJSON(`visits/${v.visit_id}`, v);
    },
    async deleteVisit(id) {
      const s = await blobStore();
      await s.delete(`visits/${id}`);
    },
    async listResponses(visitId) {
      return listJson<ResponseRow>(visitId ? `responses/${visitId}/` : "responses/");
    },
    async appendResponse(r) {
      await appendJson(`responses/${r.visit_id}/`, r);
    },
    async listSlidePerformance(visitId) {
      return listJson<SlidePerf>(visitId ? `slideperf/${visitId}/` : "slideperf/");
    },
    async appendSlidePerformance(rows) {
      for (const r of rows) await appendJson(`slideperf/${r.visit_id}/`, r);
    },
    ...blobsMedia(),
  };
}

// ───────────────────────── sheets ─────────────────────────

/** 工作表欄位：key → 中文表頭。JSON 欄位存字串。 */
const SHEETS: Record<string, [string, string][]> = {
  visits: [
    ["visit_id", "visit_id"], ["date", "日期"], ["start_time", "開始時間"], ["end_time", "結束時間"], ["duration_minutes", "總分鐘"],
    ["org_name", "單位名稱"], ["org_name_local", "單位（當地語）"], ["org_type", "單位類型"], ["org_country", "國家"],
    ["headcount", "人數"], ["lead_guest", "主要來賓姓名職稱"], ["guests", "隨行名單(JSON)"], ["contact_teacher", "對口老師"],
    ["purpose", "來訪目的"], ["interests", "興趣關鍵字"], ["language", "語言"], ["programme", "議程(JSON)"], ["itinerary", "動線排程(JSON)"],
    ["slides", "選用頁次"], ["page_url", "專頁網址"], ["deck", "簡報檔(JSON)"], ["signbook", "簽名簿(JSON)"], ["dictation", "口述(JSON)"],
    ["letters", "信件(JSON)"], ["summary", "一頁摘要"], ["status", "狀態"], ["created_at", "建立"], ["updated_at", "更新"], ["_json", "完整資料(JSON)"],
  ],
  responses: [
    ["visit_id", "visit_id"], ["source", "來源"], ["anonymous", "不具名"], ["name", "姓名"], ["email", "email"],
    ["most_wanted_rooms", "最想看的研究室"], ["cooperate_rooms", "想合作的研究室"], ["next_actions", "希望我們做什麼"], ["next_other", "自填內容"],
    ["signbook_text", "簽名簿留言"], ["suggestion", "開放建議"], ["note", "備註"], ["submitted_at", "填答時間"],
  ],
  slide_performance: [["visit_id", "visit_id"], ["org_type", "單位類型"], ["slide", "頁次"], ["used", "選用"], ["asked", "被提問"], ["mentioned", "回饋提及"]],
};

let tokenCache: { token: string; exp: number } | null = null;

async function googleToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 未設定");
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`Google token 失敗 ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function sheetsApi(pathname: string, init: RequestInit = {}): Promise<any> {
  const id = env("GOOGLE_SHEET_ID");
  if (!id) throw new Error("GOOGLE_SHEET_ID 未設定");
  const token = await googleToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${await r.text()}`);
  return r.json();
}

let ensured = false;
async function ensureSheets(): Promise<void> {
  if (ensured) return;
  const meta = await sheetsApi("?fields=sheets.properties.title");
  const existing = new Set<string>((meta.sheets || []).map((s: any) => s.properties.title));
  const missing = Object.keys(SHEETS).filter((t) => !existing.has(t));
  if (missing.length) {
    await sheetsApi(":batchUpdate", { method: "POST", body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }) });
    for (const title of missing) {
      await sheetsApi(`/values/${encodeURIComponent(title)}!A1?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: [SHEETS[title].map(([, label]) => label)] }),
      });
    }
  }
  ensured = true;
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function visitToRow(v: Visit): string[] {
  const lead = v.guests?.find((g) => g.role === "lead") || v.guests?.[0];
  const m: Record<string, unknown> = {
    visit_id: v.visit_id, date: v.date, start_time: v.start_time, end_time: v.end_time, duration_minutes: v.duration_minutes,
    org_name: v.org?.name, org_name_local: v.org?.name_local, org_type: v.org?.type, org_country: v.org?.country,
    headcount: v.headcount, lead_guest: lead ? `${lead.name} ${lead.title}`.trim() : "", guests: v.guests, contact_teacher: v.contact_teacher,
    purpose: v.purpose, interests: (v.interests || []).join("、"), language: v.language, programme: v.programme, itinerary: v.itinerary,
    slides: (v.slides || []).join(","), page_url: v.page_url, deck: v.deck, signbook: v.signbook, dictation: v.dictation, letters: v.letters,
    summary: v.summary, status: v.status, created_at: v.created_at, updated_at: v.updated_at, _json: v,
  };
  return SHEETS.visits.map(([k]) => cell(m[k]));
}

function rowsToObjects(table: string, values: string[][]): Record<string, string>[] {
  const keys = SHEETS[table].map(([k]) => k);
  return values.slice(1).filter((r) => r.some((c) => c !== "")).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

async function readTable(table: string): Promise<{ rows: Record<string, string>[]; raw: string[][] }> {
  await ensureSheets();
  const j = await sheetsApi(`/values/${encodeURIComponent(table)}!A:AZ`);
  const raw: string[][] = j.values || [];
  return { rows: rowsToObjects(table, raw), raw };
}

async function appendRows(table: string, rows: string[][]): Promise<void> {
  await ensureSheets();
  await sheetsApi(`/values/${encodeURIComponent(table)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
}

function parseJSON<T>(s: string, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function sheetsStore(media: { putMedia: Store["putMedia"]; getMedia: Store["getMedia"]; deleteMedia: Store["deleteMedia"] }): Store {
  const responseRow = (r: ResponseRow) => SHEETS.responses.map(([k]) => cell((r as any)[k]));
  const perfRow = (p: SlidePerf) => SHEETS.slide_performance.map(([k]) => cell((p as any)[k]));
  const toResponse = (o: Record<string, string>): ResponseRow => ({
    visit_id: o.visit_id, source: o.source, anonymous: o.anonymous === "true", name: o.name, email: o.email,
    most_wanted_rooms: parseJSON(o.most_wanted_rooms, [] as string[]), cooperate_rooms: parseJSON(o.cooperate_rooms, [] as string[]),
    next_actions: parseJSON(o.next_actions, [] as string[]), next_other: o.next_other, signbook_text: o.signbook_text,
    suggestion: o.suggestion, note: o.note, submitted_at: o.submitted_at,
  });
  return {
    backend: "sheets",
    async listVisits() {
      const { rows } = await readTable("visits");
      return rows.map((o) => parseJSON<Visit | null>(o._json, null)).filter((v): v is Visit => !!v).sort((a, b) => (a.date < b.date ? 1 : -1));
    },
    async getVisit(id) {
      const { rows } = await readTable("visits");
      const o = rows.find((r) => r.visit_id === id);
      return o ? parseJSON<Visit | null>(o._json, null) : null;
    },
    async putVisit(v) {
      const { rows } = await readTable("visits");
      const i = rows.findIndex((r) => r.visit_id === v.visit_id);
      const row = visitToRow(v);
      if (i < 0) await appendRows("visits", [row]);
      else
        await sheetsApi(`/values/${encodeURIComponent("visits")}!A${i + 2}?valueInputOption=RAW`, {
          method: "PUT",
          body: JSON.stringify({ values: [row] }),
        });
    },
    async deleteVisit(id) {
      const { rows } = await readTable("visits");
      const i = rows.findIndex((r) => r.visit_id === id);
      if (i < 0) return;
      // 整列清空就等於刪掉：列號不動，其他列的位置才不會跑掉
      await sheetsApi(`/values/${encodeURIComponent("visits")}!A${i + 2}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: [SHEETS.visits.map(() => "")] }),
      });
    },
    async listResponses(visitId) {
      const { rows } = await readTable("responses");
      const all = rows.map(toResponse);
      return visitId ? all.filter((r) => r.visit_id === visitId) : all;
    },
    async appendResponse(r) {
      await appendRows("responses", [responseRow(r)]);
    },
    async listSlidePerformance(visitId) {
      const { rows } = await readTable("slide_performance");
      const all = rows.map((o) => ({ visit_id: o.visit_id, org_type: o.org_type, slide: Number(o.slide), used: o.used === "true", asked: o.asked === "true", mentioned: o.mentioned === "true" }));
      return visitId ? all.filter((r) => r.visit_id === visitId) : all;
    },
    async appendSlidePerformance(rows) {
      if (rows.length) await appendRows("slide_performance", rows.map(perfRow));
    },
    ...media,
  };
}

/** 給 CLI／測試用：列出本機 data/visits/*.json 的 spec 檔。 */
export async function listSpecFiles(dir = "data/visits"): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
