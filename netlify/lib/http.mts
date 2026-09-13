import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 環境變數：Netlify 執行環境用 Netlify.env，本機開發／測試退回 process.env。 */
export function env(name: string): string | undefined {
  const n = (globalThis as any).Netlify;
  const v = n?.env?.get?.(name);
  if (v !== undefined && v !== null && v !== "") return String(v);
  const p = process.env[name];
  return p === undefined || p === "" ? undefined : p;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function fail(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, { status });
}

export async function readJSON<T = any>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 貼進來的字串是不是 ADMIN_TOKEN（登入用；比對時間固定）。 */
export function checkAdminToken(given: string): boolean {
  const token = env("ADMIN_TOKEN");
  return !!token && !!given && safeEqual(given, token);
}

/**
 * 主辦端登入 session（functions/session.mts）：工作人員貼一次 ADMIN_TOKEN，這台瀏覽器就記住半年。
 * cookie 值是 `v1.<到期毫秒>.<HMAC>`，用 ADMIN_TOKEN 當金鑰簽的，**本身不是 ADMIN_TOKEN**；
 * HttpOnly 讓網頁的 JS 讀不到。改用 cookie 是因為 iPad Safari 會把 localStorage 當追蹤資料清掉
 * （七天沒互動就沒了），伺服器設的 cookie 不受那條規則影響。
 */
const SESSION_COOKIE = "ghrc_admin";
export const SESSION_DAYS = 180;
const signSession = (exp: number, token: string) => createHmac("sha256", token).update(`v1.${exp}`).digest("hex");

export function newSessionValue(days = SESSION_DAYS): string | null {
  const token = env("ADMIN_TOKEN");
  if (!token) return null;
  const exp = Date.now() + days * 86400000;
  return `v1.${exp}.${signSession(exp, token)}`;
}

function validSession(value: string): boolean {
  const token = env("ADMIN_TOKEN");
  if (!token) return false;
  const m = /^v1\.(\d{10,})\.([0-9a-f]{64})$/.exec(value.trim());
  if (!m || Number(m[1]) <= Date.now()) return false;
  return safeEqual(m[2], signSession(Number(m[1]), token));
}

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** Set-Cookie 字串；value 給 null 就是登出。只有 https 才加 Secure（本機 http 開發要送得出去）。 */
export function sessionCookieHeader(req: Request, value: string | null, days = SESSION_DAYS): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value || ""}; Path=/; Max-Age=${value ? days * 86400 : 0}; HttpOnly; SameSite=Strict${secure}`;
}

/** 主辦端保護：Authorization: Bearer <ADMIN_TOKEN>、?token=，或登入過的 session cookie。未設定 ADMIN_TOKEN 時一律拒絕。 */
export function requireAdmin(req: Request): Response | null {
  const token = env("ADMIN_TOKEN");
  if (!token) return fail(503, "ADMIN_TOKEN 尚未設定（Netlify 環境變數）");
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const given = m ? m[1].trim() : new URL(req.url).searchParams.get("token") || "";
  if (given && safeEqual(given, token)) return null;
  const c = cookie(req, SESSION_COOKIE);
  if (c && validSession(c)) return null;
  return fail(401, "未授權");
}

/**
 * 排程函式（`export const config = { schedule }`）的保護。
 * Netlify 的排程器用 POST 送一個 `{next_run}` 進來，那個放行；人要手動跑一次就帶 ADMIN_TOKEN。
 * 其餘一律擋掉——這幾支會花 Claude 的錢、會寄信，不該讓任何人打得動。
 */
export async function requireCron(req: Request): Promise<Response | null> {
  if (req.method === "POST") {
    try {
      const body = (await req.clone().json()) as { next_run?: unknown } | null;
      if (body && body.next_run) return null;
    } catch {
      /* 不是 JSON 就當一般請求看待 */
    }
  }
  const denied = requireAdmin(req);
  // 排程真的被擋下來的話，Netlify 的函式紀錄要看得出原因（不然只會有一行「未授權」）
  if (denied && denied.status === 401) return fail(401, "排程函式只收 Netlify 排程器（POST {next_run}）或帶 ADMIN_TOKEN 的手動觸發");
  return denied;
}

/** 現場訊號保護：x-signal-key 標頭、body.key 或 ?key=。 */
export function checkSignalKey(req: Request, bodyKey?: string): boolean {
  const key = env("SIGNAL_KEY");
  if (!key) return false;
  const given = req.headers.get("x-signal-key") || bodyKey || new URL(req.url).searchParams.get("key") || "";
  return !!given && safeEqual(given, key);
}

export function siteUrl(req?: Request): string {
  const configured = env("SITE_URL") || env("URL");
  if (configured) return configured.replace(/\/$/, "");
  if (req) {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  }
  return "https://visit.healsdesign.org";
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** 台北時間的今天（YYYY-MM-DD）。 */
export function taipeiToday(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function randomId(len = 6): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
