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
 */
const MANIFEST = "master/manifest.json";
const PART_SIZE = 4 * 1024 * 1024;
const MAX_PART = PART_SIZE + 1024;
const MAX_PARTS = 64; // 64 × 4 MB ≈ 256 MB；正常的 slim master 在 30 MB 左右

interface Manifest {
  upload_id: string;
  name: string;
  size: number;
  parts: number;
  part_size: number;
  uploaded_at: string;
}

type S = ReturnType<typeof getStore>;
const partKey = (id: string, i: number) => `master/${id}/part-${i}`;

async function readManifest(store: S): Promise<Manifest | null> {
  const m = await store.getMedia(MANIFEST);
  if (!m) return null;
  try {
    return JSON.parse(new TextDecoder().decode(m.bytes)) as Manifest;
  } catch {
    return null;
  }
}

async function removeParts(store: S, man: Manifest): Promise<void> {
  for (let i = 0; i < man.parts; i++) await store.deleteMedia(partKey(man.upload_id, i)).catch(() => {});
}

export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const store = getStore();

  if (req.method === "GET") {
    const man = await readManifest(store);
    const part = url.searchParams.get("part");
    if (part === null) return json({ ok: true, master: man });
    if (!man) return fail(404, "站台上沒有母簡報");
    const i = Number(part);
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
    if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return fail(400, `total 需要是 1–${MAX_PARTS}`);

    if (url.searchParams.get("commit")) {
      let size = 0;
      for (let i = 0; i < total; i++) {
        const m = await store.getMedia(partKey(uploadId, i));
        if (!m) return fail(400, `缺第 ${i + 1} 塊，請重新上傳`);
        size += m.bytes.length;
      }
      const name = (url.searchParams.get("name") || "slim-master.pptx").split(/[\\/]/).pop()!.slice(0, 80) || "slim-master.pptx";
      const prev = await readManifest(store);
      const man: Manifest = { upload_id: uploadId, name, size, parts: total, part_size: PART_SIZE, uploaded_at: nowISO() };
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
