import { SESSION_DAYS, checkAdminToken, env, fail, json, newSessionValue, readJSON, requireAdmin, sessionCookieHeader } from "../lib/http.mts";

/**
 * 主辦端登入：工作人員貼一次 ADMIN_TOKEN，這台瀏覽器就記住 180 天，不必每次再授權。
 *
 * POST   /api/session {token}  登入 → 設 HttpOnly cookie（值是簽章，不是 ADMIN_TOKEN 本身）
 * GET    /api/session          還在登入狀態嗎？順便續期（每次打開後台就往後延 180 天）
 * DELETE /api/session          登出
 *
 * cookie 是 SameSite=Strict＋HttpOnly：別的網站發不出帶著它的請求，網頁的 JS 也讀不到。
 */
export default async (req: Request) => {
  if (req.method === "POST") {
    if (!env("ADMIN_TOKEN")) return fail(503, "ADMIN_TOKEN 尚未設定（Netlify 環境變數）");
    const body = await readJSON<{ token?: string }>(req);
    if (!checkAdminToken(String(body?.token || "").trim())) return fail(401, "登入碼不對");
    return json({ ok: true, days: SESSION_DAYS }, { headers: { "set-cookie": sessionCookieHeader(req, newSessionValue()) } });
  }

  if (req.method === "GET") {
    const denied = requireAdmin(req);
    if (denied) return denied;
    return json({ ok: true, days: SESSION_DAYS }, { headers: { "set-cookie": sessionCookieHeader(req, newSessionValue()) } });
  }

  if (req.method === "DELETE") return json({ ok: true }, { headers: { "set-cookie": sessionCookieHeader(req, null) } });

  return fail(405, "method not allowed");
};
