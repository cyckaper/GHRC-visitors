import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { hasNotes, sanitizeDictation } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * 主持人的訪後紀錄（工作包 4.3 動作二）：三十秒口述，或直接一項一項打重點，再請 AI 寫成完整紀錄
 * （明確指示：「輸入簡要說明要分項次，之後由 AI 產生出完整紀錄」）。
 * 音檔先存下來，Whisper 轉文字與抽取交給 transcribe-background；完整紀錄交給 record-background——
 * 都是一般函式的 10 秒撐不住的事。
 *
 *  GET  /api/transcribe?job=<id>                                  → 進度與結果（轉文字、抽取、完整紀錄都是這一支）
 *  POST multipart: audio=<file>, visit_id                         → 202 {job_id, audio_key}
 *  POST JSON {visit_id, audio_base64, mime}                       → 同上
 *  POST JSON {visit_id, transcript}                               → 不錄音，直接用打字的逐字稿抽取
 *  POST JSON {visit_id, action:"save", extracted:{...}}           → 主持人確認過的重點（一項一項）存進這一場
 *  POST JSON {visit_id, action:"record"}                          → 202 {job_id}；AI 依存好的重點寫完整紀錄
 *  POST JSON {visit_id, action:"record_save", text}               → 主持人手改過的完整紀錄（空的＝拿掉）
 *
 * 以前「存入」時另外寫一筆 responses（來源 dictation）：存一次多一筆，而且主持人記下的「最想看哪一間」
 * 被當成來賓自己說的又算了一次。現在不寫了——重點本來就在 visit.dictation，摘要、歷次統計、感謝信都從那裡讀。
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
    const ex = sanitizeDictation(body.extracted || visit.dictation?.extracted);
    if (!hasNotes(ex)) return fail(400, "還沒有任何重點：先錄音、貼逐字稿，或在下面一項一項打");
    const at = nowISO();
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      v.dictation = { ...v.dictation, extracted: ex, saved_at: at };
      v.updated_at = at;
    });
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, dictation: saved?.dictation });
  }

  if (body?.action === "record") {
    const d = visit.dictation || {};
    if (!hasNotes(d.extracted)) return fail(400, "還沒有存好的重點：先在上面一項一項打好，按「存入」");
    return startBackground("record", { visit_id: visit.visit_id }, req);
  }

  if (body?.action === "record_save") {
    const text = String(body.text ?? "").replace(/\r\n/g, "\n").slice(0, 60000);
    const at = nowISO();
    const saved = await store.updateVisit(visit.visit_id, (v) => {
      const d = { ...(v.dictation || {}) };
      if (!text.trim()) delete d.record;
      else d.record = { text, at: d.record?.at || at, edited: true, edited_at: at };
      v.dictation = d;
      v.updated_at = at;
    });
    await triggerDriveSync(visit.visit_id);
    return json({ ok: true, record: saved?.dictation?.record || null });
  }

  let audioKey = visit.dictation?.audio_key;
  if (audio) {
    if (audio.bytes.length > 4.5 * 1024 * 1024) return fail(413, "音檔超過 4.5 MB");
    const ext = audio.mime.includes("mp4") || audio.mime.includes("m4a") ? "m4a" : audio.mime.includes("ogg") ? "ogg" : audio.mime.includes("wav") ? "wav" : "webm";
    audioKey = `dictation/${visit.visit_id}/${Date.now()}.${ext}`;
    await store.putMedia(audioKey, audio.bytes, audio.mime);
    // 音檔先掛到這一場：後面轉文字失敗也不會弄丟它
    const k = audioKey;
    await store.updateVisit(visit.visit_id, (v) => {
      v.dictation = { ...v.dictation, audio_key: k, recorded_at: v.dictation?.recorded_at || nowISO() };
      v.updated_at = nowISO();
    });
  }
  if (!audio && !transcript.trim()) return fail(400, "需要音檔或逐字稿");
  const started = await startBackground("transcribe", { visit_id: visit.visit_id, audio_key: audio ? audioKey : "", mime: audio?.mime || "", transcript }, req);
  const out = await started.json();
  return json({ ...out, audio_key: audioKey }, { status: started.status });
};
