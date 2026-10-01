import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { extractFile } from "../lib/files.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { getStore } from "../lib/store.mts";
import { purgePublicVisits } from "../lib/cdn.mts";
import { aiConfigured } from "../lib/ai.mts";
import { parseVisitTable, planImport } from "../../lib/import.mjs";
import { createImported } from "../lib/visitlist.mts";

const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_ROWS = 300;

/**
 * 匯入以前的參訪名單（系統上線之前的紀錄；明確要求：「把所有參訪者加入中心首頁地圖，以及主辦端網頁資料地圖中」）。
 * 匯入之後就是一般的一場：後台「資料」分頁的地圖與清單、中心首頁的來訪單位地圖都照舊從參訪紀錄來，
 * 位置也照舊由 /api/geo 去查——沒有第二份資料。
 *
 * POST /api/import {file: {name, type, data}}     → 202 {job_id}：AI 讀表（英文正式名稱、類型、一列有好幾個單位就拆開）
 *                                                    Claude 還沒接好：照欄名讀，當場回 {rows, skipped, file, by: "columns"}
 * GET  /api/import?job=<id>                        → {status, result?: {rows, skipped, file}}
 * POST /api/import {action: "commit", file, rows}  → {created: [visit_id], skipped: [{row, org, reason}]}
 *
 * **讀完只回預覽，不落庫**（抽取結果一律給人確認後才寫入）；勾好之後 commit 才寫，
 * 而且寫之前再對一次最新的資料——同一天、同一個單位已經有了就不建，重複匯入同一份名單不會多出東西。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "讀名單");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (body?.action === "commit") return commit(body, req);
  const f = body?.file || {};
  const name = String(f.name || "名單").slice(0, 200);
  const b64 = String(f.data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!b64) return fail(400, "請選一個檔案");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length > MAX_FILE_BYTES) return fail(413, `${name} 超過 4.5 MB`);
  const out = await extractFile(name, String(f.type || ""), bytes);
  if (out.kind === "unsupported") return fail(400, `${name}：${out.reason}`);
  if (out.kind !== "text") return fail(400, `${name}：請用試算表（.xlsx／.csv）、Word 或簡報檔；PDF 與照片請先另存成試算表`);
  if (!out.text.trim()) return fail(400, `${name}：檔案裡讀不到文字`);
  if (!aiConfigured()) {
    // Claude 還沒接好：照欄名讀（第一列要有「日期」與「來訪單位」），單位名稱就照原表的中文
    const { rows, skipped } = parseVisitTable(out.text);
    return json({ ok: true, rows: planImport(rows, await getStore().listVisits()), skipped, file: name, by: "columns" });
  }
  return startBackground("import", { text: out.text, name }, req);
};

async function commit(body: any, req: Request): Promise<Response> {
  const file = String(body?.file || "").slice(0, 200);
  const rows = Array.isArray(body?.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  if (!rows.length) return fail(400, "沒有勾任何一筆");
  // 預覽之後可能有人新增過：照最新的資料再對一次（同一天同一個單位、網址代碼撞到）
  const plan = planImport(rows, await getStore().listVisits());
  const { created, skipped } = await createImported(plan, { file, at: nowISO(), site: siteUrl(req) });
  // 首頁的地圖與來訪紀錄頁：匯入完重新整理就看得到，不必等 CDN 那一份過期
  if (created.length) await purgePublicVisits();
  return json({ ok: true, created, skipped });
}
