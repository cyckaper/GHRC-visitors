import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { sheetInfo, sheetsReady, XLSX_MIME } from "../lib/drive.mts";
import { listDue, listSummary, loadList, touchList } from "../lib/visitlist.mts";

const MAX_FILE_BYTES = 4.5 * 1024 * 1024;

/**
 * 參訪名單（Google 試算表）自動同步——後台用（規則在 `lib/visitlist.mts`）。
 *
 * GET  /api/visit-list                           → {configured, linked, name, url, from, checked_at, last, error, rows}
 * GET  /api/visit-list?job=<id>                  → 背景工作的進度
 * POST /api/visit-list {action: "link", file}    → 202：把匯入的那一份存成系統自己的 Google 試算表，之後就看這一份
 * POST /api/visit-list {action: "check"}         → 名單改過了才開工作（202）；沒改就當場回 {unchanged: true}（打開「資料」分頁時問一次）
 * POST /api/visit-list {action: "sync"}          → 202：不管修改時間，現在就讀一次（「現在就看一次」）
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("job")) return pollJob(req, "看名單");
    return json({ ok: true, configured: await sheetsReady(), ...listSummary(await loadList()) });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  if (!(await sheetsReady())) return fail(409, "Google Drive 還沒接好（設定分頁看得到），名單沒辦法自動同步");
  const body = await readJSON<any>(req);
  const action = String(body?.action || "check");
  const s = await loadList();
  if (action === "link") {
    if (s) return json({ ok: true, ...listSummary(s) }); // 已經連上了：不另外再建一份
    const f = body?.file || {};
    const name = String(f.name || "名單").slice(0, 200);
    const b64 = String(f.data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    if (!b64) return fail(400, "請選一個檔案");
    if (Buffer.from(b64, "base64").length > MAX_FILE_BYTES) return fail(413, `${name} 超過 4.5 MB`);
    if (!/\.(xlsx|xlsm|csv)$/i.test(name)) return fail(400, "只有試算表（.xlsx／.csv）能存成 Google 試算表");
    const mime = /\.csv$/i.test(name) ? "text/csv" : XLSX_MIME;
    return startBackground("visit-list", { link: { name, mime, data: b64 } }, req);
  }
  if (!s) return fail(409, "還沒有連到名單：匯入以前的參訪時勾「同時存成 Google 試算表」");
  if (action === "sync") return startBackground("visit-list", { force: true }, req);
  let info;
  try {
    info = await sheetInfo(s.file_id);
  } catch (e: any) {
    return json({ ok: true, unchanged: true, ...listSummary(s), error: `找不到名單：${e?.message || e}` });
  }
  if (!listDue(s, info)) {
    await touchList(s);
    return json({ ok: true, unchanged: true, ...listSummary(s) });
  }
  return startBackground("visit-list", {}, req);
};
