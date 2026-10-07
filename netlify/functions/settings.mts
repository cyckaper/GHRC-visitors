import { env, fail, json, randomId, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { driveReady } from "../lib/drive.mts";
import { gmailAccount, googleStatus } from "../lib/google.mts";
import { gmailReady } from "../lib/mail.mts";
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
/**
 * 以前還有 `video_links`（母簡報影片的雲端網址）與 `lab_emails`（研究室老師的信箱），
 * **明確指示拿掉了**（「設定已經太亂了」）：通告本來就是貼 LINE 群組，影片要播就當場選原始母簡報。
 * 存過的舊值讀的時候直接丟掉（`loadSettings` 只留認得的欄位），下一次存檔就清乾淨。
 */
/**
 * `rota_key`：**支援人力表**（`/rota`）那個連結裡的密語。老師從 LINE 點進來就要能填，
 * 卡在帳號密碼回覆率就沒了，所以用「猜不到的網址」而不是登入。
 * **自動產生**（`ensureRotaKey()`，明確要求）：第一次有人要用就產一個存起來，之後一直沿用——
 * 沒有「產生連結」「收回」這兩個動作，通告永遠帶得出連結。只在外流時按「換一個新連結」
 * （設定分頁支援人力表底下那一行），舊連結立刻失效。
 */
const DEFAULTS = { sender_default: "director" as "director" | "contact", reminder_to: "", rota_key: "" };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type Settings = typeof DEFAULTS;

export async function loadSettings(): Promise<Settings> {
  try {
    const m = await getStore().getMedia(KEY);
    if (!m) return { ...DEFAULTS };
    const saved = JSON.parse(new TextDecoder().decode(m.bytes)) as Partial<Settings>;
    // 只留認得的欄位：拿掉的設定（影片連結、老師信箱）存過的舊值不再帶出去
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (saved[k] !== undefined) (out as any)[k] = saved[k];
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 支援人力表的連結：沒有就產一個存起來，有就沿用。打開「設定」分頁、草擬通告都會走這裡，
 * 所以連結永遠在——主辦端不必記得先去按什麼。
 *
 * 寫完**再讀一次**才回傳：兩個地方剛好同時第一次要用（打開設定與草擬通告撞在一起），各自產了一個
 * 的話，兩邊回傳的都是最後存進去的那一個，不會有一則通告帶著一個已經被蓋掉的連結出去。
 */
export async function ensureRotaKey(): Promise<string> {
  const s = await loadSettings();
  if (s.rota_key) return s.rota_key;
  const made = randomId(24);
  await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify({ ...s, rota_key: made })), "application/json");
  return (await loadSettings()).rota_key || made;
}

/**
 * 後續提醒寄到哪裡（reminder-cron 用）：後台「設定」填的優先，沒填就用 Netlify 的
 * `REMINDER_TO`，再沒有就寄給寄信的那個帳號自己（`gmailAccount()`：後台連上 Google 的那一個，或 `GMAIL_SENDER`）——
 * 設定分頁那一格寫的就是「留空就用寄信那個帳號」。以前只看 `GMAIL_SENDER`，在後台連上 Google 的站台
 * 那一格留空就是「未設定」、提醒不寄。都沒有就不寄——寧可不寄，也不要亂猜一個地址。
 */
export async function reminderTo(): Promise<string> {
  const s = await loadSettings();
  return (s.reminder_to || env("REMINDER_TO") || (await gmailAccount()) || "").trim().toLowerCase();
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
      if (to && !EMAIL.test(to)) return fail(400, "後續提醒的收件者要填一個 email 位址（留空就寄給寄信的那個帳號）");
      next.reminder_to = to;
    }
    // 支援人力表的連結：只有「換一個」（外流時用）。沒有「收回」——連結是自動產生的，
    // 收回了下一次打開設定又會產一個，等於換一個，還多一個讓人搞不清楚的按鈕
    if (body?.settings?.rota_key === "new") next.rota_key = randomId(24);
    await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify(next)), "application/json");
    return json({ ok: true, settings: next, effective: { reminder_to: await reminderTo() } });
  }
  if (req.method !== "GET") return fail(405, "method not allowed");

  const to = await reminderTo();
  const gmail = await gmailReady();
  await ensureRotaKey(); // 打開設定就看得到連結，不必先按「產生」
  return json({
    ok: true,
    settings: await loadSettings(),
    // 實際會用到的收件者（後台的欄位留空時是 Netlify 的寄件帳號）。這是中心自己的信箱，不是金鑰。
    effective: { reminder_to: to },
    status: {
      ai: aiConfigured(),
      ai_mock: !!env("AI_MOCK"),
      whisper: !!env("OPENAI_API_KEY"),
      gmail,
      drive: await driveReady(),
      reminder: !!(gmail && to),
      store: getStore().backend,
      // Google 連上了沒、哪個帳號、**現在能不能用**（過期了也要看得出來——以前寫「已設定」，備份停了兩週沒人知道）
      google: await googleStatus(req),
    },
  });
};
