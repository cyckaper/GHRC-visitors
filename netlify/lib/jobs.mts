import { env, siteUrl } from "./http.mts";
import { getStore } from "./store.mts";

/**
 * 背景工作：Netlify 一般函式只有 10 秒，Claude 的長呼叫（抽取、查背景）常常超過，
 * 使用者看到的是 504 Inactivity Timeout。所以做法一律是：
 *
 *   POST /api/<name>            → 開一個 job（連同輸入一起存）、觸發 <name>-background、回 202 {job_id}
 *   <name>-background（15 分鐘）→ 從 job 讀輸入、真的做事，做完寫回 job
 *   GET  /api/<name>?job=<id>   → 前端每幾秒問一次，running／done／error
 *
 * job 存在媒體庫的 `jobs/<id>.json`。輸入跟著 job 走而不是塞在觸發的請求裡：
 * 背景函式自己去讀，觸發只要帶 job_id，重試也不必再傳一次檔案。
 */
export interface Job<T = any, I = any> {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at?: string;
  /** 這件工作要處理的東西（可能幾 MB 的附件）。只給背景函式讀，不回給前端。 */
  input?: I;
  result?: T;
  error?: string;
}

const key = (id: string) => `jobs/${id}.json`;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const isJobId = (id: string) => /^[a-z0-9]{6,40}$/.test(id);

async function write(job: Job): Promise<Job> {
  await getStore().putMedia(key(job.id), enc.encode(JSON.stringify(job)), "application/json");
  return job;
}

export async function startJob(kind: string, input?: unknown): Promise<Job> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return write({ id, kind, status: "running", started_at: new Date().toISOString(), input });
}

/** 回給前端的樣子：輸入（信件全文、附件）不必再送回去。 */
export function publicJob(job: Job): Omit<Job, "input"> {
  const { input, ...rest } = job;
  return rest;
}

export async function getJob(id: string): Promise<Job | null> {
  if (!isJobId(id)) return null;
  const m = await getStore().getMedia(key(id));
  if (!m) return null;
  try {
    return JSON.parse(dec.decode(m.bytes)) as Job;
  } catch {
    return null;
  }
}

/** 做完就把輸入丟掉（附件可能好幾 MB，留著只是佔位子）。 */
export async function finishJob(id: string, result: unknown): Promise<void> {
  const job = (await getJob(id)) || { id, kind: "", status: "running" as const, started_at: new Date().toISOString() };
  await write({ ...publicJob(job), status: "done", finished_at: new Date().toISOString(), result });
}

export async function failJob(id: string, message: string): Promise<void> {
  const job = (await getJob(id)) || { id, kind: "", status: "running" as const, started_at: new Date().toISOString() };
  await write({ ...publicJob(job), status: "error", finished_at: new Date().toISOString(), error: String(message).slice(0, 500) });
}

/** 觸發背景函式，不等它做完（Netlify 的背景函式立刻回 202，真正的工作繼續跑）。 */
export async function triggerBackground(name: string, body: unknown, req?: Request): Promise<void> {
  const admin = env("ADMIN_TOKEN");
  if (!admin) return;
  try {
    await fetch(`${siteUrl(req)}/.netlify/functions/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* 背景函式收到就好；真的沒被叫到的話，前端輪詢會停在 running，使用者可以再按一次 */
  }
}
