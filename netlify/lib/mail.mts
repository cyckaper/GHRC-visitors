import { env, nowISO } from "./http.mts";
import { getStore } from "./store.mts";

/**
 * 用中心自己的 Gmail 帳號寄信（OAuth refresh token，與 Drive 備份共用那組 Google 授權）。
 * 兩個地方用：訪後信與確認信（letter-background，一封一封寄給來賓），
 * 以及參訪結束的後續提醒（reminder-cron，寄給中心自己）。
 */
let cached: { token: string; exp: number } | null = null;

/** MAIL_MOCK=1：不真的寄，把信寫進媒體庫（測試與本機開發用，跟 AI_MOCK 同一個意思）。 */
const mock = () => !!env("MAIL_MOCK");

export function gmailConfigured(): boolean {
  return mock() || !!(env("GMAIL_CLIENT_ID") && env("GMAIL_CLIENT_SECRET") && env("GMAIL_REFRESH_TOKEN"));
}

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID")!, client_secret: env("GMAIL_CLIENT_SECRET")!, refresh_token: env("GMAIL_REFRESH_TOKEN")!, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(`Gmail token ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

/** 中文主旨要 base64 編碼，不然收件端會看到亂碼。 */
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export async function gmailSend(to: string, subject: string, text: string): Promise<void> {
  if (mock()) {
    await getStore().putMedia("mail/last.json", new TextEncoder().encode(JSON.stringify({ to, subject, text, at: nowISO() })), "application/json");
    return;
  }
  const from = env("GMAIL_SENDER") || "me";
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64"),
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send ${r.status}: ${await r.text()}`);
}
