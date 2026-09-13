import { env, fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { driveConfigured } from "../lib/drive.mts";
import { gmailConfigured } from "../lib/mail.mts";
import { aiConfigured } from "../lib/ai.mts";

/**
 * 一次性設定與系統狀態（後台「設定」分頁）。
 *
 * GET  /api/settings            → { settings, status }
 * POST /api/settings {settings} → 存起來（目前只有訪後信的預設寄件者）
 *
 * `status` 只回「有沒有設定」這件事，**不回任何金鑰內容**——那些一律留在 Netlify 的環境變數裡。
 * 設定本身存在媒體庫的 `settings.json`（全站一份，不屬於任何一場參訪）。
 */
const KEY = "settings.json";
const DEFAULTS = { sender_default: "director" as "director" | "contact", reminder_to: "" };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type Settings = typeof DEFAULTS;

export async function loadSettings(): Promise<Settings> {
  try {
    const m = await getStore().getMedia(KEY);
    if (!m) return { ...DEFAULTS };
    const saved = JSON.parse(new TextDecoder().decode(m.bytes)) as Partial<Settings>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 收工提醒寄到哪裡（reminder-cron 用）：後台「設定」填的優先，沒填就用 Netlify 的
 * `REMINDER_TO`，再沒有就用寄件帳號 `GMAIL_SENDER`。三個都沒有就不寄——寧可不寄，
 * 也不要亂猜一個地址。
 */
export async function reminderTo(): Promise<string> {
  const s = await loadSettings();
  return (s.reminder_to || env("REMINDER_TO") || env("GMAIL_SENDER") || "").trim().toLowerCase();
}

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  if (req.method === "POST") {
    const body = await readJSON<{ settings?: Partial<Settings> }>(req);
    const next: Settings = { ...(await loadSettings()) };
    const sender = body?.settings?.sender_default;
    if (sender === "contact" || sender === "director") next.sender_default = sender;
    if (typeof body?.settings?.reminder_to === "string") {
      const to = body.settings.reminder_to.trim().slice(0, 200).toLowerCase();
      if (to && !EMAIL.test(to)) return fail(400, "收工提醒的收件者要填一個 email 位址（留空就用 Netlify 設的寄件帳號）");
      next.reminder_to = to;
    }
    await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify(next)), "application/json");
    return json({ ok: true, settings: next, effective: { reminder_to: await reminderTo() } });
  }
  if (req.method !== "GET") return fail(405, "method not allowed");

  const master = await getStore().getMedia("master/manifest.json");
  const to = await reminderTo();
  return json({
    ok: true,
    settings: await loadSettings(),
    // 實際會用到的收件者（後台的欄位留空時是 Netlify 的寄件帳號）。這是中心自己的信箱，不是金鑰。
    effective: { reminder_to: to },
    status: {
      ai: aiConfigured(),
      ai_mock: !!env("AI_MOCK"),
      whisper: !!env("OPENAI_API_KEY"),
      gmail: gmailConfigured(),
      drive: driveConfigured(),
      signal: !!env("SIGNAL_KEY"),
      reminder: !!(gmailConfigured() && to),
      store: getStore().backend,
      master: !!master,
    },
  });
};
