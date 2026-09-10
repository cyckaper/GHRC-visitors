import { fail, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";

/** GET /api/media?key=signbook/<visit>/<file>  （admin）簽名簿照片、口述音檔 */
export default async (req: Request) => {
  if (req.method !== "GET") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!/^(signbook|dictation)\/[\w-]+\/[\w.-]+$/.test(key)) return fail(400, "key 不對");
  const m = await getStore().getMedia(key);
  if (!m) return fail(404, "找不到檔案");
  return new Response(m.bytes as BodyInit, { headers: { "content-type": m.contentType, "cache-control": "private, max-age=3600" } });
};
