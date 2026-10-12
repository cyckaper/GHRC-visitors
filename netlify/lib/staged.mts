import type { Extracted } from "./files.mts";
import { getStore } from "./store.mts";

/**
 * 讀信抽取的附件（手機截圖、名單檔）**一個一個**先放進媒體庫的 `extract/<upload>/…`，抽取的工作裡只帶 key，
 * 背景函式讀完就刪（CLAUDE.md：照片、音檔這種大東西不進工作）。
 *
 * 以前是整批附件 base64 塞在同一個請求裡：Netlify 一般函式的請求上限 6 MB，base64 又多三分之一——
 * 兩三張手機截圖（一張 PNG 常常 1–3 MB）就超過，而且超過時連錯誤訊息都是平台吐的英文。
 * 放進媒體庫的是 `extractFile()` 讀好的結果（文字、或交給 Claude 的 base64），背景函式不必再轉一次。
 */
export const MAX_STAGED = 24;
/** Claude 一個請求超過 20 張圖，每一張都要縮到 2000 像素以下；截圖要保持清楚，所以一次最多 20 張。 */
export const MAX_IMAGES = 20;
/** Claude 一個請求的上限是 32 MB；附件的 base64 加起來超過這個數字就不送（寧可講清楚，也不要拿到一個 413）。 */
export const MAX_REQUEST_BASE64 = 28 * 1024 * 1024;

const UPLOAD = /^[a-z0-9]{10,40}$/;
// extract/<upload>/<上傳的時間（36 進位毫秒）>_<亂數>-<種類>.json：時間寫在 key 裡，清理時不必把檔案讀出來
const KEY = /^extract\/([a-z0-9]{10,40})\/([a-z0-9]{6,12})_[a-z0-9]{1,12}-(image|document|text)\.json$/;

export const isUploadId = (id: string) => UPLOAD.test(String(id || ""));
/** 這個 key 是不是抽取的暫存（給了 upload 就還要是那一批的）。 */
export function isStagedKey(key: string, upload?: string): boolean {
  const m = KEY.exec(String(key || ""));
  return !!m && (!upload || m[1] === upload);
}
/** key 裡記著是哪一種（image／document／text）：檢查張數不必把檔案讀出來。 */
export const stagedKind = (key: string) => KEY.exec(String(key || ""))?.[3] || "";
/** 這一個是什麼時候放上去的（毫秒）；不是暫存的 key 回 NaN。 */
export const stagedAt = (key: string) => {
  const m = KEY.exec(String(key || ""));
  return m ? parseInt(m[2], 36) : NaN;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function stageFile(upload: string, file: Exclude<Extracted, { kind: "unsupported" }>): Promise<string> {
  const key = `extract/${upload}/${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8) || "0"}-${file.kind}.json`;
  await getStore().putMedia(key, enc.encode(JSON.stringify(file)), "application/json");
  return key;
}

/** 照 key 的順序讀回來（順序就是上傳的順序：截圖的先後要對）；讀不到的算 missing。 */
export async function loadStaged(keys: string[]): Promise<{ attachments: Extracted[]; missing: number }> {
  const store = getStore();
  const attachments: Extracted[] = [];
  let missing = 0;
  for (const key of keys) {
    if (!isStagedKey(key)) { missing += 1; continue; }
    const m = await store.getMedia(key);
    try {
      if (!m) throw new Error("missing");
      attachments.push(JSON.parse(dec.decode(m.bytes)) as Extracted);
    } catch {
      missing += 1;
    }
  }
  return { attachments, missing };
}

/** 讀完就刪（截圖裡有對方的電話與對話，不留著）。只刪抽取暫存的 key，別的東西一律不碰。 */
export async function dropStaged(keys: string[]): Promise<void> {
  const store = getStore();
  await Promise.allSettled((keys || []).filter((k) => isStagedKey(k)).map((k) => store.deleteMedia(k)));
}

/** 放上去超過這麼久還在的，就是沒讀成的（上傳到一半關掉網頁、抽取的工作中途掛掉）。抽取最久十五分鐘，留一點餘裕。 */
export const STALE_MS = 60 * 60 * 1000;

/**
 * 清掉沒讀成的暫存（`extract-sweep-cron` 每小時叫一次）：截圖裡有對方的電話與整段對話，
 * 讀完就刪是正常的路；這裡收的是沒走到「讀完」的那幾個——不清的話就一直留在媒體庫裡。
 */
export async function sweepStaged(now = Date.now(), maxAge = STALE_MS): Promise<string[]> {
  const store = getStore();
  const old = (await store.listMedia("extract/")).filter((k) => isStagedKey(k) && now - stagedAt(k) > maxAge);
  await Promise.allSettled(old.map((k) => store.deleteMedia(k)));
  return old;
}
