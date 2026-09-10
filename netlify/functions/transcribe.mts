import { env, fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { extractDictation, transcribeAudio } from "../lib/ai.mts";
import { sanitizeResponse } from "../../lib/visit.mjs";

/**
 * 主持人三十秒口述（工作包 4.3 動作二）。
 *  POST multipart: audio=<file>, visit_id                        → 存音檔、Whisper 轉文字、抽取欄位（存在 visit.dictation）
 *  POST JSON {visit_id, audio_base64, mime}                       → 同上
 *  POST JSON {visit_id, transcript}                               → 不錄音，直接用打字的逐字稿抽取
 *  POST JSON {visit_id, action:"save", extracted:{...}}           → 確認後寫一筆 responses（來源 dictation）
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const store = getStore();
  const ct = req.headers.get("content-type") || "";

  let visitId = "";
  let audio: { bytes: Uint8Array; mime: string } | null = null;
  let transcript = "";
  let body: any = null;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    visitId = String(form.get("visit_id") || "");
    const file = form.get("audio");
    if (file && typeof file !== "string") audio = { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || "audio/webm" };
    transcript = String(form.get("transcript") || "");
  } else {
    body = await readJSON<any>(req);
    visitId = String(body?.visit_id || "");
    if (body?.audio_base64) audio = { bytes: new Uint8Array(Buffer.from(String(body.audio_base64).replace(/^data:[^,]+,/, ""), "base64")), mime: String(body.mime || "audio/webm") };
    transcript = String(body?.transcript || "");
  }
  if (!visitId) return fail(400, "需要 visit_id");
  const visit = await store.getVisit(visitId);
  if (!visit) return fail(404, "找不到這次參訪");

  if (body?.action === "save") {
    const ex = body.extracted || visit.dictation?.extracted;
    if (!ex) return fail(400, "沒有可儲存的抽取結果");
    visit.dictation = { ...visit.dictation, extracted: ex };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await store.appendResponse(
      sanitizeResponse({
        visit_id: visit.visit_id,
        source: "dictation",
        anonymous: false,
        name: ex.who_came || "",
        most_wanted_rooms: ex.most_wanted_rooms || [],
        note: [ex.questions?.length ? `問題：${ex.questions.join("；")}` : "", ex.cooperation ? `合作：${ex.cooperation}` : "", ex.follow_ups?.length ? `後續：${ex.follow_ups.join("；")}` : ""].filter(Boolean).join("\n"),
      }),
    );
    return json({ ok: true });
  }

  let audioKey = visit.dictation?.audio_key;
  if (audio) {
    if (audio.bytes.length > 4.5 * 1024 * 1024) return fail(413, "音檔超過 4.5 MB");
    const ext = audio.mime.includes("mp4") || audio.mime.includes("m4a") ? "m4a" : audio.mime.includes("ogg") ? "ogg" : audio.mime.includes("wav") ? "wav" : "webm";
    audioKey = `dictation/${visit.visit_id}/${Date.now()}.${ext}`;
    await store.putMedia(audioKey, audio.bytes, audio.mime);
    if (!transcript) {
      try {
        transcript = await transcribeAudio(audio.bytes, audio.mime, env("DICTATION_LANGUAGE") || "zh");
      } catch (e: any) {
        visit.dictation = { ...visit.dictation, audio_key: audioKey, recorded_at: nowISO() };
        visit.updated_at = nowISO();
        await store.putVisit(visit);
        return fail(502, `音檔已存（${audioKey}），但轉文字失敗：${e?.message || e}。可改在下方直接輸入逐字稿。`, { audio_key: audioKey });
      }
    }
  }
  if (!transcript.trim()) return fail(400, "需要音檔或逐字稿");
  try {
    const extracted = await extractDictation(transcript, visit);
    visit.dictation = { audio_key: audioKey, transcript, extracted, recorded_at: visit.dictation?.recorded_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, audio_key: audioKey, transcript, extracted });
  } catch (e: any) {
    visit.dictation = { ...visit.dictation, audio_key: audioKey, transcript, recorded_at: visit.dictation?.recorded_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return fail(502, `逐字稿已存，但抽取失敗：${e?.message || e}`, { transcript });
  }
};
