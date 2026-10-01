import { env, nowISO } from "./http.mts";
import { apiDisabled, googleAccessToken, googleReady } from "./google.mts";
import { getStore } from "./store.mts";

/**
 * 用中心自己的 Gmail 帳號寄信（OAuth refresh token，與 Drive 備份共用那組 Google 授權）。
 * 兩個地方用：訪後信與確認信（letter-background，一封一封寄給來賓），
 * 以及參訪結束的後續提醒（reminder-cron，寄給中心自己）。
 */

/** MAIL_MOCK=1：不真的寄，把信寫進媒體庫（測試與本機開發用，跟 AI_MOCK 同一個意思）。 */
const mock = () => !!env("MAIL_MOCK");

/** 有沒有一組可以寄信的授權：後台「連上 Google」存下來的那一份（有允許寄信的話），或 GMAIL_* 環境變數。 */
export async function gmailReady(): Promise<boolean> {
  return mock() || (await googleReady("gmail"));
}

/** 換 access token：後台「重新連上 Google」存下來的那一份（有允許寄信的話）優先，沒有才用 GMAIL_* 環境變數（`lib/google.mts`）。 */
async function accessToken(): Promise<string> {
  return googleAccessToken("gmail", "Gmail 還沒接好：到後台「設定」分頁按「連上 Google」，允許時「寄信」那一格要勾");
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
  if (!r.ok) {
    const body = await r.text();
    throw new Error(apiDisabled(r.status, body, "Gmail") || `Gmail send ${r.status}: ${body}`);
  }
}
