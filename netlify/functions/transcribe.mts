import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { sanitizeResponse } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 主持人三十秒口述（工作包 4.3 動作二）。音檔先存下來，Whisper 轉文字與抽取交給
 * transcribe-background——兩件事加起來一般函式的 10 秒撐不住。
 *
 *  GET  /api/transcribe?job=<id>                                  → 進度與結果
 *  POST multipart: audio=<file>, visit_id                         → 202 {job_id, audio_key}
 *  POST JSON {visit_id, audio_base64, mime}                       → 同上
 *  POST JSON {visit_id, transcript}                               → 不錄音，直接用打字的逐字稿抽取
 *  POST JSON {visit_id, action:"save", extracted:{...}}           → 確認後寫一筆 responses（來源 dictation）
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "口述");
  if (req.method !== "POST") return fail(405, "method not allowed");
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
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true });
  }

  let audioKey = visit.dictation?.audio_key;
  if (audio) {
    if (audio.bytes.length > 4.5 * 1024 * 1024) return fail(413, "音檔超過 4.5 MB");
    const ext = audio.mime.includes("mp4") || audio.mime.includes("m4a") ? "m4a" : audio.mime.includes("ogg") ? "ogg" : audio.mime.includes("wav") ? "wav" : "webm";
    audioKey = `dictation/${visit.visit_id}/${Date.now()}.${ext}`;
    await store.putMedia(audioKey, audio.bytes, audio.mime);
    // 音檔先掛到這一場：後面轉文字失敗也不會弄丟它
    visit.dictation = { ...visit.dictation, audio_key: audioKey, recorded_at: visit.dictation?.recorded_at || nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
  }
  if (!audio && !transcript.trim()) return fail(400, "需要音檔或逐字稿");
  const started = await startBackground("transcribe", { visit_id: visit.visit_id, audio_key: audio ? audioKey : "", mime: audio?.mime || "", transcript }, req);
  const out = await started.json();
  return json({ ...out, audio_key: audioKey }, { status: started.status });
};
