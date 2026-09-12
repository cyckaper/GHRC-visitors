import { nowISO } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { readSignbook } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 讀簽名簿的手寫字（背景函式，15 分鐘上限）。照片已經在 /api/signbook 存進媒體庫，
 * 這裡只帶 key——原圖好幾 MB，不必再從工作裡搬一次。
 */
export default backgroundHandler<{ visit_id: string; photo_key: string; media_type?: string }>("簽名簿", async (input) => {
  const store = getStore();
  const visit = await store.getVisit(String(input.visit_id));
  if (!visit) throw new Error("找不到這次參訪");
  const media = await store.getMedia(String(input.photo_key));
  if (!media) throw new Error(`找不到剛存的照片（${input.photo_key}）`);
  const b64 = Buffer.from(media.bytes).toString("base64");
  const read = await readSignbook(b64, input.media_type || media.contentType || "image/jpeg");
  visit.signbook = { photo_key: input.photo_key, transcript: read.transcript, entries: read.entries, read_at: nowISO() };
  visit.updated_at = nowISO();
  await store.putVisit(visit);
  await triggerDriveSync(visit.visit_id);
  return { photo_key: input.photo_key, ...read };
});
