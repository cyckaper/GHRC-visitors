import { env, nowISO, siteUrl } from "./http.mts";
import { getStore } from "./store.mts";

/**
 * Google 的授權（Drive 備份、參訪名單的 Google 試算表、Gmail 寄信共用）。
 *
 * refresh token 有兩個來源：**先用後台「設定 → 重新連上 Google」存下來的那一份**（Blobs 的 `secrets/google.json`），
 * 沒有才用 Netlify 環境變數（Drive：GOOGLE_REFRESH_TOKEN，沒有就 GMAIL_REFRESH_TOKEN；Gmail：GMAIL_REFRESH_TOKEN）。
 * 實際踩過：環境變數那一份過期了（Google 回 invalid_grant）——Drive 備份從九月中就默默停了兩週，
 * 匯入名單時才看到一行英文錯誤。以前要重新授權得去 OAuth Playground 拿一組、再貼進 Netlify 的環境變數、重新部署；
 * 現在後台按一下，用中心的 Google 帳號允許就好（`functions/google-auth.mts`）。
 * 過期的時候講人話（`EXPIRED`），不要丟一串 JSON。
 *
 * 存下來的那一份**不經過 `/api/media`**（那一支只開放幾個固定的資料夾），設定分頁也只回「連上了沒、哪個帳號、能不能用」。
 */
const KEY = "secrets/google.json";
export const SCOPES = {
  drive: "https://www.googleapis.com/auth/drive.file",
  gmail: "https://www.googleapis.com/auth/gmail.send",
} as const;
type Purpose = keyof typeof SCOPES;

export const EXPIRED = "Google 的授權過期了（或被收回）：到後台「設定」分頁按「重新連上 Google」，用中心那個 Google 帳號再允許一次";

export class GoogleAuthExpired extends Error {}

export interface StoredGoogle {
  refresh_token: string;
  client_id: string;
  scope: string;
  email?: string;
  at: string;
}

/** 用哪一個 OAuth 用戶端（GOOGLE_* 優先，沒有就用寄信那一組）；`from` 是它在 Netlify 的哪一個環境變數。 */
export function googleClient(): { id?: string; secret?: string; from: "GOOGLE_CLIENT_ID" | "GMAIL_CLIENT_ID" } {
  if (env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET")) return { id: env("GOOGLE_CLIENT_ID"), secret: env("GOOGLE_CLIENT_SECRET"), from: "GOOGLE_CLIENT_ID" };
  return { id: env("GMAIL_CLIENT_ID"), secret: env("GMAIL_CLIENT_SECRET"), from: "GMAIL_CLIENT_ID" };
}

/** Google 允許之後導回來的那一個網址：OAuth 用戶端的「已授權的重新導向 URI」要有**一字不差**的這一條。 */
export function googleRedirectUri(req?: Request): string {
  return `${siteUrl(req)}/api/google-auth`;
}

/**
 * 用戶端 ID 的開頭（設定分頁給人跟 Google Cloud 主控台的用戶端清單對）。開頭那一串數字是專案編號，
 * 後面幾個字分得出同一個專案裡的不同用戶端。用戶端 ID 本來就不是密鑰（每一次導到 Google 的網址上都帶著它），
 * 還是只給開頭：對得出是哪一個就夠了。密鑰與 token 一律不回。
 */
export function clientHint(id?: string): string {
  const s = String(id || "");
  return s.length > 20 ? `${s.slice(0, 20)}…` : s;
}

/** refresh token 是發給哪一個用戶端的，就要用那一個用戶端的密鑰去換。 */
function secretFor(clientId: string): string | undefined {
  if (clientId && clientId === env("GOOGLE_CLIENT_ID")) return env("GOOGLE_CLIENT_SECRET");
  if (clientId && clientId === env("GMAIL_CLIENT_ID")) return env("GMAIL_CLIENT_SECRET");
  return undefined;
}

export async function storedGoogle(): Promise<StoredGoogle | null> {
  const m = await getStore().getMedia(KEY);
  if (!m) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(m.bytes)) as StoredGoogle;
    return s?.refresh_token && s?.client_id ? s : null;
  } catch {
    return null;
  }
}

export async function saveGoogle(s: Omit<StoredGoogle, "at">): Promise<void> {
  await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify({ ...s, at: nowISO() })), "application/json");
  cache.clear();
}

interface Creds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  source: "stored" | "env";
}

/** 這個用途要用哪一組：後台連上的那一份（範圍有涵蓋到才算）優先，沒有才用環境變數。 */
async function credentialsFor(purpose: Purpose): Promise<Creds | null> {
  const s = await storedGoogle();
  if (s && s.scope.split(/\s+/).includes(SCOPES[purpose])) {
    const secret = secretFor(s.client_id);
    if (secret) return { clientId: s.client_id, clientSecret: secret, refreshToken: s.refresh_token, source: "stored" };
  }
  const id = purpose === "gmail" ? env("GMAIL_CLIENT_ID") : env("GOOGLE_CLIENT_ID") || env("GMAIL_CLIENT_ID");
  const secret = purpose === "gmail" ? env("GMAIL_CLIENT_SECRET") : env("GOOGLE_CLIENT_SECRET") || env("GMAIL_CLIENT_SECRET");
  const token = purpose === "gmail" ? env("GMAIL_REFRESH_TOKEN") : env("GOOGLE_REFRESH_TOKEN") || env("GMAIL_REFRESH_TOKEN");
  return id && secret && token ? { clientId: id, clientSecret: secret, refreshToken: token, source: "env" } : null;
}

/**
 * 寄信的是哪一個帳號：用後台連上的那一份就是那個帳號（連上時 Google 給的 email），用環境變數那一份就看 `GMAIL_SENDER`。
 * 信的寄件人（From）與後續提醒的預設收件者都用它。以前沒設 `GMAIL_SENDER` 時寄件人寫成 `From: me`——
 * 那不是一個信箱，Gmail 會擋（Invalid From header）；後台連上之後 Gmail 那一格是「已設定」，按寄出卻寄不出去。
 */
export async function gmailAccount(): Promise<string> {
  const c = await credentialsFor("gmail");
  if (c?.source === "stored") return ((await storedGoogle())?.email || env("GMAIL_SENDER") || "").trim();
  return (env("GMAIL_SENDER") || "").trim();
}

/**
 * 這個用途有沒有一組授權可以用（後台連上的那一份，或環境變數）。**不打網路**：
 * 過期了沒有，要真的換一次才知道（`googleStatus`）。以前只看環境變數——只在後台連上、環境變數裡沒有
 * refresh token 的站台，Drive 備份、寄信全都會當成「沒設定」略過。
 */
export async function googleReady(purpose: Purpose): Promise<boolean> {
  return !!(await credentialsFor(purpose));
}

/**
 * Google 回「這個專案沒有啟用這支 API」時講人話。授權是哪一個 OAuth 用戶端給的，就要在那一個專案裡啟用——
 * 以前 Drive 與 Gmail 可能是兩個專案各用各的，在後台連上之後兩件事都走同一個用戶端，少啟用一支就會遇到。
 */
export function apiDisabled(status: number, text: string, api: "Gmail" | "Google Drive"): string | null {
  return status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(text)
    ? `這個 Google 專案還沒啟用 ${api} API：到 Google Cloud 主控台的「API 和服務 → 程式庫」找 ${api} API 按「啟用」，過幾分鐘再試一次`
    : null;
}

const cache = new Map<string, { value: string; exp: number }>();

/** 換一個 access token（快取到快過期為止）。過期、被收回的 refresh token 丟 `GoogleAuthExpired`，訊息是給人看的。 */
export async function googleAccessToken(purpose: Purpose, hint = "Google 還沒連上：到後台「設定」分頁按「連上 Google」"): Promise<string> {
  const c = await credentialsFor(purpose);
  if (!c) throw new Error(hint);
  const k = `${c.clientId}|${c.refreshToken}`;
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now() + 60000) return hit.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  if (!r.ok) {
    const text = await r.text();
    if (/invalid_grant/.test(text)) throw new GoogleAuthExpired(EXPIRED);
    throw new Error(`Google 授權失敗 ${r.status}：${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cache.set(k, { value: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

/**
 * 設定分頁用：Google 連上了沒、連的是哪個帳號、**現在能不能用**（真的去換一次 access token）。
 * 以前只看環境變數在不在，過期了也寫「已設定」——備份停了兩週沒人知道。不回任何金鑰內容。
 *
 * 另外回「按『連上 Google』會用哪一個用戶端、導回哪一個網址」（`client_hint`／`client_from`／`redirect_uri`）：
 * Google 說 `redirect_uri_mismatch` 時，就是這個用戶端沒有登記這個網址。實際踩過：主控台裡不只一個用戶端，
 * 網址加在另一個上面，再按幾次都一樣——畫面上又看不出網站用的是哪一個。
 */
export async function googleStatus(req?: Request): Promise<{ client: boolean; client_hint?: string; client_from?: string; redirect_uri: string; connected: boolean; ok: boolean; expired?: boolean; email?: string; via?: "stored" | "env"; gmail?: boolean; error?: string }> {
  const app = googleClient();
  const client = !!(app.id && app.secret);
  const base = { client, ...(client ? { client_hint: clientHint(app.id), client_from: app.from } : {}), redirect_uri: googleRedirectUri(req) };
  const s = await storedGoogle();
  const c = await credentialsFor("drive");
  const gmail = !!(await credentialsFor("gmail"));
  if (!c) return { ...base, connected: false, ok: false, gmail };
  try {
    await googleAccessToken("drive");
    return { ...base, connected: true, ok: true, email: c.source === "stored" ? s?.email || "" : "", via: c.source, gmail };
  } catch (e: any) {
    return { ...base, connected: true, ok: false, expired: e instanceof GoogleAuthExpired, email: c.source === "stored" ? s?.email || "" : "", via: c.source, gmail, error: String(e?.message || e).slice(0, 200) };
  }
}
