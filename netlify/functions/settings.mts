import { env, fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { driveConfigured } from "../lib/drive.mts";

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
const DEFAULTS = { sender_default: "director" as "director" | "contact" };

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

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  if (req.method === "POST") {
    const body = await readJSON<{ settings?: Partial<Settings> }>(req);
    const sender = body?.settings?.sender_default;
    const next: Settings = { ...(await loadSettings()), ...(sender === "contact" || sender === "director" ? { sender_default: sender } : {}) };
    await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify(next)), "application/json");
    return json({ ok: true, settings: next });
  }
  if (req.method !== "GET") return fail(405, "method not allowed");

  const master = await getStore().getMedia("master/manifest.json");
  return json({
    ok: true,
    settings: await loadSettings(),
    status: {
      ai: !!env("ANTHROPIC_API_KEY") || !!env("AI_MOCK"),
      ai_mock: !!env("AI_MOCK"),
      whisper: !!env("OPENAI_API_KEY"),
      gmail: !!(env("GMAIL_CLIENT_ID") && env("GMAIL_CLIENT_SECRET") && env("GMAIL_REFRESH_TOKEN")),
      drive: driveConfigured(),
      signal: !!env("SIGNAL_KEY"),
      store: getStore().backend,
      master: !!master,
    },
  });
};
