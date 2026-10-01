import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";

/**
 * 五間研究室的老師卡片內容（來賓專頁的卡片、`/lab/<房號>` 介紹頁、中心首頁 `/`、後台「設定」分頁都吃這一支）。
 *
 * GET  /api/labs                       （公開）合併後的五間：`public/data/labs.json` ＋ 後台改過的部分
 * POST /api/labs {room, fields}        （admin）改一間；只存**改過的欄位**，沒改的仍然跟著 repo 裡那一份走
 * POST /api/labs {room, photo:{data}}  （admin）上傳老師照片（存 `labs/<房號>/<ts>.jpg`，`/api/media` 對它公開）
 * POST /api/labs {room, reset:true}    （admin）把這一間改回 repo 裡的原始內容
 *
 * **為什麼不直接改 `public/data/labs.json`**：那是 repo 裡的檔案，站台上的後台寫不進去
 * （要 commit、要重新發佈）。老師要修自己那一句話不該走 GitHub——所以改過的部分存在資料層
 * （`labs.json` 這個 key），讀的時候疊在靜態那一份上面。repo 那一份仍然是底稿與預設值。
 *
 * 待確認事項 1（各老師的一句話、專長、學經歷、照片）因此不必再等程式改版：後台填完就更新。
 * `confirmed` 由後台勾——老師本人確認過才算數，沒確認的頁面上會標出來。
 */
const KEY = "labs.json";

/** 可以在後台改的欄位。其他（房號、顏色、stage、四語名稱）留在 repo 裡，不從網頁改。 */
const FIELDS = [
  "one_line_zh",
  "one_line_en",
  "expertise_zh",
  "expertise_en",
  "background_zh",
  "background_en",
  "intro_zh",
  "intro_en",
  "equipment_zh",
  "equipment_en",
  "papers",
  "photo",
  "photos",
  "confirmed",
] as const;

/**
 * 照片的來源只有三種：
 * - `assets/labs/<房號>/<檔名>` —— repo 裡的站台檔（老師簡報上那幾張就在這裡，跟 labs.json 一起進版控）
 * - `labs/<房號>/<檔名>` —— 後台上傳的，存在媒體庫，`/api/media` 對 `labs/` 公開
 * - `https://…` —— 外部網址
 * 其他一律丟掉（空字串＝拿掉照片）。
 */
const PHOTO = /^(assets\/labs|labs)\/30[1-5]\/[\w.-]+$/;
const photoSrc = (v: unknown) => {
  const x = str(v, 500);
  return !x || PHOTO.test(x) || /^https:\/\/\S+$/i.test(x) ? x : "";
};

type Overrides = Record<string, Record<string, unknown>>;

async function loadOverrides(): Promise<Overrides> {
  try {
    const m = await getStore().getMedia(KEY);
    if (!m) return {};
    const saved = JSON.parse(new TextDecoder().decode(m.bytes));
    return saved && typeof saved === "object" ? (saved as Overrides) : {};
  } catch {
    return {};
  }
}

/** repo 裡那一份 ＋ 後台改過的部分。兩邊都沒有的欄位就是沒有，不要自己補。 */
export async function loadLabs(): Promise<any> {
  const base = await loadPublicData("labs");
  const over = await loadOverrides();
  const labs = (base.labs || []).map((lab: any) => {
    const o = over[String(lab.room)];
    return o ? { ...lab, ...o } : lab;
  });
  return { ...base, labs };
}

const str = (v: unknown, n = 4000) => String(v == null ? "" : v).trim().slice(0, n);
const list = (v: unknown, n = 20) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, n) : []);

export default async (req: Request) => {
  if (req.method === "GET") {
    // 來賓端也讀這一支，所以不要 token；內容本來就是要給人看的
    return json({ ok: true, ...(await loadLabs()) }, { headers: { "cache-control": "public, max-age=60" } });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;

  const body = await readJSON<any>(req);
  const room = str(body?.room, 8);
  if (!/^30[1-5]$/.test(room)) return fail(400, "房號只有 301–305");
  const over = await loadOverrides();

  if (body?.photo) {
    // 照片：跟當天資料同一套（base64 進來、存媒體庫、回一個 key），上限也一樣 4.5 MB
    const raw = str(body.photo.data, 8_000_000);
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
    const mediaType = (m ? m[1] : "image/jpeg").toLowerCase();
    const b64 = (m ? m[2] : raw).replace(/\s/g, "");
    if (!b64) return fail(400, "需要照片");
    if (!mediaType.startsWith("image/")) return fail(400, "請上傳圖片檔");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > 4.5 * 1024 * 1024) return fail(413, "照片超過 4.5 MB，請先縮小（後台會自動縮到長邊 800px）");
    const ext = mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
    const key = `labs/${room}/${Date.now()}.${ext}`;
    const store = getStore();
    await store.putMedia(key, new Uint8Array(bytes), mediaType);
    if (body.photo.gallery) {
      // 介紹頁的照片牆：接在後面，圖說之後再用 fields.photos 填
      const base = (await loadLabs()).labs.find((l: any) => String(l.room) === room);
      const photos = (over[room]?.photos as any[]) || base?.photos || [];
      over[room] = { ...(over[room] || {}), photos: [...photos, { src: key, caption_zh: "", caption_en: "" }].slice(0, 24), updated_at: nowISO() };
    } else {
      const prev = str(over[room]?.photo, 500);
      // 只刪後台上傳過的那一張；repo 裡的 assets/ 不動（那是底稿，按「改回原稿」還要用）
      if (/^labs\/30[1-5]\/[\w.-]+$/.test(prev)) await store.deleteMedia(prev).catch(() => {});
      over[room] = { ...(over[room] || {}), photo: key, updated_at: nowISO() };
    }
  } else if (body?.reset) {
    delete over[room];
  } else {
    const fields = body?.fields && typeof body.fields === "object" ? body.fields : null;
    if (!fields) return fail(400, "需要 fields");
    const next: Record<string, unknown> = { ...(over[room] || {}) };
    for (const f of FIELDS) {
      if (!(f in fields)) continue;
      const v = (fields as any)[f];
      if (f === "papers") {
        next.papers = (Array.isArray(v) ? v : [])
          .map((p: any) => ({ title: str(p?.title, 300), venue: str(p?.venue, 160), url: str(p?.url, 500) }))
          .filter((p) => p.title && /^https?:\/\/\S+$/i.test(p.url))
          .slice(0, 20);
      } else if (f === "expertise_zh" || f === "expertise_en" || f === "equipment_zh" || f === "equipment_en") {
        next[f] = list(v);
      } else if (f === "confirmed") {
        next.confirmed = v === true || v === "true";
      } else if (f === "photo") {
        next.photo = photoSrc(v);
      } else if (f === "photos") {
        // 介紹頁的照片牆：順序、圖說、刪掉哪幾張，整個陣列一次送上來
        next.photos = (Array.isArray(v) ? v : [])
          .map((x: any) => ({ src: photoSrc(x?.src), caption_zh: str(x?.caption_zh, 200), caption_en: str(x?.caption_en, 200) }))
          .filter((x) => x.src)
          .slice(0, 24);
      } else {
        next[f] = str(v);
      }
    }
    next.updated_at = nowISO();
    over[room] = next;
  }

  await getStore().putMedia(KEY, new TextEncoder().encode(JSON.stringify(over)), "application/json");
  return json({ ok: true, ...(await loadLabs()) });
};
