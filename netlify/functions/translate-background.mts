import { getStore } from "../lib/store.mts";
import { translateTexts } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { loadCache } from "./translate.mts";

/**
 * 第二語言翻譯（背景函式，15 分鐘上限）。只翻快取裡沒有的句子，翻完寫回快取。
 * 快取在寫回前重讀一次：同一份簡報的幾批翻譯是連著跑的，別把別批剛寫進去的蓋掉。
 */
export default backgroundHandler<{ texts: string[]; target: "ko" | "ja" | "en" }>("翻譯", async (input) => {
  const texts = (input.texts || []).map((t) => String(t ?? ""));
  const target = input.target;
  const cache = await loadCache(target);
  const missing = [...new Set(texts.filter((t) => t.trim() && cache[t] === undefined))];
  if (missing.length) {
    const out = await translateTexts(missing, target);
    const fresh = await loadCache(target);
    missing.forEach((t, i) => {
      cache[t] = out[i];
      fresh[t] = out[i];
    });
    await getStore().putMedia(`translations/${target}/cache.json`, new TextEncoder().encode(JSON.stringify(fresh)), "application/json");
  }
  return { target, translations: texts.map((t) => (t.trim() ? cache[t] ?? t : t)), translated: missing.length, from_cache: texts.length - missing.length };
});
