/**
 * 資料層：好幾個人**同時**存同一場，誰都不能把別人剛存的蓋掉。
 *
 * 實際情況：支援人力表的通告一發出去，五間研究室的老師各自從 LINE 點進來填；主辦端同時開著行程表（每改一個字
 * 1.2 秒後自己存）；每一次存檔又觸發背景把整場備份到 Drive。以前每一個寫入都是「讀整筆 → 改 → 整筆寫回去」，
 * 同時存的時候後寫的會把先寫的那一格蓋回舊的——五間同時存，五格只剩一格（實際測過）。
 *
 * 兩種後端都測：本機檔案（開發與測試用）與 Netlify Blobs（正式站）。Blobs 用的是**真的 @netlify/blobs 套件**，
 * 對著這裡一支很小的假伺服器打：官方附的本機伺服器讀的時候不給版本號（etag），條件寫入也不是一次完成的
 * （兩個同時送的條件寫入可能都過），測不出「同時存」——這支假伺服器照正式站的規矩：讀的時候給版本號、
 * 比對版本號與寫入一次完成，回應再隨機慢一點，讓同時送出的請求真的交錯。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { getStore, resetStore } = await import("../netlify/lib/store.mts");

const ROOMS = ["301", "302", "303", "304", "305"];
const visit = (id) => ({ visit_id: id, date: "2026-12-01", start_time: "10:00", org: { name: "Concurrency University" }, guests: [], programme: [], itinerary: [], slides: [], letters: {} });

/** 十個人同時各填一格，回傳最後留下幾格（應該是十格）。 */
async function keptOutOfTen(store, id) {
  const jobs = [];
  for (let round = 0; round < 2; round++)
    for (const room of ROOMS)
      jobs.push(
        store.updateVisit(id, (v) => {
          v.presenters = { ...(v.presenters || {}), [`${room}-${round}`]: `R${round}-${room}` };
        }),
      );
  await Promise.all(jobs);
  return Object.keys((await store.getVisit(id)).presenters || {}).length;
}

/**
 * 假的 Netlify Blobs：只做這個專案用得到的幾件事（讀、寫、刪、列表），照正式站的規矩回版本號。
 * `etagOnRead: false` 模擬「讀的時候不給版本號」（官方本機伺服器就是這樣）：那時候要從列表拿版本號。
 */
async function fakeBlobs({ etagOnRead = true } = {}) {
  const blobs = new Map();
  let version = 0;
  const jitter = () => new Promise((ok) => setTimeout(ok, Math.random() * 15));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, "http://x");
    const [, , store, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.join("/");
    const id = `${store}/${key}`;
    if (req.method === "GET" && !key) {
      const prefix = `${store}/${url.searchParams.get("prefix") || ""}`;
      const list = [...blobs].filter(([k]) => k.startsWith(prefix)).map(([k, b]) => ({ key: k.slice(store.length + 1), etag: b.etag, size: b.body.length, last_modified: new Date().toISOString() }));
      await jitter();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ blobs: list, directories: [] }));
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const b = blobs.get(id); // 先拿到這一刻的內容，回應再慢一點送到——跟真的網路一樣，送到時可能已經不是最新的
      await jitter();
      if (!b) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, etagOnRead ? { etag: b.etag } : {});
      return res.end(req.method === "GET" ? b.body : undefined);
    }
    if (req.method === "PUT") {
      await jitter();
      // 比對版本號與寫入一次完成（中間沒有 await）：兩個帶同一個版本號的寫入，只有一個會成功
      const cur = blobs.get(id);
      const ifMatch = req.headers["if-match"];
      if ((ifMatch && (!cur || cur.etag !== ifMatch)) || (req.headers["if-none-match"] === "*" && cur)) {
        res.writeHead(412);
        return res.end();
      }
      const etag = `"v${++version}"`;
      blobs.set(id, { body: Buffer.concat(chunks), etag });
      res.writeHead(200, { etag });
      return res.end();
    }
    if (req.method === "DELETE") {
      blobs.delete(id);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((ok) => server.close(ok)) };
}

const contextFor = (url, { uncached = true } = {}) =>
  Buffer.from(JSON.stringify({ edgeURL: url, ...(uncached ? { uncachedEdgeURL: url } : {}), siteID: "ghrc-test", token: "t" })).toString("base64");

function useBlobs(url) {
  process.env.NETLIFY_BLOBS_CONTEXT = contextFor(url);
  process.env.STORE_BACKEND = "blobs";
  process.env.CONTEXT = "production";
  resetStore();
  return getStore();
}

test("本機檔案：同時存同一場，十格都留下來，檔案也不會寫壞", async () => {
  process.env.STORE_BACKEND = "file";
  process.env.STORE_DIR = await mkdtemp(path.join(os.tmpdir(), "ghrc-store-file-"));
  resetStore();
  const store = getStore();
  assert.equal(store.backend, "file");
  await Promise.all(["a", "b", "c"].map((x) => store.putVisit(visit(`2026-12-01-${x}`)))); // 三場同時建：三場都要在
  assert.equal((await store.listVisits()).length, 3);
  assert.equal(await keptOutOfTen(store, "2026-12-01-a"), 10);
  // 整個檔還是一份合法的 JSON（以前同一毫秒的兩個寫入會寫進同一個暫存檔，內容交錯，整個檔就壞了）
  const all = JSON.parse(await readFile(path.join(process.env.STORE_DIR, "visits.json"), "utf8"));
  assert.equal(all.length, 3);
  assert.equal(await store.updateVisit("2026-12-01-zzz", () => {}), null, "找不到的那一場回 null，不會憑空建一筆");
});

test("Netlify Blobs：同時存同一場，十格都留下來；支援人力表五間同時填分鐘，五間都排進行程", async () => {
  const fake = await fakeBlobs();
  try {
    const store = useBlobs(fake.url);
    assert.equal(store.backend, "blobs");
    const id = "2026-12-01-blobs";
    await store.putVisit(visit(id));
    assert.equal(await keptOutOfTen(store, id), 10);
    await Promise.all(
      ROOMS.map((room, i) =>
        store.updateVisit(id, (v) => {
          v.lab_minutes = { ...(v.lab_minutes || {}), [room]: 10 + i };
          v.itinerary = [...(v.itinerary || []).filter((s) => s.room !== room), { room, minutes: 10 + i }];
        }),
      ),
    );
    const v = await store.getVisit(id);
    assert.deepEqual(Object.keys(v.lab_minutes).sort(), ROOMS);
    assert.deepEqual(v.itinerary.map((s) => s.room).sort(), ROOMS);
    // change 回 false＝不必寫：照樣回傳現在那一份
    assert.deepEqual((await store.updateVisit(id, () => false)).lab_minutes, v.lab_minutes);
    assert.equal(await store.updateVisit("2026-12-01-nope", () => {}), null);
    // 對照組：以前的寫法（讀整筆 → 改 → 整筆寫回去）在同一台假伺服器上確實會掉——上面全部留下來不是運氣
    const naive = "2026-12-01-naive";
    await store.putVisit(visit(naive));
    await Promise.all(
      ROOMS.map(async (room) => {
        const x = await store.getVisit(naive);
        x.presenters = { ...(x.presenters || {}), [room]: room };
        await store.putVisit(x);
      }),
    );
    assert.ok(Object.keys((await store.getVisit(naive)).presenters).length < 5, "以前的寫法同時存會掉格子");
  } finally {
    await fake.close();
  }
});

test("Netlify Blobs：讀的時候不給版本號（官方本機伺服器那樣）也一樣不會掉——版本號改從列表拿，先拿版本號再讀資料", async () => {
  const fake = await fakeBlobs({ etagOnRead: false });
  try {
    const store = useBlobs(fake.url);
    const id = "2026-12-01-noetag";
    await store.putVisit(visit(id));
    assert.equal(await keptOutOfTen(store, id), 10);
  } finally {
    await fake.close();
  }
});

test("Netlify Blobs：環境不支援「讀最新的」（沒有 uncachedEdgeURL）時退回預設讀法，整站不會壞", async () => {
  const fake = await fakeBlobs();
  try {
    // 另開一個程序（「退回」記在模組裡，要跟上面幾個測試分開）。用非同步的 execFile：
    // 假伺服器跑在這個程序裡，用 spawnSync 會把它卡住，子程序就永遠等不到回應
    const script = `
      const { getStore } = await import(${JSON.stringify(path.join(root, "netlify/lib/store.mts"))});
      const store = getStore();
      await store.putVisit({ visit_id: "2026-12-01-fb", date: "2026-12-01", org: { name: "x" } });
      const r = await store.updateVisit("2026-12-01-fb", (v) => { v.presenters = { "301": "A" }; });
      const v = await store.getVisit("2026-12-01-fb");
      console.log(JSON.stringify({ backend: store.backend, updated: r?.presenters?.["301"], read: v?.presenters?.["301"] }));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      timeout: 20000,
      env: { ...process.env, STORE_BACKEND: "blobs", CONTEXT: "production", NETLIFY_BLOBS_CONTEXT: contextFor(fake.url, { uncached: false }) },
    });
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").pop()), { backend: "blobs", updated: "A", read: "A" });
  } finally {
    await fake.close();
  }
});
