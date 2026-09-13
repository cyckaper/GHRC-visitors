import { env, nowISO, siteUrl } from "./http.mts";
import { getStore } from "./store.mts";
import { toCSV } from "../../lib/visit.mjs";
import type { ResponseRow, Visit } from "./types.mts";

/**
 * 長期檔案另存 Google Drive（CLAUDE.md 功能 4）。這裡是共用核心，三個地方用：
 *   functions/drive.mts                  後台手動備份（一次一個檔，顯示進度）
 *   functions/drive-sync-background.mts  自動備份（背景函式，15 分鐘上限，一次搬完一場）
 *   functions/drive-cron.mts             每晚掃一次，補上漏掉的
 *
 * 授權沿用寄信那組 Google OAuth（GOOGLE_* 優先，沒有就用 GMAIL_*），refresh token 需含 drive.file；
 * 檔案 owner 是中心自己的 Google 帳號，不是服務帳戶（服務帳戶沒有 Drive 配額）。
 */
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_FOLDER = "GHRC 參訪";

export interface DriveItem {
  key: string;
  name: string;
}

export function driveConfig() {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = (globalThis as any).Netlify?.env?.get?.(n) ?? process.env[n];
      if (v) return String(v);
    }
    return undefined;
  };
  return {
    clientId: pick("GOOGLE_CLIENT_ID", "GMAIL_CLIENT_ID"),
    clientSecret: pick("GOOGLE_CLIENT_SECRET", "GMAIL_CLIENT_SECRET"),
    refreshToken: pick("GOOGLE_REFRESH_TOKEN", "GMAIL_REFRESH_TOKEN"),
    // 通常留空：drive.file 只看得到程式自己建立的檔案，指定別人建的資料夾會存取不到
    parent: pick("GOOGLE_DRIVE_FOLDER_ID") || "root",
  };
}

export function driveConfigured(): boolean {
  const c = driveConfig();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

export const DRIVE_HINT =
  "尚未設定 Google Drive：Netlify 環境變數 GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET／GOOGLE_REFRESH_TOKEN（可沿用寄信那組，需含 drive.file 權限）。GOOGLE_DRIVE_FOLDER_ID 通常留空。";

let token: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const c = driveConfig();
  if (!driveConfigured()) throw new Error(DRIVE_HINT);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId!, client_secret: c.clientSecret!, refresh_token: c.refreshToken!, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(`Google 授權失敗 ${r.status}：${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://www.googleapis.com/drive/v3${path}`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Drive ${r.status}：${(await r.text()).slice(0, 200)}`);
  return r.json();
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

/** 上傳（同名就覆蓋內容，網址不變）。 */
export async function uploadItem(folder: string, name: string, mime: string, bytes: Uint8Array): Promise<{ id: string; webViewLink?: string }> {
  const existing = await findFile(name, folder);
  const boundary = `ghrc${Math.random().toString(36).slice(2)}`;
  const meta = existing ? { name } : { name, parents: [folder] };
  const head = new TextEncoder().encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`;
  const r = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: body as BodyInit,
  });
  if (!r.ok) throw new Error(`Drive 上傳 ${name} 失敗 ${r.status}：${(await r.text()).slice(0, 200)}`);
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
  // 重讀一次，避免蓋掉上傳期間別處寫進去的變更
  const fresh = (await store.getVisit(visitId)) || visit;
  (fresh as any).drive = { folder_id: folder, url: folderUrl(folder), backed_up_at: nowISO(), items: uploaded.length, ...(failed.length ? { failed } : {}) };
  await store.putVisit(fresh);
  return { skipped: false, uploaded, failed, folder_id: folder, url: folderUrl(folder) };
}

/**
 * 觸發背景備份：資料寫進去的地方呼叫這個，不等它做完（背景函式立刻回 202）。
 * 沒設定 Drive 就什麼都不做，所以本機與測試不受影響。
 */
export async function triggerDriveSync(visitId: string): Promise<void> {
  if (!visitId || !driveConfigured()) return;
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
