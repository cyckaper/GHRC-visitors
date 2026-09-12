import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { extractFile, type Extracted } from "../lib/files.mts";
import { getJob, publicJob, startJob, triggerBackground } from "../lib/jobs.mts";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/**
 * 讀信抽取。Claude 讀一封長信＋附件常常超過一般函式的 10 秒上限（實際踩過 504 Inactivity Timeout），
 * 所以真正的工作在 extract-background，這裡只負責檢查檔案、開工作、查進度。
 *
 * POST /api/extract {email_text?, files?: [{name, type, data}]} → 202 {job_id}
 * GET  /api/extract?job=<id>                                    → {status, result?: {extracted, visit, files_read, warnings}, error?}
 *
 * files[].data 是 base64（可帶 data: 前綴）。Word／Excel／PowerPoint／CSV／文字在這裡就轉成純文字
 * （轉檔很快，而且轉完再送背景可以少搬一份原始檔），PDF 與照片直接交給 Claude 讀。
 * 抽取結果只回傳給人確認，不落庫。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") {
    const job = await getJob(new URL(req.url).searchParams.get("job") || "");
    if (!job) return fail(404, "找不到這個抽取工作（可能已經過期，請再抽一次）");
    return json({ ok: true, ...publicJob(job) });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ email_text?: string; files?: { name?: string; type?: string; data?: string }[] }>(req);
  const text = String(body?.email_text || "").trim();
  const files = Array.isArray(body?.files) ? body!.files! : [];
  if (files.length > MAX_FILES) return fail(413, `一次最多 ${MAX_FILES} 個檔案`);
  if (text.length > 200000) return fail(413, "內容太長，請只貼相關的往來");
  const attachments: Extracted[] = [];
  const warnings: string[] = [];
  let total = 0;
  for (const f of files) {
    const name = String(f?.name || "file");
    const b64 = String(f?.data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    if (!b64) continue;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES) return fail(413, `${name} 超過 4.5 MB`);
    if (total > MAX_TOTAL_BYTES) return fail(413, "檔案總量超過 5 MB，請分批或改貼文字");
    const out = await extractFile(name, String(f?.type || ""), bytes);
    if (out.kind === "unsupported") warnings.push(`${name}：${out.reason}`);
    else if (out.kind === "text" && !out.text.trim()) warnings.push(`${name}：檔案裡讀不到文字`);
    else attachments.push(out);
  }
  if (text.length < 20 && !attachments.length) return fail(400, warnings.length ? `沒有可讀的資料。${warnings.join("；")}` : "請貼上 email 內容或上傳名單檔");
  const job = await startJob("extract", { text, attachments, warnings });
  await triggerBackground("extract-background", { job_id: job.id }, req);
  return json({ ok: true, job_id: job.id, status: job.status }, { status: 202 });
};
