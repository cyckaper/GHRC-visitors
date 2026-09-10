import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, siteUrl } from "./http.mts";

/**
 * 讀取 public/data/*.json（labs、slides、i18n）與 data/master-text.json。
 * 先找本機檔案（included_files 打包進 function 或本機開發），找不到就從站台抓（資料本來就是公開的）。
 */
const cache = new Map<string, any>();

async function readCandidates(rel: string): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), rel),
    path.resolve(here, "../../../", rel),
    path.resolve(here, "../../", rel),
    path.resolve(here, "../", rel),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function loadPublicData(name: "labs" | "slides" | "i18n"): Promise<any> {
  if (cache.has(name)) return cache.get(name);
  const rel = `public/data/${name}.json`;
  let text = await readCandidates(rel);
  if (text == null) {
    const url = `${siteUrl()}/data/${name}.json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`找不到 ${rel}，站台也抓不到（${r.status}）`);
    text = await r.text();
  }
  const parsed = JSON.parse(text);
  cache.set(name, parsed);
  return parsed;
}

/** data/master-text.json：CLI `--dump` 產出的母簡報文字（選用）。 */
export async function loadMasterText(): Promise<any | null> {
  if (cache.has("master-text")) return cache.get("master-text");
  const text = await readCandidates("data/master-text.json");
  const parsed = text ? JSON.parse(text) : null;
  cache.set("master-text", parsed);
  return parsed;
}

export function isMock(): boolean {
  return env("AI_MOCK") === "1" || env("AI_MOCK") === "true";
}
