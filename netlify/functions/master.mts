import { fail, json, nowISO, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";

/**
 * 母簡報（slim master）放站台：後台「上傳母簡報」一次，之後「產生簡報 .pptx」直接抓，不必每次從電腦選檔。
 * 切成 ≤ 4 MB 的分塊存進媒體庫（Netlify 函式單次請求／回應上限 6 MB），一律要 ADMIN_TOKEN。
 *
 * GET    /api/master                                              → { master: manifest | null }
 * GET    /api/master?part=i                                       → 第 i 塊（binary）
 * POST   /api/master?upload=<id>&part=i&total=n                   body = 該塊的原始 bytes（第 0 塊必須是 zip 開頭 PK）
 * POST   /api/master?upload=<id>&commit=1&total=n&name=<file>     → 檢查分塊齊了，寫 manifest，刪掉舊版分塊
 * DELETE /api/master                                              → 移除
 *
 * 影片：站台上那一份是瘦過的（五支影片就三百多 MB），影片在上傳時抽掉、**另外存**，產簡報時放回選到的那幾頁
 * （實際回報：「影片都不能跑」；pptx.mjs 的 slimDeck keepVideos／Deck.restoreMedia）：
 * POST   /api/master?upload=<id>&media=m&part=i&total=k           body = 第 m 支影片的第 i 塊
 * POST   …commit…                                                 body（JSON，可省）= { videos: { slides, media } }
 * GET    /api/master?videos=1                                     → { videos: { slides: [{ path, n, xml, rels }], media: [{ part, content_type, size, chunks }] } | null }
 * GET    /api/master?media=m&part=i                               → 第 m 支影片的第 i 塊
 */
const MANIFEST = "master/manifest.json";
const PART_SIZE = 4 * 1024 * 1024;
const MAX_PART = PART_SIZE + 1024;
const MAX_PARTS = 64; // 64 × 4 MB ≈ 256 MB；正常的 slim master 在 30 MB 左右
const MAX_MEDIA = 32; // 一份母簡報最多幾支影片
const MAX_MEDIA_PARTS = 128; // 一支影片最多 512 MB
const MAX_MEDIA_TOTAL = 256; // 全部影片加起來最多 1 GB（原始母簡報五支約 300 MB）

interface VideoSummary {
  count: number;
  bytes: number;
  slides: number[];
  chunks: number[];
}
interface Manifest {
  upload_id: string;
  name: string;
  size: number;
  parts: number;
  part_size: number;
  uploaded_at: string;
  videos?: VideoSummary;
}
interface VideoRel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
interface VideoSlide {
  path: string;
  n: number;
  xml: string;
  rels: VideoRel[];
}
interface VideoMedia {
  part: string;
  content_type: string;
  size: number;
  chunks: number;
}

type S = ReturnType<typeof getStore>;
const partKey = (id: string, i: number) => `master/${id}/part-${i}`;
const mediaKey = (id: string, m: number, i: number) => `master/${id}/media-${m}-part-${i}`;
const videosKey = (id: string) => `master/${id}/videos.json`;

async function readJsonMedia<T>(store: S, key: string): Promise<T | null> {
  const m = await store.getMedia(key);
  if (!m) return null;
  try {
    return JSON.parse(new TextDecoder().decode(m.bytes)) as T;
  } catch {
    return null;
  }
}
const readManifest = (store: S) => readJsonMedia<Manifest>(store, MANIFEST);

/** 一次刪幾個（影片的分塊有幾十塊，一塊一塊等會超過一般函式的 10 秒）。 */
async function removeKeys(store: S, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 8) await Promise.all(keys.slice(i, i + 8).map((k) => store.deleteMedia(k).catch(() => {})));
}
async function removeParts(store: S, man: Manifest): Promise<void> {
  const keys = Array.from({ length: man.parts }, (_, i) => partKey(man.upload_id, i));
  (man.videos?.chunks || []).forEach((k, m) => { for (let i = 0; i < k; i++) keys.push(mediaKey(man.upload_id, m, i)); });
  if (man.videos?.slides?.length) keys.push(videosKey(man.upload_id));
  await removeKeys(store, keys);
}

/** "../media/media1.mp4"（從 ppt/slides/slideN.xml 看）→ "ppt/media/media1.mp4"。 */
function resolve(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== "." && seg !== "") base.push(seg);
  }
  return base.join("/");
}

/** commit 帶來的影片清單：格式不對就回錯誤訊息（字串）。 */
function checkVideos(v: unknown): { slides: VideoSlide[]; media: VideoMedia[] } | string {
  const o = v as { slides?: unknown; media?: unknown };
  if (!o || !Array.isArray(o.slides) || !Array.isArray(o.media)) return "影片清單格式不對";
  if (o.media.length > MAX_MEDIA) return `影片超過 ${MAX_MEDIA} 支`;
  if (o.slides.length > 64) return "影片頁太多";
  const media: VideoMedia[] = [];
  for (const x of o.media as Record<string, unknown>[]) {
    const part = String(x?.part ?? ""), ct = String(x?.content_type ?? ""), size = Number(x?.size), chunks = Number(x?.chunks);
    if (!/^ppt\/media\/[\w.-]{1,100}$/.test(part)) return `影片檔名不對：${part.slice(0, 60)}`;
    if (!/^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(ct)) return "影片的檔案類型不對";
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_MEDIA_PARTS) return `影片 ${part} 的分塊數不對（最多 ${MAX_MEDIA_PARTS} 塊）`;
    if (!Number.isInteger(size) || size < 1 || size > chunks * PART_SIZE || size <= (chunks - 1) * PART_SIZE) return `影片 ${part} 的大小不對`;
    if (media.some((m) => m.part === part)) return `影片 ${part} 重複`;
    media.push({ part, content_type: ct, size, chunks });
  }
  if (media.reduce((n, m) => n + m.chunks, 0) > MAX_MEDIA_TOTAL) return "影片加起來太大";
  const parts = new Set(media.map((m) => m.part));
  const slides: VideoSlide[] = [];
  let xmlBytes = 0;
  for (const x of o.slides as Record<string, unknown>[]) {
    const path = String(x?.path ?? ""), n = Number(x?.n), xml = x?.xml;
    if (!/^ppt\/slides\/slide\d{1,4}\.xml$/.test(path)) return "影片頁的路徑不對";
    if (!Number.isInteger(n) || n < 1 || n > 9999) return "影片頁的頁次不對";
    if (typeof xml !== "string" || !xml.includes("<p:sld") || xml.length > 2_000_000) return `第 ${n} 頁的內容不對`;
    xmlBytes += xml.length;
    if (!Array.isArray(x.rels) || !x.rels.length || x.rels.length > 16) return `第 ${n} 頁的影片關聯不對`;
    const rels: VideoRel[] = [];
    for (const r of x.rels as Record<string, unknown>[]) {
      const id = String(r?.id ?? ""), type = String(r?.type ?? ""), target = String(r?.target ?? ""), external = r?.external === true;
      if (!/^[\w-]{1,32}$/.test(id) || !/^https?:\/\/\S{1,300}$/.test(type) || !target || target.length > 1000) return `第 ${n} 頁的影片關聯不對`;
      if (!external && !parts.has(resolve(path, target))) return `第 ${n} 頁指到的影片沒有上傳：${target.slice(0, 60)}`;
      rels.push({ id, type, target, external });
    }
    slides.push({ path, n, xml, rels });
  }
  if (xmlBytes > 4_000_000) return "影片頁的內容太大";
  return { slides, media };
}

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const store = getStore();

  if (req.method === "GET") {
    const man = await readManifest(store);
    if (url.searchParams.get("videos")) {
      if (!man?.videos?.slides?.length) return json({ ok: true, videos: null });
      const videos = await readJsonMedia<{ slides: VideoSlide[]; media: VideoMedia[] }>(store, videosKey(man.upload_id));
      return json({ ok: true, videos });
    }
    const mediaParam = url.searchParams.get("media");
    const part = url.searchParams.get("part");
    if (part === null && mediaParam === null) return json({ ok: true, master: man });
    if (!man) return fail(404, "站台上沒有母簡報");
    const i = Number(part);
    if (mediaParam !== null) {
      const m = Number(mediaParam);
      const chunks = man.videos?.chunks?.[m];
      if (!Number.isInteger(m) || !chunks) return fail(404, "站台上沒有這一支影片");
      if (!Number.isInteger(i) || i < 0 || i >= chunks) return fail(400, "part 不對");
      const got = await store.getMedia(mediaKey(man.upload_id, m, i));
      if (!got) return fail(404, `影片缺第 ${i + 1} 塊，請到「設定」重新上傳母簡報`);
      return new Response(got.bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=3600" } });
    }
    if (!Number.isInteger(i) || i < 0 || i >= man.parts) return fail(400, "part 不對");
    const m = await store.getMedia(partKey(man.upload_id, i));
    if (!m) return fail(404, `母簡報缺第 ${i} 塊，請重新上傳`);
    return new Response(m.bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=3600" } });
  }

  if (req.method === "DELETE") {
    const man = await readManifest(store);
    if (man) {
      await removeParts(store, man);
      await store.deleteMedia(MANIFEST).catch(() => {});
    }
    return json({ ok: true });
  }

  if (req.method === "POST") {
    const uploadId = url.searchParams.get("upload") || "";
    if (!/^[\w-]{4,40}$/.test(uploadId)) return fail(400, "upload id 不對");
    const total = Number(url.searchParams.get("total"));
    const mediaParam = url.searchParams.get("media");

    if (mediaParam !== null) {
      // 影片的一塊
      const m = Number(mediaParam);
      if (!Number.isInteger(m) || m < 0 || m >= MAX_MEDIA) return fail(400, "media 不對");
      if (!Number.isInteger(total) || total < 1 || total > MAX_MEDIA_PARTS) return fail(400, `total 需要是 1–${MAX_MEDIA_PARTS}`);
      const i = Number(url.searchParams.get("part"));
      if (!Number.isInteger(i) || i < 0 || i >= total) return fail(400, "part 不對");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length) return fail(400, "空的分塊");
      if (bytes.length > MAX_PART) return fail(413, "分塊超過 4 MB");
      await store.putMedia(mediaKey(uploadId, m, i), bytes, "application/octet-stream");
      return json({ ok: true, media: m, part: i });
    }

    if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return fail(400, `total 需要是 1–${MAX_PARTS}`);

    if (url.searchParams.get("commit")) {
      let size = 0;
      for (let i = 0; i < total; i++) {
        const m = await store.getMedia(partKey(uploadId, i));
        if (!m) return fail(400, `缺第 ${i + 1} 塊，請重新上傳`);
        size += m.bytes.length;
      }
      // 影片：清單跟著 commit 來（舊版後台不帶，就是沒有影片）。每一支只看最後一塊在不在、大小對不對——
      // 一塊一塊讀回來要好幾十秒，一般函式只有 10 秒；分塊是照順序傳的，最後一塊在，前面的就都在
      // 沒帶清單＝舊版後台上傳的（影片沒有存）；帶了空的清單＝這一份本來就沒有影片
      let videos: { slides: VideoSlide[]; media: VideoMedia[] } | null = null;
      let checkedVideos = false;
      const text = await req.text().catch(() => "");
      if (text.trim()) {
        let body: { videos?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          return fail(400, "commit 的內容不是 JSON");
        }
        if (body.videos) {
          const checked = checkVideos(body.videos);
          if (typeof checked === "string") return fail(400, checked);
          checkedVideos = true;
          if (checked.slides.length) {
            for (const [m, v] of checked.media.entries()) {
              const last = await store.getMedia(mediaKey(uploadId, m, v.chunks - 1));
              if (!last) return fail(400, `影片 ${v.part.split("/").pop()} 沒有傳完，請重新上傳`);
              if ((v.chunks - 1) * PART_SIZE + last.bytes.length !== v.size) return fail(400, `影片 ${v.part.split("/").pop()} 的大小對不上，請重新上傳`);
            }
            videos = checked;
          }
        }
      }
      const name = (url.searchParams.get("name") || "slim-master.pptx").split(/[\\/]/).pop()!.slice(0, 80) || "slim-master.pptx";
      const prev = await readManifest(store);
      const man: Manifest = { upload_id: uploadId, name, size, parts: total, part_size: PART_SIZE, uploaded_at: nowISO() };
      if (videos) {
        await store.putMedia(videosKey(uploadId), new TextEncoder().encode(JSON.stringify(videos)), "application/json");
        man.videos = { count: videos.media.length, bytes: videos.media.reduce((n, v) => n + v.size, 0), slides: videos.slides.map((s) => s.n), chunks: videos.media.map((v) => v.chunks) };
      } else if (checkedVideos) man.videos = { count: 0, bytes: 0, slides: [], chunks: [] };
      await store.putMedia(MANIFEST, new TextEncoder().encode(JSON.stringify(man)), "application/json");
      if (prev && prev.upload_id !== uploadId) await removeParts(store, prev);
      return json({ ok: true, master: man });
    }

    const i = Number(url.searchParams.get("part"));
    if (!Number.isInteger(i) || i < 0 || i >= total) return fail(400, "part 不對");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return fail(400, "空的分塊");
    if (bytes.length > MAX_PART) return fail(413, "分塊超過 4 MB");
    if (i === 0 && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) return fail(400, "這不是 .pptx 檔（不是 zip 開頭）");
    await store.putMedia(partKey(uploadId, i), bytes, "application/octet-stream");
    return json({ ok: true, part: i });
  }

  return fail(405, "method not allowed");
};
