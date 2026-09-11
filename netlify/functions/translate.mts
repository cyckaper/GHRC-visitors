import { fail, json, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { translateTexts } from "../lib/ai.mts";

/**
 * POST /api/translate {texts: string[], target: "ko"|"ja"|"en"} → {translations}
 * 給後台在瀏覽器產簡報時換第二語言用。翻過的句子快取在媒體庫 translations/<target>/cache.json，
 * 同一段中文第二次就不再花錢；瀏覽器端一次送 25 段左右，避開 Netlify Function 的 10 秒逾時。
 */
const MAX_ITEMS = 80;
const MAX_CHARS = 20000;

export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<{ texts?: unknown; target?: string }>(req);
  const target = body?.target === "ko" || body?.target === "ja" || body?.target === "en" ? body.target : null;
  if (!target) return fail(400, "target 需要是 ko、ja 或 en");
  const texts = Array.isArray(body?.texts) ? body!.texts.map((t) => String(t ?? "")) : [];
  if (!texts.length) return fail(400, "需要 texts");
  if (texts.length > MAX_ITEMS) return fail(413, `一次最多 ${MAX_ITEMS} 段`);
  if (texts.reduce((s, t) => s + t.length, 0) > MAX_CHARS) return fail(413, `一次最多 ${MAX_CHARS} 字`);

  const store = getStore();
  const cacheKey = `translations/${target}/cache.json`;
  let cache: Record<string, string> = {};
  try {
    const m = await store.getMedia(cacheKey);
    if (m) cache = JSON.parse(new TextDecoder().decode(m.bytes)) as Record<string, string>;
  } catch {
    cache = {};
  }
  const missing = [...new Set(texts.filter((t) => t.trim() && cache[t] === undefined))];
  let translated = 0;
  if (missing.length) {
    try {
      const out = await translateTexts(missing, target);
      missing.forEach((t, i) => (cache[t] = out[i]));
      translated = missing.length;
      await store.putMedia(cacheKey, new TextEncoder().encode(JSON.stringify(cache)), "application/json");
    } catch (e: any) {
      return fail(502, `翻譯失敗：${e?.message || e}`);
    }
  }
  const translations = texts.map((t) => (t.trim() ? cache[t] ?? t : t));
  return json({ ok: true, target, translations, translated, from_cache: texts.length - translated });
};
