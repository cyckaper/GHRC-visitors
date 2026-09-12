import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";

/**
 * GET  /api/translate?job=<id>                                  → 進度與結果
 * POST /api/translate {texts: string[], target: "ko"|"ja"|"en"} → {translations}（全部都在快取裡）或 202 {job_id}
 *
 * 給後台在瀏覽器產簡報時換第二語言用。翻過的句子快取在媒體庫 translations/<target>/cache.json，
 * 同一段中文第二次就不再花錢——**整批都命中快取就當場回**，不必等背景函式跑一趟。
 * 真的要叫 Claude 的時候才開工作：一批 25 段翻下來常常不只 10 秒（一般函式的上限）。
 */
const MAX_ITEMS = 80;
const MAX_CHARS = 20000;

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "翻譯");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<{ texts?: unknown; target?: string }>(req);
  const target = body?.target === "ko" || body?.target === "ja" || body?.target === "en" ? body.target : null;
  if (!target) return fail(400, "target 需要是 ko、ja 或 en");
  const texts = Array.isArray(body?.texts) ? body!.texts.map((t) => String(t ?? "")) : [];
  if (!texts.length) return fail(400, "需要 texts");
  if (texts.length > MAX_ITEMS) return fail(413, `一次最多 ${MAX_ITEMS} 段`);
  if (texts.reduce((s, t) => s + t.length, 0) > MAX_CHARS) return fail(413, `一次最多 ${MAX_CHARS} 字`);

  const cache = await loadCache(target);
  const missing = [...new Set(texts.filter((t) => t.trim() && cache[t] === undefined))];
  if (!missing.length) {
    const translations = texts.map((t) => (t.trim() ? cache[t] ?? t : t));
    return json({ ok: true, target, translations, translated: 0, from_cache: texts.length });
  }
  return startBackground("translate", { texts, target }, req);
};

export async function loadCache(target: string): Promise<Record<string, string>> {
  try {
    const m = await getStore().getMedia(`translations/${target}/cache.json`);
    return m ? (JSON.parse(new TextDecoder().decode(m.bytes)) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
