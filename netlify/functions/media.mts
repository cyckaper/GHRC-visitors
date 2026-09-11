import { fail, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";

/**
 * GET /api/media?key=signbook/<visit>/<file>    （admin）簽名簿照片
 * GET /api/media?key=dictation/<visit>/<file>   （admin）口述音檔
 * GET /api/media?key=materials/<visit>/<file>   （公開）專屬頁面的當天資料：簡報 PDF、合照——來賓端頁面直接連
 */
export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!/^(signbook|dictation|materials)\/[\w-]+\/[\w.-]+$/.test(key)) return fail(400, "key 不對");
  const isPublic = key.startsWith("materials/");
  if (!isPublic) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }
  const m = await getStore().getMedia(key);
  if (!m) return fail(404, "找不到檔案");
  const name = key.split("/").pop() || "file";
  return new Response(m.bytes as BodyInit, {
    headers: {
      "content-type": m.contentType,
      "content-disposition": `inline; filename="${name}"`,
      "cache-control": isPublic ? "public, max-age=86400" : "private, max-age=3600",
    },
  });
};
