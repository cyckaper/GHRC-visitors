import { createHash, timingSafeEqual } from "node:crypto";

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

/** 主辦端保護：Authorization: Bearer <ADMIN_TOKEN>。未設定 ADMIN_TOKEN 時一律拒絕。 */
export function requireAdmin(req: Request): Response | null {
  const token = env("ADMIN_TOKEN");
  if (!token) return fail(503, "ADMIN_TOKEN 尚未設定（Netlify 環境變數）");
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const given = m ? m[1].trim() : new URL(req.url).searchParams.get("token") || "";
  if (!given || !safeEqual(given, token)) return fail(401, "未授權");
  return null;
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
