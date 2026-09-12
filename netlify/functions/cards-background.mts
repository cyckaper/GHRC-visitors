import { getStore } from "../lib/store.mts";
import { readCard } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";

/**
 * 讀名片（背景函式，15 分鐘上限）。原圖已經在 /api/cards 存進媒體庫，這裡只帶 key。
 * 讀完**不寫名單**：結果回給人逐欄確認，按了「加進名單」才走 /api/cards action:"save"。
 */
export default backgroundHandler<{ visit_id: string; photo_key: string; media_type?: string }>("名片", async (input) => {
  const store = getStore();
  const media = await store.getMedia(String(input.photo_key));
  if (!media) throw new Error(`找不到剛存的照片（${input.photo_key}）`);
  const b64 = Buffer.from(media.bytes).toString("base64");
  const read = await readCard(b64, input.media_type || media.contentType || "image/jpeg");
  return { photo_key: input.photo_key, ...read };
});
