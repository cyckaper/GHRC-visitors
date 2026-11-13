import { fail, isHeifBytes, json, nowISO, randomId, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { sniffImage } from "../lib/files.mts";
import { triggerDriveSync } from "../lib/drive.mts";
import { rotaKeyOk } from "./settings.mts";
import { loadLabs } from "./labs.mts";
import { LAB_PHOTO_MAX, LAB_PHOTO_ROOMS, isValidVisitId, labPhotoStats, orgLabel, photoVisitChoices, sanitizeLabPhotos } from "../../lib/visit.mjs";
import type { LabPhoto, Visit } from "../lib/types.mts";

/**
 * **研究室照片**（2026-11-02 明確要求：「要加一個不同人各個研究室拍的照片可以上傳的方法，作為資料庫可以後續使用」）。
 * 研究室的人從 `/photos?key=…` 上傳——**跟支援人力表同一把鑰匙**（中心自己人從 LINE 點開就能用，不必登入）；
 * 登入的後台也打得動。照片**不公開**：只有主辦端看得到，主辦端挑的才複製一份放上來賓專頁（`/api/materials` 的 `lab_photo`）。
 *
 * GET  ?key=                                   → 上傳頁的「哪一場」（已經到了的場次，新的在前；預設今天這一場）與五間研究室
 * GET  ?key=&visit_id=&device=                 → 這一場收到幾張（每一間、每一個人），與這台手機傳過的那幾張
 * GET  ?key=&visit_id=&device=&thumb=<id>      → 這台手機傳過的那一張的縮圖（別人傳的不給：照片只有主辦端看得到）
 * GET  ?all=1                       （後台）   → 每一場的研究室照片（「資料」分頁的照片庫）
 * POST multipart ?key=  {visit_id, room, by, device, name, w, h, taken, file, thumb}  → 存一張
 * POST ?key=  {action:"delete", visit_id, ids, device}  → 刪掉這台手機傳的（後台刪哪一張都可以）
 * POST        {action:"move", visit_id, ids, to}（後台） → 傳錯場的移到另一場（照片不必搬，清單換一場記）
 * POST ?key=  {action:"done", visit_id}                  → 這一批傳完了：備份到 Drive（一張一張觸發的話，一百張就是一百次整場備份）
 *
 * 清單 `visit.lab_photos` **只有這一支在寫**（visits.mts 的 KEPT），寫法一律 `store.updateVisit`：
 * 五間同時在傳，誰都不會把別人剛傳的那一張蓋掉。照片本身在 updateVisit 外面先存好，沒記進清單就刪掉。
 */
const MAX_BYTES = 4.5 * 1024 * 1024; // 一張（Netlify 一個請求 6 MB；上傳頁先縮到長邊 2560）
const THUMB_BYTES = 400 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const DEVICE = /^[a-z0-9]{8,64}$/;
const HEIC_MSG = "這張照片是 HEIC，沒有先在瀏覽器裡轉成 JPEG：請重新整理這一頁再選一次（會自動轉）；還是不行，請在相簿裡把它匯出成 JPEG";

/** 媒體庫 key 只能用英數字；原本的檔名（可以是中文）另外記。 */
const cleanName = (n: string) => String(n || "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, "").trim().slice(-120) || "photo.jpg";

export default async (req: Request) => {
  const admin = !requireAdmin(req);
  if (!admin && !(await rotaKeyOk(req))) return fail(403, "這個連結不對，或是已經換過了。請跟中心要新的網址。");
  const url = new URL(req.url);
  const store = getStore();

  if (req.method === "GET") {
    // 後台的照片庫：每一場的研究室照片，新的在前（device 不給——那是上傳的手機自己的）
    if (url.searchParams.get("all")) {
      if (!admin) return fail(403, "照片庫只有主辦端看得到");
      const visits = await store.listVisits();
      const photos = visits
        .flatMap((v) => sanitizeLabPhotos((v as any).lab_photos).map(({ device: _d, ...p }) => ({ ...p, visit_id: v.visit_id, date: v.date, org: orgLabel(v.org), org_local: v.org?.name_local || "" })))
        // 新的場次在前；同一場照拍攝時間（沒有就上傳時間）由早到晚，跟當天的順序一樣
        .sort((a, b) => b.date.localeCompare(a.date) || a.visit_id.localeCompare(b.visit_id) || String(a.taken || a.at).localeCompare(String(b.taken || b.at)));
      return json({ ok: true, photos });
    }
    const visitId = url.searchParams.get("visit_id") || "";
    if (!visitId) {
      const visits = await store.listVisits();
      const labs = await loadLabsSafe();
      return json({ ok: true, ...photoVisitChoices(visits, new Date()), rooms: LAB_PHOTO_ROOMS, labs });
    }
    if (!isValidVisitId(visitId)) return fail(400, "visit_id 格式不對");
    const v = await store.getVisit(visitId);
    if (!v) return fail(404, "找不到這一場");
    const list = sanitizeLabPhotos((v as any).lab_photos);
    const device = url.searchParams.get("device") || "";
    const thumb = url.searchParams.get("thumb") || "";
    if (thumb) {
      const p = list.find((x) => x.id === thumb);
      // 別人傳的照片不給（只有主辦端看得到）；自己這台手機傳的可以看縮圖
      if (!p || (!admin && (!DEVICE.test(device) || p.device !== device))) return fail(404, "找不到這一張");
      const m = await store.getMedia(p.thumb || p.key);
      if (!m) return fail(404, "找不到這一張");
      return new Response(m.bytes as BodyInit, { headers: { "content-type": m.contentType || "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } });
    }
    const mine = DEVICE.test(device) ? list.filter((p) => p.device === device).map((p) => ({ id: p.id, room: p.room, name: p.name, at: p.at })) : [];
    return json({ ok: true, visit_id: v.visit_id, date: v.date, org: orgLabel(v.org), stats: labPhotoStats(list), mine });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");

  // ── 上傳一張 ──
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, "照片沒有傳完整，請再試一次");
    }
    const visitId = String(form.get("visit_id") || "");
    const room = String(form.get("room") || "");
    const by = String(form.get("by") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const device = String(form.get("device") || "");
    const file = form.get("file");
    const thumbFile = form.get("thumb");
    if (!isValidVisitId(visitId)) return fail(400, "請先選是哪一場");
    if (!LAB_PHOTO_ROOMS.includes(room)) return fail(400, "請選是哪一間（301–305，或中心）");
    if (!by) return fail(400, "請寫你的名字（記在這台手機，下次不用再填）");
    if (!file || typeof file === "string") return fail(400, "沒有收到照片");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) return fail(400, "這張照片是空的");
    if (bytes.length > MAX_BYTES) return fail(413, "這張照片太大（超過 4.5 MB）：請重新整理這一頁再選一次（會自動縮小）");
    if (isHeifBytes(bytes)) return fail(415, HEIC_MSG);
    const type = sniffImage(bytes);
    if (!TYPES[type]) return fail(415, "只收照片（JPEG、PNG、WebP）");
    let thumb: Uint8Array | null = null;
    if (thumbFile && typeof thumbFile !== "string") {
      const t = new Uint8Array(await thumbFile.arrayBuffer());
      if (t.length && t.length <= THUMB_BYTES && TYPES[sniffImage(t)]) thumb = t;
    }
    const visit = await store.getVisit(visitId);
    if (!visit) return fail(404, "找不到這一場");
    if (photoVisitChoices([visit]).visits.length === 0) return fail(409, "這一場還沒到：照片等當天再傳");
    if (((visit as any).lab_photos || []).length >= LAB_PHOTO_MAX) return fail(400, `這一場已經有 ${LAB_PHOTO_MAX} 張了，傳不下了；請跟中心說`);

    const id = `${Date.now().toString(36)}${randomId(6)}`;
    const key = `labphotos/${visitId}/${room}-${id}.${TYPES[type]}`;
    const thumbKey = thumb ? `labphotos/${visitId}/${room}-${id}-t.${TYPES[sniffImage(thumb)]}` : "";
    const name = cleanName(String(form.get("name") || (file as File).name || ""));
    await store.putMedia(key, bytes, type, name);
    if (thumb) await store.putMedia(thumbKey, thumb, sniffImage(thumb), name);
    const entry: LabPhoto = {
      id,
      room,
      by,
      name,
      key,
      thumb: thumbKey,
      type,
      bytes: bytes.length,
      w: Math.max(0, Math.round(Number(form.get("w")) || 0)),
      h: Math.max(0, Math.round(Number(form.get("h")) || 0)),
      at: nowISO(),
      // 拍攝時間（上傳頁從 EXIF 讀的，相機上的時間）：照片庫照這個排；讀不到就空著
      taken: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(form.get("taken") || "")) ? String(form.get("taken")) : "",
      device: DEVICE.test(device) ? device : "",
    };
    let full = false;
    let saved: Visit | null = null;
    try {
      saved = await store.updateVisit(visitId, (v) => {
        const list = sanitizeLabPhotos((v as any).lab_photos);
        full = list.length >= LAB_PHOTO_MAX;
        if (full) return false;
        (v as any).lab_photos = [...list, entry];
      });
    } catch (e: any) {
      // 同一時間好幾個人在傳、一直撞在一起：照片先拿掉，請手機等一下再傳一次（上傳頁會自己重試）
      await dropFiles([key, thumbKey]);
      return fail(503, String(e?.message || e), { retry: true });
    }
    if (!saved || full) {
      await dropFiles([key, thumbKey]);
      return saved ? fail(400, `這一場已經有 ${LAB_PHOTO_MAX} 張了，傳不下了；請跟中心說`) : fail(404, "找不到這一場");
    }
    return json({ ok: true, photo: { id, room, name, at: entry.at }, stats: labPhotoStats(sanitizeLabPhotos((saved as any).lab_photos)) });
  }

  const body = await readJSON<{ action?: string; visit_id?: string; ids?: unknown; id?: string; device?: string; to?: string }>(req);
  const visitId = String(body?.visit_id || "");
  if (!isValidVisitId(visitId)) return fail(400, "visit_id 格式不對");
  const ids = new Set((Array.isArray(body?.ids) ? body!.ids : body?.id ? [body.id] : []).map(String));

  // 這一批傳完了：整場備份到 Drive 一次（照片一張一張觸發的話，傳一百張就是一百次整場備份）
  if (body?.action === "done") {
    if (!(await store.getVisit(visitId))) return fail(404, "找不到這一場");
    await triggerDriveSync(visitId);
    return json({ ok: true });
  }

  if (body?.action === "delete") {
    if (!ids.size) return fail(400, "要刪哪幾張？");
    const device = String(body.device || "");
    if (!admin && !DEVICE.test(device)) return fail(403, "只能刪這台手機傳的照片");
    let gone: ReturnType<typeof sanitizeLabPhotos> = [];
    let refused = false;
    const saved = await store.updateVisit(visitId, (v) => {
      const list = sanitizeLabPhotos((v as any).lab_photos);
      // 研究室的人只刪得了自己這台手機傳的；主辦端哪一張都可以
      const hit = list.filter((p) => ids.has(p.id));
      refused = !admin && hit.some((p) => p.device !== device);
      gone = refused ? [] : hit;
      if (!gone.length) return false;
      (v as any).lab_photos = list.filter((p) => !ids.has(p.id));
    });
    if (!saved) return fail(404, "找不到這一場");
    if (refused) return fail(403, "只能刪這台手機傳的照片");
    // 放上專頁的那一份（materials）是另一個檔：留著，專頁上要拿掉在後台的合照那裡拿
    await dropFiles(gone.flatMap((p) => [p.key, p.thumb]));
    return json({ ok: true, deleted: gone.map((p) => p.id), stats: labPhotoStats(sanitizeLabPhotos((saved as any).lab_photos)) });
  }

  // 傳錯場：清單換一場記（照片檔不必搬：key 只是名字，哪一場用到它看清單）
  if (body?.action === "move") {
    if (!admin) return fail(403, "移到另一場要在後台做");
    const to = String(body.to || "");
    if (!isValidVisitId(to) || to === visitId) return fail(400, "要移到哪一場？");
    const target = await store.getVisit(to);
    if (!target) return fail(404, "找不到要移過去的那一場");
    let moving: LabPhoto[] = [];
    let full = false;
    // 先加進新的那一場，再從原本那一場拿掉：中間出事頂多兩邊都有，不會兩邊都沒有
    const source = await store.getVisit(visitId);
    if (!source) return fail(404, "找不到這一場");
    moving = sanitizeLabPhotos((source as any).lab_photos).filter((p) => ids.has(p.id)) as LabPhoto[];
    if (!moving.length) return fail(400, "要移哪幾張？");
    await store.updateVisit(to, (v) => {
      const list = sanitizeLabPhotos((v as any).lab_photos);
      const have = new Set(list.map((p) => p.id));
      const add = moving.filter((p) => !have.has(p.id));
      full = list.length + add.length > LAB_PHOTO_MAX;
      if (full || !add.length) return false;
      // 放上專頁的那一份是原本那一場的當天資料，跟著過去就不對了
      (v as any).lab_photos = [...list, ...add.map(({ published: _p, ...p }) => p)];
    });
    if (full) return fail(400, `那一場放不下了（最多 ${LAB_PHOTO_MAX} 張）`);
    const saved = await store.updateVisit(visitId, (v) => {
      (v as any).lab_photos = sanitizeLabPhotos((v as any).lab_photos).filter((p) => !ids.has(p.id));
    });
    await triggerDriveSync(to);
    return json({ ok: true, moved: moving.map((p) => p.id), to, stats: labPhotoStats(sanitizeLabPhotos((saved as any)?.lab_photos)) });
  }

  return fail(400, "action 需要是 delete、move 或 done");
};

async function dropFiles(keys: string[]): Promise<void> {
  const store = getStore();
  for (const k of keys) if (k) await store.deleteMedia(k).catch(() => {});
}

/** 上傳頁的五間（名稱與顏色跟其他頁同一份）；讀不到就只列房號。 */
async function loadLabsSafe(): Promise<{ room: string; name_zh: string; color: string; lead: string }[]> {
  try {
    const labs = await loadLabs();
    return (labs.labs || []).map((l: any) => ({ room: String(l.room), name_zh: l.name_zh || "", color: l.color || "", lead: l.lead?.name_zh || "" }));
  } catch {
    return [];
  }
}
