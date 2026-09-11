import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { DRIVE_HINT, driveConfigured, syncVisit } from "../lib/drive.mts";

/**
 * 自動備份到 Google Drive。Netlify 背景函式（檔名結尾 -background）：呼叫端立刻拿到 202，
 * 這裡最多可以跑 15 分鐘，所以一次把整場的檔案搬完，不受一般函式 10 秒上限限制。
 *
 * 由 lib/drive.mts 的 triggerDriveSync() 在資料寫入後觸發（存檔、收工、當天資料、訪後信、摘要、來賓回覆），
 * 另外每晚 drive-cron 會掃一次補漏。自上次備份後沒有新東西就直接跳過。
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ visit_id?: string; force?: boolean }>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  if (!driveConfigured()) return fail(503, DRIVE_HINT);
  try {
    const r = await syncVisit(String(body.visit_id), { force: !!body.force });
    return json({ ok: true, ...r });
  } catch (e: any) {
    return fail(502, `自動備份失敗：${e?.message || e}`);
  }
};
