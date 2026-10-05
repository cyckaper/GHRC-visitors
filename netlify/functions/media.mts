import { fail, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";

/**
 * GET /api/media?key=signbook/<visit>/<file>    （admin）簽名簿照片
 * GET /api/media?key=cards/<visit>/<file>       （admin）訪客名片原圖——有個資，**不公開**
 * GET /api/media?key=dictation/<visit>/<file>   （admin）口述音檔
 * GET /api/media?key=materials/<visit>/<file>   （公開）專屬頁面的當天資料：簡報 PDF、合照、答應提供的檔案——來賓端頁面與感謝信直接連
 * GET /api/media?key=labs/<room>/<file>         （公開）老師照片——老師介紹頁與來賓專頁直接連
 *
 * 下載的檔名用上傳時原本的名字（可以是中文，key 只能是英數字）。圖片、PDF、影音直接在瀏覽器打開，其他的（Word、Excel、壓縮檔）下載。
 * 打開會執行東西的格式（網頁、SVG、XML）一律當成下載的檔案，不在站台的網址底下顯示。
 */
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(text|application)\/xml)\b|javascript|ecmascript/i;
const INLINE = /^(image\/(jpeg|png|gif|webp)|application\/pdf|audio\/|video\/|text\/plain)/i;
export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!/^(signbook|dictation|cards|materials|labs)\/[\w-]+\/[\w.-]+$/.test(key)) return fail(400, "key 不對");
  // 老師照片跟當天資料一樣要給來賓看得到；名片、簽名簿、口述有個資，一律要 token
  const isPublic = key.startsWith("materials/") || key.startsWith("labs/");
  if (!isPublic) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }
  const m = await getStore().getMedia(key);
  if (!m) return fail(404, "找不到檔案");
  const name = m.name || (key.split("/").pop() || "file").replace(/^\d{10,}-/, "");
  const type = ACTIVE.test(m.contentType) ? "application/octet-stream" : m.contentType;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(m.bytes as BodyInit, {
    headers: {
      "content-type": type,
      "content-disposition": `${INLINE.test(type) ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": isPublic ? "public, max-age=86400" : "private, max-age=3600",
    },
  });
};
