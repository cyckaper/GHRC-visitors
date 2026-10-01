import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { DRIVE_HINT, driveConfig, driveReady, ensureVisitFolder, folderUrl, itemBytes, plan, uploadItem } from "../lib/drive.mts";

/**
 * 後台的手動備份（自動備份走 drive-sync-background，見 lib/drive.mts）。
 * 一次請求只搬一個檔，好在介面上顯示進度。
 *   GET  /api/drive?id=<visit_id>        → { configured, items, drive }
 *   POST /api/drive {visit_id, key}      → 上傳這一項
 *   POST /api/drive {visit_id, done:true}→ 記下備份時間
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const configured = await driveReady();
  const store = getStore();

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const visit = id ? await store.getVisit(id) : null;
    if (id && !visit) return fail(404, "找不到這次參訪");
    return json({
      ok: true,
      configured,
      folder_id: driveConfig().parent,
      items: visit ? plan(visit) : [],
      drive: visit ? (visit as any).drive || null : null,
      hint: configured ? "" : DRIVE_HINT,
    });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");
  if (!configured) return fail(503, DRIVE_HINT);
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const visit = await store.getVisit(String(body.visit_id));
  if (!visit) return fail(404, "找不到這次參訪");

  try {
    if (body.done) {
      const saved = await store.updateVisit(visit.visit_id, (v) => {
        (v as any).drive = { ...((v as any).drive || {}), backed_up_at: nowISO(), items: Number(body.items) || 0 };
      });
      return json({ ok: true, drive: (saved as any)?.drive || null });
    }

    const key = String(body.key || "");
    const item = plan(visit).find((x) => x.key === key);
    if (!item) return fail(400, "這一項不在備份清單裡");
    const responses = await store.listResponses(visit.visit_id);
    const payload = await itemBytes(visit, responses, key);
    if (!payload) return fail(404, `媒體庫裡找不到 ${key}`);
    const folder = await ensureVisitFolder(visit);
    const file = await uploadItem(folder, item.name, payload.mime, payload.bytes);
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      (v as any).drive = { ...((v as any).drive || {}), folder_id: folder, url: folderUrl(folder) };
    });
    return json({ ok: true, file: { name: item.name, id: file.id, url: file.webViewLink, bytes: payload.bytes.length }, drive: (saved as any)?.drive || null });
  } catch (e: any) {
    return fail(502, `Drive 備份失敗：${e?.message || e}`);
  }
};
