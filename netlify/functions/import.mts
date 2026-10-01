import { fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { extractFile } from "../lib/files.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { getStore } from "../lib/store.mts";
import { aiConfigured } from "../lib/ai.mts";
import type { Visit } from "../lib/types.mts";
import { importedVisit, parseVisitTable, planImport } from "../../lib/import.mjs";
import { normalizeVisit } from "./visits.mts";

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
  const store = getStore();
  // 預覽之後可能有人新增過：照最新的資料再對一次（同一天同一個單位、網址代碼撞到）
  const plan = planImport(rows, await store.listVisits());
  const at = nowISO();
  const skipped: { row: string; org: string; reason: string }[] = [];
  const todo: Visit[] = [];
  for (const r of plan) {
    const reason = r.problems.join("、") || (r.exists ? `已經有了（${r.exists}）` : r.duplicate ? "名單裡重複" : "");
    if (reason) {
      skipped.push({ row: r.source_row, org: r.org.name_local || r.org.name, reason });
      continue;
    }
    const v = normalizeVisit(importedVisit(r, { file, at }) as any, siteUrl(req));
    v.headcount = r.headcount; // 原表沒寫人數就是 0（不知道），不拿名單上有名字的人數充數
    v.created_at = at;
    v.updated_at = at;
    todo.push(v);
  }
  // 一場一個 key，彼此不衝突：幾筆一起寫，二十幾場也在一般函式的 10 秒內寫完
  const created: string[] = [];
  for (let i = 0; i < todo.length; i += 6) {
    const batch = todo.slice(i, i + 6);
    await Promise.all(batch.map((v) => store.putVisit(v)));
    created.push(...batch.map((v) => v.visit_id));
  }
  return json({ ok: true, created, skipped });
}
