import { checkSigned, fail, randomId, requireAdmin, signValue, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { googleClient, googleRedirectUri, saveGoogle, SCOPES } from "../lib/google.mts";

/**
 * 連上（或重新連上）Google——Drive 備份、參訪名單的 Google 試算表、Gmail 寄信共用的那組授權。
 * 以前 refresh token 過期了要去 OAuth Playground 拿一組、貼進 Netlify 的環境變數、再重新部署；
 * 現在後台「設定」分頁按一下，用中心的 Google 帳號允許，就存進站台（`lib/google.mts`，Blobs 的 `secrets/google.json`）。
 *
 * GET /api/google-auth?start=1        admin：導到 Google 的同意畫面
 * GET /api/google-auth?code=&state=   Google 導回來。**這一次不帶登入的 cookie**（SameSite=Strict 的 cookie 從別的網站導回來不會帶），
 *                                     所以靠 state 認人：用 ADMIN_TOKEN 簽過、十分鐘內、一次性（`oauth/<nonce>.json` 用過就刪）
 *
 * 一次性的設定在 Google Cloud 主控台（`docs/DEPLOY.md` 6.5）：OAuth 用戶端的「已授權的重新導向 URI」加上
 * `https://<站台>/api/google-auth`；同意畫面的發布狀態設成「正式版」——測試模式的 refresh token 七天就失效。
 */
const TEN_MINUTES = 10 * 60 * 1000;

export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const url = new URL(req.url);
  const redirectUri = googleRedirectUri(req); // 設定分頁寫給人去登記的也是這一個（同一支函式），不會兩邊對不上
  const back = (result: string) => Response.redirect(`${siteUrl(req)}/admin.html?google=${encodeURIComponent(result)}`, 302);

  if (url.searchParams.get("start")) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const client = googleClient();
    if (!client.id || !client.secret) return fail(409, "Netlify 環境變數裡沒有 Google 的 OAuth 用戶端（GOOGLE_CLIENT_ID／SECRET 或 GMAIL_CLIENT_ID／SECRET）");
    const nonce = randomId(20);
    await getStore().putMedia(`oauth/${nonce}.json`, new TextEncoder().encode(JSON.stringify({ at: Date.now() })), "application/json");
    const state = signValue(`${nonce}.${Date.now() + TEN_MINUTES}`);
    if (!state) return fail(500, "站台沒有 ADMIN_TOKEN");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirectUri,
      response_type: "code",
      // email：設定分頁寫得出連的是哪個帳號；drive.file：備份與名單；gmail.send：從後台寄信
      scope: ["openid", "email", SCOPES.drive, SCOPES.gmail].join(" "),
      access_type: "offline",
      prompt: "consent", // 每次都要給 refresh token（不加的話第二次允許就不給了）
      state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  // Google 導回來
  if (url.searchParams.get("error")) return back(url.searchParams.get("error") === "access_denied" ? "denied" : "error");
  const payload = checkSigned(url.searchParams.get("state") || "");
  const [nonce, exp] = (payload || "").split(".");
  if (!payload || !/^[a-z0-9]{20}$/.test(nonce || "") || !(Number(exp) > Date.now())) return back("expired");
  const store = getStore();
  if (!(await store.getMedia(`oauth/${nonce}.json`))) return back("expired"); // 用過了，或不是從我們這裡出發的
  await store.deleteMedia(`oauth/${nonce}.json`);
  const code = url.searchParams.get("code") || "";
  const client = googleClient();
  if (!code || !client.id || !client.secret) return back("error");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!r.ok) {
    console.warn(`Google 換 token 失敗 ${r.status}：${(await r.text()).slice(0, 200)}`);
    return back("error");
  }
  const j = (await r.json()) as { refresh_token?: string; scope?: string; id_token?: string };
  if (!j.refresh_token) return back("error");
  const scope = String(j.scope || "");
  if (!scope.split(/\s+/).includes(SCOPES.drive)) return back("noscope"); // 同意畫面上把 Drive 那一格取消了
  // 是哪個帳號：id_token 是 Google 剛剛直接給的（不是瀏覽器轉交的），讀出 email 就好
  let email = "";
  try {
    email = String(JSON.parse(Buffer.from(String(j.id_token || "").split(".")[1] || "", "base64url").toString("utf8")).email || "");
  } catch {
    /* 拿不到就不寫 */
  }
  await saveGoogle({ refresh_token: j.refresh_token, client_id: client.id, scope, email });
  return back("ok");
};
