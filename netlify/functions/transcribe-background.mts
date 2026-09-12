import { env, nowISO } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { extractDictation, transcribeAudio } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 口述轉文字與抽取（背景函式，15 分鐘上限）。音檔已經在 /api/transcribe 存進媒體庫，這裡只帶 key。
 *
 * 抽取失敗時**不算整件失敗**：逐字稿本身就有價值（是現場講過一次的內容），
 * 所以照樣回傳、照樣存進這一場，只在結果裡附一句 warning，讓後台把逐字稿填出來給人手改。
 */
export default backgroundHandler<{ visit_id: string; audio_key?: string; mime?: string; transcript?: string }>("口述", async (input) => {
  const store = getStore();
  const visit = await store.getVisit(String(input.visit_id));
  if (!visit) throw new Error("找不到這次參訪");
  const audioKey = String(input.audio_key || "") || visit.dictation?.audio_key;
  let transcript = String(input.transcript || "").trim();

  if (!transcript && input.audio_key) {
    const media = await store.getMedia(String(input.audio_key));
    if (!media) throw new Error(`找不到剛存的音檔（${input.audio_key}）`);
    transcript = await transcribeAudio(media.bytes, input.mime || media.contentType || "audio/webm", env("DICTATION_LANGUAGE") || "zh");
  }
  if (!transcript.trim()) throw new Error("音檔轉不出文字，可改在下方直接輸入逐字稿");

  try {
    const extracted = await extractDictation(transcript, visit);
    visit.dictation = { audio_key: audioKey, transcript, extracted, recorded_at: visit.dictation?.recorded_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return { audio_key: audioKey, transcript, extracted };
  } catch (e: any) {
    visit.dictation = { ...visit.dictation, audio_key: audioKey, transcript, recorded_at: visit.dictation?.recorded_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return { audio_key: audioKey, transcript, extracted: null, warning: `逐字稿已存，但抽取失敗：${e?.message || e}` };
  }
});
