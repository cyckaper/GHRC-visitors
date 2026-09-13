import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { isValidVisitId } from "../../lib/visit.mjs";

/**
 * 暫存還沒交出去的東西（貼進來的 email、打好的逐字稿、手改過的信件、還沒有單位名稱所以存不成一場的表單）。
 * 一關網頁就沒了的東西不該存在——後台其他地方都自己存了，只剩這幾個大方框沒有。
 *
 * GET    /api/draft?id=<visit_id|new>        → {draft: {id, saved_at, fields} | null}
 * POST   /api/draft {id, fields}             → 存起來（fields 全空就等於刪掉）
 * DELETE /api/draft?id=<visit_id|new>        → 刪掉整筆
 *
 * 為什麼不只用瀏覽器的 localStorage：後台常常在筆電上排一半、當天換 iPad 打開，暫存要跟著人走。
 * 前端仍然同時寫一份 localStorage（關掉網頁的那一瞬間比送到站台快），兩邊取時間新的那一份。
 *
 * `fields` 是「畫面上的值」減去「伺服器剛給的值」——也就是真的只有還沒交出去的部分。
 * 所以草擬完、寄出、存入之後前端重新比對一次，這一筆自然就空了（POST 空的 fields 會把它刪掉）。
 */
const MAX_FIELD = 200000;
const MAX_TOTAL = 1500 * 1024; // 貼一封 20 萬字的長信（UTF-8 約 600 KB）也要塞得下
const MAX_KEYS = 40;
const KEY_OK = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface Draft {
  id: string;
  saved_at: string;
  fields: Record<string, unknown>;
}

const mediaKey = (id: string) => `drafts/${id}.json`;
/** 還沒存成一場的那一份暫存放在 `new` 底下（visit_id 要用單位名稱算，還沒有就還沒有）。 */
const draftId = (given: unknown) => {
  const id = String(given ?? "").trim();
  return id === "new" || isValidVisitId(id) ? id : "";
};

export async function loadDraft(id: string): Promise<Draft | null> {
  try {
    const m = await getStore().getMedia(mediaKey(id));
    if (!m) return null;
    const d = JSON.parse(new TextDecoder().decode(m.bytes)) as Draft;
    return d?.fields && typeof d.fields === "object" ? d : null;
  } catch {
    return null;
  }
}

export async function dropDraft(id: string): Promise<void> {
  await getStore().deleteMedia(mediaKey(id)).catch(() => {});
}

/** 改網址代碼或日期＝換一個 visit_id：暫存跟著走，不然手上打的東西會跟著舊網址不見。 */
export async function moveDraft(from: string, to: string): Promise<void> {
  if (!from || !to || from === to) return;
  const d = await loadDraft(from);
  await dropDraft(from);
  if (d) await saveDraft(to, d.fields);
}

async function saveDraft(id: string, fields: Record<string, unknown>): Promise<Draft | null> {
  if (!Object.keys(fields).length) {
    await dropDraft(id);
    return null;
  }
  const draft: Draft = { id, saved_at: nowISO(), fields };
  await getStore().putMedia(mediaKey(id), new TextEncoder().encode(JSON.stringify(draft)), "application/json");
  return draft;
}

/** 只收字串與一個表單物件，數量與長度都設上限——暫存是暫存，不是拿來當倉庫。 */
function clean(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!KEY_OK.test(k) || Object.keys(out).length >= MAX_KEYS) continue;
    if (typeof v === "string") {
      if (v.trim()) out[k] = v.slice(0, MAX_FIELD);
    } else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = draftId(url.searchParams.get("id"));
    if (!id) return fail(400, "需要 id（visit_id 或 new）");
    return json({ ok: true, draft: await loadDraft(id) });
  }

  if (req.method === "POST") {
    const body = await readJSON<{ id?: string; fields?: unknown }>(req);
    const id = draftId(body?.id ?? url.searchParams.get("id"));
    if (!id) return fail(400, "需要 id（visit_id 或 new）");
    const fields = clean(body?.fields);
    const size = new TextEncoder().encode(JSON.stringify(fields)).length;
    if (size > MAX_TOTAL) return fail(413, "要暫存的內容太長了，請分批處理", { too_long: true });
    return json({ ok: true, draft: await saveDraft(id, fields) });
  }

  if (req.method === "DELETE") {
    const id = draftId(url.searchParams.get("id"));
    if (!id) return fail(400, "需要 id（visit_id 或 new）");
    await dropDraft(id);
    return json({ ok: true, draft: null });
  }

  return fail(405, "method not allowed");
};
