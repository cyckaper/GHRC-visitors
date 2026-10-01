import { env, nowISO, siteUrl } from "./http.mts";
import { getStore } from "./store.mts";
import { toCSV } from "../../lib/visit.mjs";
import { apiDisabled, googleAccessToken, googleReady } from "./google.mts";
import type { ResponseRow, Visit } from "./types.mts";

/**
 * 長期檔案另存 Google Drive（CLAUDE.md 功能 4）。這裡是共用核心，三個地方用：
 *   functions/drive.mts                  後台手動備份（一次一個檔，顯示進度）
 *   functions/drive-sync-background.mts  自動備份（背景函式，15 分鐘上限，一次搬完一場）
 *   functions/drive-cron.mts             每晚掃一次，補上漏掉的
 *
 * 授權與寄信共用一組（`lib/google.mts`）：後台「設定 → 連上 Google」存下來的那一份優先，
 * 沒有才用環境變數（GOOGLE_* 優先，沒有就用 GMAIL_*），要含 drive.file；
 * 檔案 owner 是中心自己的 Google 帳號，不是服務帳戶（服務帳戶沒有 Drive 配額）。
 */
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_FOLDER = "GHRC 參訪";

export interface DriveItem {
  key: string;
  name: string;
}

export function driveConfig() {
  // 通常留空：drive.file 只看得到程式自己建立的檔案，指定別人建的資料夾會存取不到
  return { parent: env("GOOGLE_DRIVE_FOLDER_ID") || "root" };
}

/** 有沒有一組 Drive 的授權可以用：後台「連上 Google」存下來的那一份，或環境變數（`lib/google.mts`）。 */
export const driveReady = () => googleReady("drive");

export const DRIVE_HINT =
  "Google Drive 還沒連上：到後台「設定」分頁按「連上 Google」，用中心的 Google 帳號允許一次（Netlify 環境變數要有 GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET，或寄信那一組）。";

/** 換 access token：後台「重新連上 Google」存下來的那一份優先，沒有才用環境變數（`lib/google.mts`）。 */
const accessToken = () => googleAccessToken("drive", DRIVE_HINT);

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://www.googleapis.com/drive/v3${path}`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(await driveError(r, "Drive"));
  return r.json();
}

/** Drive 回錯誤時的那一行：沒啟用 Drive API 就講人話，其他照舊帶狀態碼與前 200 字。 */
async function driveError(r: Response, what: string): Promise<string> {
  const text = await r.text();
  return apiDisabled(r.status, text, "Google Drive") || `${what} ${r.status}：${text.slice(0, 200)}`;
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findFile(name: string, parent: string, folder = false): Promise<{ id: string } | null> {
  const query = `name='${q(name)}' and '${q(parent)}' in parents and trashed=false${folder ? ` and mimeType='${FOLDER_MIME}'` : ""}`;
  const j = await api(`/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return j.files?.[0] || null;
}

async function ensureFolder(name: string, parent: string): Promise<string> {
  const found = await findFile(name, parent, true);
  if (found) return found.id;
  const made = await api("/files?fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
  return made.id;
}

/** 這場參訪在 Drive 上的資料夾（GHRC 參訪／<日期> <單位>），沒有就建。 */
export async function ensureVisitFolder(visit: Visit): Promise<string> {
  const root = await ensureFolder(ROOT_FOLDER, driveConfig().parent);
  return ensureFolder(`${visit.date} ${visit.org?.name || visit.visit_id}`.slice(0, 100), root);
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** Drive 的 multipart 上傳：一段 JSON 的檔案資訊＋一段內容。 */
function multipart(meta: Record<string, unknown>, mime: string, bytes: Uint8Array): { boundary: string; body: Uint8Array } {
  const boundary = `ghrc${Math.random().toString(36).slice(2)}`;
  const head = new TextEncoder().encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { boundary, body };
}

/** 上傳（同名就覆蓋內容，網址不變）。 */
export async function uploadItem(folder: string, name: string, mime: string, bytes: Uint8Array): Promise<{ id: string; webViewLink?: string }> {
  const existing = await findFile(name, folder);
  const { boundary, body } = multipart(existing ? { name } : { name, parents: [folder] }, mime, bytes);
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`;
  const r = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: body as BodyInit,
  });
  if (!r.ok) throw new Error(await driveError(r, `Drive 上傳 ${name} 失敗`));
  return r.json() as Promise<{ id: string; webViewLink?: string }>;
}

const ext = (key: string) => (key.split(".").pop() || "").toLowerCase();
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", webm: "audio/webm", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

/**
 * 媒體庫 key → 原始檔名：拿掉 `materials/<visit_id>/` 與上傳時加的時間戳，
 * 合照在 Drive 上就叫 IMG_0696.jpg 而不是流水號（流水號會在中間刪一張時往前遞補、蓋掉別人的內容）。
 */
export function originalName(key: string): string {
  const base = (key.split("/").pop() || key).replace(/^\d{10,}-/, "");
  return base || key.split("/").pop() || key;
}

/** 這場參訪要備份的項目（key 是我們自己的代號，name 是 Drive 上的檔名）。 */
export function plan(visit: Visit): DriveItem[] {
  const items: DriveItem[] = [
    { key: "visit.json", name: "參訪資料.json" },
    { key: "responses.csv", name: "回覆.csv" },
  ];
  if (visit.summary) items.push({ key: "summary.md", name: "一頁摘要.md" });
  if (visit.signbook?.photo_key) items.push({ key: visit.signbook.photo_key, name: `簽名簿.${ext(visit.signbook.photo_key) || "jpg"}` });
  if (visit.dictation?.audio_key) items.push({ key: visit.dictation.audio_key, name: `主持人口述.${ext(visit.dictation.audio_key) || "webm"}` });
  const m = visit.materials || { deck_pdf: "", photos: [], links: [] };
  if (m.deck_pdf && !/^https?:/i.test(m.deck_pdf)) items.push({ key: m.deck_pdf, name: "當天簡報.pdf" });
  // 同名的合照（兩支手機都叫 IMG_0001.jpg）加序號，不要互相覆蓋
  const used = new Set(items.map((i) => i.name));
  const unique = (name: string) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const tail = dot > 0 ? name.slice(dot) : "";
    let out = name;
    for (let n = 2; used.has(out); n += 1) out = `${stem}-${n}${tail}`;
    used.add(out);
    return out;
  };
  (m.photos || []).filter((p) => !/^https?:/i.test(p)).forEach((p) => items.push({ key: p, name: unique(originalName(p)) }));
  // 名片用名片主人的名字當檔名（同名的加序號）；名字沒讀到就只叫「名片」
  for (const c of (visit as any).cards || []) {
    const who = (c.names || []).filter(Boolean).join("、").slice(0, 60);
    items.push({ key: c.key, name: unique(`名片${who ? `-${who}` : ""}.${ext(c.key) || "jpg"}`) });
  }
  return items;
}

/** 一個項目的內容：JSON／CSV／Markdown 現算，媒體從媒體庫取。 */
export async function itemBytes(visit: Visit, responses: ResponseRow[], key: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const text = (s: string, mime: string) => ({ bytes: new TextEncoder().encode(s), mime });
  if (key === "visit.json") return text(JSON.stringify(visit, null, 2), "application/json");
  if (key === "responses.csv") return text("﻿" + toCSV(responses), "text/csv");
  if (key === "summary.md") return text(visit.summary || "", "text/markdown");
  const m = await getStore().getMedia(key);
  if (!m) return null;
  return { bytes: m.bytes, mime: m.contentType || MIME[ext(key)] || "application/octet-stream" };
}

/** 自上次備份後有沒有新東西（參訪本身或回覆）。 */
export function needsSync(visit: Visit, responses: { submitted_at?: string }[] = []): boolean {
  const last = Date.parse((visit as any).drive?.backed_up_at || "") || 0;
  if (!last) return true;
  const times = [Date.parse(visit.updated_at || "") || 0, ...responses.map((r) => Date.parse(r.submitted_at || "") || 0)];
  return Math.max(0, ...times) > last;
}

/**
 * 把一場參訪整個同步到 Drive。備份時間記在 visit.drive，**不動 updated_at**，
 * 否則下一次的 needsSync 會永遠成立。
 */
export async function syncVisit(visitId: string, { force = false } = {}): Promise<{ skipped: boolean; uploaded: string[]; failed: string[]; folder_id?: string; url?: string }> {
  const store = getStore();
  const visit = await store.getVisit(visitId);
  if (!visit) throw new Error("找不到這次參訪");
  const responses = await store.listResponses(visitId);
  if (!force && !needsSync(visit, responses)) return { skipped: true, uploaded: [], failed: [] };
  const folder = await ensureVisitFolder(visit);
  const uploaded: string[] = [];
  const failed: string[] = [];
  for (const item of plan(visit)) {
    try {
      const payload = await itemBytes(visit, responses, item.key);
      if (!payload) {
        failed.push(`${item.name}（媒體庫找不到 ${item.key}）`);
        continue;
      }
      await uploadItem(folder, item.name, payload.mime, payload.bytes);
      uploaded.push(item.name);
    } catch (e: any) {
      failed.push(`${item.name}：${e?.message || e}`);
    }
  }
  // 只寫 drive 這一格，而且寫進最新的那一份：上傳要好幾秒，這段時間裡別人存的（研究室剛填的接待人員）不能被蓋掉
  const drive = { folder_id: folder, url: folderUrl(folder), backed_up_at: nowISO(), items: uploaded.length, ...(failed.length ? { failed } : {}) };
  await store.updateVisit(visitId, (fresh) => {
    (fresh as any).drive = drive;
  });
  return { skipped: false, uploaded, failed, folder_id: folder, url: folderUrl(folder) };
}

/**
 * 觸發背景備份：資料寫進去的地方呼叫這個，不等它做完（背景函式立刻回 202）。
 * 沒設定 Drive 就什麼都不做，所以本機與測試不受影響。
 */
export async function triggerDriveSync(visitId: string): Promise<void> {
  if (!visitId || !(await driveReady())) return;
  const admin = env("ADMIN_TOKEN");
  if (!admin) return;
  try {
    await fetch(`${siteUrl()}/.netlify/functions/drive-sync-background`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ visit_id: visitId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* 自動備份失敗不影響主流程；每晚的 drive-cron 會補 */
  }
}

/**
 * ── 參訪名單（Google 試算表）──
 * 明確指示：「每一次有增加再自動加入」「地圖應該是自動去 check 這個 Google Drive」。
 * 授權只有 drive.file，**只看得到系統自己建立的檔案**——使用者自己放上 Drive 的那份 xlsx 讀不到。
 * 所以匯入名單時順便把它存成一份**系統自己的 Google 試算表**（「GHRC 參訪」資料夾裡），之後就看這一份：
 * 有人在裡面加一列，系統（`lib/visitlist.mts`）自己讀進來。
 *
 * DRIVE_MOCK=1：不真的打 Google，「Drive 上的試算表」存在媒體庫（測試與本機開發用，跟 MAIL_MOCK 同一個意思）。
 * 只管名單這幾支；備份照舊看 `driveReady()`，不會因為 mock 就去打真的 API。
 */
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const driveMock = () => !!env("DRIVE_MOCK");
export const sheetsReady = async () => driveMock() || (await driveReady());

export interface SheetInfo {
  id: string;
  name: string;
  modifiedTime: string;
  trashed: boolean;
  url: string;
}

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const mockKey = (id: string) => `drive-mock/${id}.json`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function mockRead(id: string): Promise<{ name: string; mime: string; modifiedTime: string; data: string; trashed?: boolean } | null> {
  const m = await getStore().getMedia(mockKey(id));
  if (!m) return null;
  return JSON.parse(new TextDecoder().decode(m.bytes));
}

/** 測試用：模擬有人在試算表裡改了東西（換掉內容、修改時間往後推）。只在 DRIVE_MOCK 時有作用。 */
export async function mockSheetWrite(id: string, bytes: Uint8Array, mime = XLSX_MIME, name?: string): Promise<void> {
  const prev = await mockRead(id);
  const at = new Date(Math.max(Date.now(), Date.parse(prev?.modifiedTime || "") + 1000 || 0)).toISOString();
  const rec = { name: name || prev?.name || "GHRC 參訪名單", mime, modifiedTime: at, data: b64(bytes) };
  await getStore().putMedia(mockKey(id), new TextEncoder().encode(JSON.stringify(rec)), "application/json");
}

/** 把上傳的名單（xlsx／csv）轉成一份 Google 試算表，放在「GHRC 參訪」資料夾。 */
export async function createSheet(name: string, bytes: Uint8Array, mime: string): Promise<SheetInfo> {
  if (driveMock()) {
    const id = `mock${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await mockSheetWrite(id, bytes, mime, name);
    return sheetInfo(id);
  }
  const root = await ensureFolder(ROOT_FOLDER, driveConfig().parent);
  // 檔案資訊寫 Google 試算表、內容給 xlsx／csv：Drive 會轉成可以直接在試算表裡編的那一種
  const { boundary, body } = multipart({ name, mimeType: SHEET_MIME, parents: [root] }, mime, bytes);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: body as BodyInit,
  });
  if (!r.ok) throw new Error(await driveError(r, "名單存不進 Google Drive"));
  const made = (await r.json()) as { id: string };
  return sheetInfo(made.id);
}

/** 名單現在的樣子（修改時間：有沒有人改過就看這個）。 */
export async function sheetInfo(id: string): Promise<SheetInfo> {
  if (driveMock()) {
    const m = await mockRead(id);
    if (!m) throw new Error("找不到這份名單");
    return { id, name: m.name, modifiedTime: m.modifiedTime, trashed: !!m.trashed, url: sheetUrl(id) };
  }
  const j = await api(`/files/${encodeURIComponent(id)}?fields=id,name,modifiedTime,trashed,webViewLink&supportsAllDrives=true`);
  return { id: j.id, name: j.name || "", modifiedTime: j.modifiedTime || "", trashed: !!j.trashed, url: j.webViewLink || sheetUrl(j.id) };
}

/** 名單的內容（Google 試算表匯出成 xlsx；試算表裡有幾張工作表就有幾張）。 */
export async function sheetFile(id: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (driveMock()) {
    const m = await mockRead(id);
    if (!m) throw new Error("找不到這份名單");
    return { bytes: new Uint8Array(Buffer.from(m.data, "base64")), mime: m.mime };
  }
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!r.ok) throw new Error(await driveError(r, "名單讀不出來"));
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: XLSX_MIME };
}
