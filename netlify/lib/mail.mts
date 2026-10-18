import { env, nowISO } from "./http.mts";
import { apiDisabled, gmailAccount, googleAccessToken, googleReady } from "./google.mts";
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

/** 信的附件（感謝信附上的合照）。 */
export type MailAttachment = { filename: string; contentType: string; bytes: Uint8Array };

/** base64 每 76 個字換一行（MIME 的規矩；一整行幾 MB 的長行，有些收信端會切壞）。 */
const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) || []).join("\r\n");

/**
 * 附件的檔名參數：英數字的照原樣；中文檔名（「合照.jpg」）另外用 RFC 2231 寫一份（`filename*`），
 * 舊的收信程式看 `filename` 那一個——換成 photo-1.jpg 這種英數字的。
 */
function fileParams(name: string, fallback: string): { type: string; disposition: string } {
  if (/^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name)) return { type: `name="${name}"`, disposition: `filename="${name}"` };
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${fallback}"`, disposition: `filename="${fallback}"; filename*=UTF-8''${encoded}` };
}

/**
 * 組一封信（RFC 2822／MIME）。沒有附件＝跟以前一樣的一段 text/plain；
 * 有附件＝multipart/mixed：內文一段，接著一個附件一段（base64，每 76 個字換行）。
 */
export function buildMime(p: { from?: string; to: string; subject: string; text: string; attachments?: MailAttachment[]; boundary?: string }): string {
  const head = [...(p.from ? [`From: ${p.from}`] : []), `To: ${p.to}`, `Subject: ${encodeHeader(p.subject)}`, "MIME-Version: 1.0"];
  const body = wrap76(Buffer.from(p.text, "utf8").toString("base64"));
  const files = p.attachments || [];
  if (!files.length) return [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  const b = p.boundary || `ghrc-${crypto.randomUUID()}`;
  const parts = files.map((f, i) => {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(f.filename)?.[1] || "bin";
    const names = fileParams(f.filename, `photo-${i + 1}.${ext}`);
    return [
      `--${b}`,
      `Content-Type: ${f.contentType}; ${names.type}`,
      `Content-Disposition: attachment; ${names.disposition}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(Buffer.from(f.bytes).toString("base64")),
    ].join("\r\n");
  });
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    ...parts,
    `--${b}--`,
    "",
  ].join("\r\n");
}

async function gmailError(r: Response, what: string): Promise<Error> {
  const body = await r.text();
  return new Error(apiDisabled(r.status, body, "Gmail") || `Gmail ${what} ${r.status}: ${body}`);
}

/**
 * 寄一封信。`attachments`：感謝信附上的合照（明確指示：「讓照片直接附在信裡」）。
 * 沒有附件照舊（`raw` 放在 JSON 裡）；有附件的信動輒好幾 MB，走 Gmail 的**可續傳上傳**
 * （`/upload/…/messages/send?uploadType=resumable`：先開一個上傳位址，再把整封信 PUT 上去；
 * Google 的說明是 5 MB 以上用這一種，messages.send 一封最多 35 MB）。
 */
export async function gmailSend(to: string, subject: string, text: string, attachments: MailAttachment[] = []): Promise<void> {
  // 寄件人＝授權的那個帳號（後台連上的那一個，或 GMAIL_SENDER）。不知道是誰就不寫，讓 Gmail 自己填——
  // 以前寫成 `From: me`，那不是一個信箱，Gmail 會擋
  const from = mock() ? "" : await gmailAccount();
  const mime = buildMime({ from, to, subject, text, attachments });
  if (mock()) {
    const store = getStore();
    const files = attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: a.bytes.length }));
    await store.putMedia("mail/last.json", new TextEncoder().encode(JSON.stringify({ to, subject, text, attachments: files, at: nowISO() })), "application/json");
    await store.putMedia("mail/last.eml", new TextEncoder().encode(mime), "message/rfc822");
    return;
  }
  const token = await accessToken();
  if (!attachments.length) {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
    });
    if (!r.ok) throw await gmailError(r, "send");
    return;
  }
  const bytes = Buffer.from(mime, "utf8");
  const start = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=resumable", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "message/rfc822",
      "x-upload-content-length": String(bytes.length),
    },
    body: "{}",
  });
  if (!start.ok) throw await gmailError(start, "upload");
  const session = start.headers.get("location");
  if (!session) throw new Error("Gmail 沒有給上傳的位址");
  const put = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "message/rfc822" }, body: bytes });
  if (!put.ok) throw await gmailError(put, "upload");
}

/** 一封感謝信最多附幾 MB 的照片（原檔的大小；base64 之後約多三分之一）：Gmail 一封 25 MB，收信端也常常卡在 20 MB 上下。 */
export const ATTACH_MAX_BYTES = 12 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/**
 * 感謝信附上的合照（明確指示：「讓照片直接附在信裡」）：動作四放上的合照，照放上去的順序，
 * 加起來 `ATTACH_MAX_BYTES` 以內——放不下的不附（信裡本來就有專頁相簿的連結，全部都在那裡）。
 * 檔名用放上去時原本的檔名（IMG_8466.jpeg），副檔名跟著實際的格式（HEIC 轉過的是 .jpg），同名的加 -2。
 */
export async function photoAttachments(photos: string[]): Promise<{ attachments: MailAttachment[]; skipped: number; bytes: number }> {
  const store = getStore();
  const attachments: MailAttachment[] = [];
  const used = new Set<string>();
  let bytes = 0;
  let skipped = 0;
  for (const key of photos) {
    if (!/^materials\/[\w-]+\/[\w.-]+$/.test(key)) { skipped += 1; continue; } // 貼的外部連結附不上去
    const m = await store.getMedia(key).catch(() => null);
    const ext = m ? IMAGE_EXT[(m.contentType || "").split(";")[0].trim().toLowerCase()] : "";
    if (!m || !ext || bytes + m.bytes.length > ATTACH_MAX_BYTES) { skipped += 1; continue; }
    const base = String(m.name || key.split("/").pop()!.replace(/^\d{10,}-/, "")).trim().replace(/\.[^.]+$/, "") || "photo";
    const keepExt = /\.(jpe?g)$/i.test(String(m.name || "")) && ext === "jpg" ? String(m.name).match(/\.(jpe?g)$/i)![1] : ext;
    let name = `${base}.${keepExt}`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base}-${n}.${keepExt}`;
    used.add(name.toLowerCase());
    bytes += m.bytes.length;
    attachments.push({ filename: name, contentType: (m.contentType || "image/jpeg").split(";")[0].trim(), bytes: m.bytes });
  }
  return { attachments, skipped, bytes };
}
