import { fail, json, readJSON, rejectHeic, requireAdmin } from "../lib/http.mts";
import { extractFile, extOf, type Extracted } from "../lib/files.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { dropStaged, isStagedKey, isUploadId, MAX_IMAGES, MAX_STAGED, stagedKind, stageFile } from "../lib/staged.mts";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * 讀信抽取。Claude 讀一封長信＋附件（或好幾張手機截圖）常常超過一般函式的 10 秒上限（實際踩過 504 Inactivity Timeout），
 * 所以真正的工作在 extract-background，這裡只負責檢查檔案、開工作、查進度。
 *
 * 附件（手機截圖、名單檔）**一個一個先上傳**，工作裡只帶 key（`netlify/lib/staged.mts`）：
 *   POST   /api/extract  multipart {upload, file}                → {key, kind, name}，或讀不了的 {warning}
 *   POST   /api/extract  {email_text?, upload?, keys?, warnings?} → 202 {job_id}
 *   DELETE /api/extract?upload=<id>&key=<k>…                     → 上傳到一半出錯時，把已經放上去的清掉
 *   GET    /api/extract?job=<id>                                 → {status, result?: {extracted, visit, files_read, warnings}, error?}
 *
 * 舊的寫法（`files: [{name, type, data(base64)}]` 整批塞在同一個 JSON 裡）還收，給還開著舊版後台的分頁；
 * 那一條的總量上限 4 MB——base64 多三分之一，再大就撞到 Netlify 一個請求 6 MB 的上限。
 * Word／Excel／PowerPoint／CSV／文字在這裡就轉成純文字（轉檔很快），PDF 與照片直接交給 Claude 讀。
 * 抽取結果只回傳給人確認，不在這裡落庫。
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "抽取");
  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const upload = url.searchParams.get("upload") || "";
    if (!isUploadId(upload)) return fail(400, "upload 不對");
    await dropStaged(url.searchParams.getAll("key").filter((k) => isStagedKey(k, upload)));
    return json({ ok: true });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");

  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const upload = String(form.get("upload") || "");
    const file = form.get("file");
    if (!isUploadId(upload)) return fail(400, "upload 不對");
    if (!file || typeof file === "string") return fail(400, "沒有收到檔案");
    const name = String(file.name || "file").slice(0, 160);
    const heic = rejectHeic(file.type || "") || (/^hei[cf]$/.test(extOf(name)) ? rejectHeic("image/heic") : null);
    if (heic) return heic;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return fail(413, `${name} 超過 4.5 MB`);
    const out = await extractFile(name, file.type || "", bytes);
    if (out.kind === "unsupported") return json({ ok: true, warning: `${name}：${out.reason}` });
    if (out.kind === "text" && !out.text.trim()) return json({ ok: true, warning: `${name}：檔案裡讀不到文字` });
    return json({ ok: true, key: await stageFile(upload, out), kind: out.kind, name });
  }

  const body = await readJSON<{ email_text?: string; files?: { name?: string; type?: string; data?: string }[]; upload?: string; keys?: unknown[]; warnings?: unknown[] }>(req);
  const text = String(body?.email_text || "").trim();
  const files = Array.isArray(body?.files) ? body!.files! : [];
  const upload = String(body?.upload || "");
  const keys = (Array.isArray(body?.keys) ? body!.keys! : []).map(String);
  // 退回去之前先把這一批已經放上去的清掉（截圖裡有對方的電話與對話，不留著）——**每一個退回都走這裡**
  const refuse = async (status: number, message: string) => {
    if (isUploadId(upload)) await dropStaged(keys.filter((k) => isStagedKey(k, upload)));
    return fail(status, message);
  };
  if (files.length > MAX_FILES) return refuse(413, `一次最多 ${MAX_FILES} 個檔案`);
  if (text.length > 200000) return refuse(413, "內容太長，請只貼相關的往來");
  if (keys.length && (!isUploadId(upload) || keys.some((k) => !isStagedKey(k, upload)))) return refuse(400, "附件的編號不對，請重新選一次");
  if (keys.length > MAX_STAGED) return refuse(413, `一次最多 ${MAX_STAGED} 個附件`);
  if (keys.filter((k) => stagedKind(k) === "image").length > MAX_IMAGES) return refuse(413, `截圖一次最多 ${MAX_IMAGES} 張（長截圖會切成好幾段，也算在裡面）：請分兩次讀，或只留跟參訪有關的那幾張`);
  const attachments: Extracted[] = [];
  const warnings: string[] = (Array.isArray(body?.warnings) ? body!.warnings! : []).map((w) => String(w).slice(0, 300)).slice(0, 30);
  let total = 0;
  for (const f of files) {
    const name = String(f?.name || "file");
    const b64 = String(f?.data || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    if (!b64) continue;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES) return refuse(413, `${name} 超過 4.5 MB`);
    if (total > MAX_TOTAL_BYTES) return refuse(413, "檔案總量超過 4 MB，請分批或改貼文字");
    const out = await extractFile(name, String(f?.type || ""), bytes);
    if (out.kind === "unsupported") warnings.push(`${name}：${out.reason}`);
    else if (out.kind === "text" && !out.text.trim()) warnings.push(`${name}：檔案裡讀不到文字`);
    else attachments.push(out);
  }
  if (text.length < 20 && !attachments.length && !keys.length) return refuse(400, warnings.length ? `沒有可讀的資料。${warnings.join("；")}` : "請貼上 email 內容、手機截圖或名單檔");
  return startBackground("extract", { text, attachments, keys, warnings }, req);
};
