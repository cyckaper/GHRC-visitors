import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { toCSV } from "../../lib/visit.mjs";
import type { Visit } from "../lib/types.mts";

/**
 * 長期檔案另存一份到 Google Drive（CLAUDE.md 功能 4）。每場參訪一個資料夾：
 *   <GOOGLE_DRIVE_FOLDER_ID>/<visit_id> — 參訪.json、回覆.csv、動線.csv、一頁摘要.md、
 *                                          簽名簿照片、口述音檔、簡報 PDF、現場合照
 *
 * 一次請求只搬一個檔（Netlify function 10 秒上限），後台照清單逐一呼叫並顯示進度。
 *   GET  /api/drive?id=<visit_id>        → { ready, configured, items:[{key,name,bytes}], drive }
 *   POST /api/drive {visit_id, key}      → 上傳這一項，回 { file, drive }
 *   POST /api/drive {visit_id, done:true}→ 記下備份時間（寫進 visit.drive）
 *
 * 授權沿用寄信那組 Google OAuth（GOOGLE_* 優先，沒有就用 GMAIL_*），refresh token 需含
 * drive.file 權限；檔案owner 是中心自己的 Google 帳號，不是服務帳戶（服務帳戶沒有 Drive 配額）。
 */
const FOLDER_MIME = "application/vnd.google-apps.folder";

function env2(...names: string[]): string | undefined {
  for (const n of names) {
    const v = (globalThis as any).Netlify?.env?.get?.(n) ?? process.env[n];
    if (v) return String(v);
  }
  return undefined;
}

function config() {
  return {
    clientId: env2("GOOGLE_CLIENT_ID", "GMAIL_CLIENT_ID"),
    clientSecret: env2("GOOGLE_CLIENT_SECRET", "GMAIL_CLIENT_SECRET"),
    refreshToken: env2("GOOGLE_REFRESH_TOKEN", "GMAIL_REFRESH_TOKEN"),
    parent: env2("GOOGLE_DRIVE_FOLDER_ID") || "root",
  };
}

let token: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const c = config();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new Error("Google Drive 尚未設定（GOOGLE_CLIENT_ID／SECRET／REFRESH_TOKEN 或沿用 GMAIL_*）");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
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

/** 找同名檔／資料夾，沒有就建立（資料夾）。 */
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

/** 上傳（同名就覆蓋內容，網址不變）。 */
async function upload(name: string, mime: string, bytes: Uint8Array, folder: string): Promise<{ id: string; webViewLink: string }> {
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
  return r.json() as Promise<{ id: string; webViewLink: string }>;
}

const ext = (key: string) => (key.split(".").pop() || "").toLowerCase();
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", webm: "audio/webm", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

/** 這場參訪要備份的項目（key 是我們自己的代號，name 是 Drive 上的檔名）。 */
function plan(visit: Visit): { key: string; name: string }[] {
  const items: { key: string; name: string }[] = [
    { key: "visit.json", name: "參訪資料.json" },
    { key: "responses.csv", name: "回覆.csv" },
    { key: "timeline.csv", name: "動線.csv" },
  ];
  if (visit.summary) items.push({ key: "summary.md", name: "一頁摘要.md" });
  if (visit.signbook?.photo_key) items.push({ key: visit.signbook.photo_key, name: `簽名簿.${ext(visit.signbook.photo_key) || "jpg"}` });
  if (visit.dictation?.audio_key) items.push({ key: visit.dictation.audio_key, name: `主持人口述.${ext(visit.dictation.audio_key) || "webm"}` });
  const m = visit.materials || { deck_pdf: "", photos: [], links: [] };
  if (m.deck_pdf && !/^https?:/i.test(m.deck_pdf)) items.push({ key: m.deck_pdf, name: "當天簡報.pdf" });
  (m.photos || []).filter((p) => !/^https?:/i.test(p)).forEach((p, i) => items.push({ key: p, name: `現場合照-${String(i + 1).padStart(2, "0")}.${ext(p) || "jpg"}` }));
  return items;
}

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const c = config();
  const configured = !!(c.clientId && c.clientSecret && c.refreshToken);
  const store = getStore();

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const visit = id ? await store.getVisit(id) : null;
    if (id && !visit) return fail(404, "找不到這次參訪");
    return json({
      ok: true,
      configured,
      folder_id: c.parent,
      items: visit ? plan(visit) : [],
      drive: visit ? (visit as any).drive || null : null,
      hint: configured ? "" : "尚未設定 Google Drive：Netlify 環境變數 GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET／GOOGLE_REFRESH_TOKEN（可沿用寄信那組，需含 drive.file 權限）與 GOOGLE_DRIVE_FOLDER_ID。",
    });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");
  if (!configured) return fail(503, "Google Drive 尚未設定（GOOGLE_CLIENT_ID／SECRET／REFRESH_TOKEN、GOOGLE_DRIVE_FOLDER_ID）");
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const visit = await store.getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");

  try {
    if (body.done) {
      (visit as any).drive = { ...((visit as any).drive || {}), backed_up_at: nowISO(), items: Number(body.items) || 0 };
      visit.updated_at = nowISO();
      await store.putVisit(visit);
      return json({ ok: true, drive: (visit as any).drive });
    }

    const key = String(body.key || "");
    const item = plan(visit).find((x) => x.key === key);
    if (!item) return fail(400, "這一項不在備份清單裡");
    const root = await ensureFolder(`GHRC 參訪`, c.parent);
    const folder = await ensureFolder(`${visit.date} ${visit.org?.name || visit.visit_id}`.slice(0, 100), root);

    let bytes: Uint8Array;
    let mime = "application/octet-stream";
    if (key === "visit.json") {
      bytes = new TextEncoder().encode(JSON.stringify(visit, null, 2));
      mime = "application/json";
    } else if (key === "responses.csv") {
      bytes = new TextEncoder().encode("﻿" + toCSV(await store.listResponses(visit.visit_id)));
      mime = "text/csv";
    } else if (key === "timeline.csv") {
      bytes = new TextEncoder().encode("﻿" + toCSV(await store.listTimeline(visit.visit_id)));
      mime = "text/csv";
    } else if (key === "summary.md") {
      bytes = new TextEncoder().encode(visit.summary || "");
      mime = "text/markdown";
    } else {
      const m = await store.getMedia(key);
      if (!m) return fail(404, `媒體庫裡找不到 ${key}`);
      bytes = m.bytes;
      mime = m.contentType || MIME[ext(key)] || "application/octet-stream";
    }

    const file = await upload(item.name, mime, bytes, folder);
    const drive = { ...((visit as any).drive || {}), folder_id: folder, url: `https://drive.google.com/drive/folders/${folder}` };
    (visit as any).drive = drive;
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, file: { name: item.name, id: file.id, url: file.webViewLink, bytes: bytes.length }, drive });
  } catch (e: any) {
    return fail(502, `Drive 備份失敗：${e?.message || e}`);
  }
};
