/**
 * 端到端（不含瀏覽器）：透過本機 dev server 打每一個 function。
 * 用 file 後端（暫存目錄）與 AI_MOCK，完全不需要外部服務。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "ghrc-store-"));
process.env.STORE_BACKEND = "file";
process.env.STORE_DIR = tmp;
process.env.AI_MOCK = "1";
process.env.ADMIN_TOKEN = "test-token";
process.env.SITE_URL = "https://visit.example.test";
process.env.GMAIL_SENDER = "ghrc@example.test"; // 只有寄件帳號：Gmail 仍算沒接好（沒有 client id／secret／refresh token）

const { createServer } = await import("../scripts/dev-server.mjs");
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const admin = { authorization: "Bearer test-token", "content-type": "application/json" };
const api = async (p, init = {}) => {
  const r = await fetch(base + p, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
};

const EMAIL = `Dear Prof. Chang,

Thank you for the invitation. I will visit the Green Health Research Center on 2026-10-07 at 10:00
together with my colleague Jane Doe <jane.doe@uwa.edu.au>. My assistant Kim (kim.lee@uwa.edu.au) will also join.

Simon Kilbane
Programme Director, Landscape Architecture, University of Western Australia
simon.kilbane@uwa.edu.au`;

let visitId = "";

/**
 * 跑得久的 AI（讀信、排行程）都在背景函式裡做，POST 只開一個工作、回 202。
 * 測試裡的 SITE_URL 指向站台網址，觸發打不到這台 dev server，所以照前端的順序自己跑一遍：
 * 觸發 → 叫背景函式做事 → 輪詢拿結果。
 */
async function runJob(name, body, init = {}) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const started = await api(`/api/${name}`, { method: "POST", headers: init.headers || (isForm ? { authorization: "Bearer test-token" } : admin), body: isForm ? body : JSON.stringify(body) });
  // 202 才是「開了一個工作」；當場就回的（擋下來的錯誤、翻譯整批命中快取、沒設定 Gmail）照原樣傳回去
  if (started.status !== 202) return started;
  const ran = await api(`/api/${name}-background`, { method: "POST", headers: admin, body: JSON.stringify({ job_id: started.body.job_id }) });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const job = await api(`/api/${name}?job=${started.body.job_id}`, { headers: admin });
  assert.equal(job.body.status, "done", JSON.stringify(job.body));
  const { ok, job_id, status, ...extra } = started.body; // 觸發時就知道的東西（photo_key、audio_key）
  return { status: 200, body: { ok: true, ...extra, ...job.body.result } };
}
const extract = (body) => runJob("extract", body);
const plan = (visit) => runJob("plan", { visit });

test("admin endpoints reject a missing or wrong token", async () => {
  assert.equal((await api("/api/visits")).status, 401);
  assert.equal((await api("/api/visits", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await api("/api/extract", { method: "POST", body: "{}" })).status, 401);
});

test("extract → visit draft keeps every email on the list", async () => {
  const r = await extract({ email_text: EMAIL });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.visit;
  assert.equal(v.date, "2026-10-07");
  const emails = v.guests.map((g) => g.email).sort();
  assert.deepEqual(emails, ["jane.doe@uwa.edu.au", "kim.lee@uwa.edu.au", "simon.kilbane@uwa.edu.au"]);
  assert.equal(v.guests.filter((g) => g.role === "lead").length, 1);
  assert.ok(v.visit_id.startsWith("2026-10-07-"));
  assert.equal(v.language, "en");
});

test("extract accepts uploaded list files: csv + docx text is read, .doc is reported unsupported", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="w"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Kim Lee</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>kim.lee@uwa.edu.au</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  const docx = Buffer.from(await zip.generateAsync({ type: "uint8array" })).toString("base64");
  const csv = Buffer.from("name,email\nJane Doe,jane.doe@uwa.edu.au\n").toString("base64");
  const r = await extract({ email_text: "", files: [{ name: "list.csv", type: "text/csv", data: csv }, { name: "list.docx", type: "", data: `data:application/octet-stream;base64,${docx}` }, { name: "old.doc", type: "application/msword", data: Buffer.from("x").toString("base64") }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.files_read.map((f) => f.name), ["list.csv", "list.docx"]);
  assert.equal(r.body.warnings.length, 1);
  assert.ok(r.body.warnings[0].includes("old.doc"));
  const emails = r.body.visit.guests.map((g) => g.email).sort();
  assert.deepEqual(emails, ["jane.doe@uwa.edu.au", "kim.lee@uwa.edu.au"]);
  const empty = await extract({ email_text: "", files: [] });
  assert.equal(empty.status, 400);
});

test("extract 跑在背景：一般函式 10 秒不夠，所以回 202 加工作編號，前端輪詢", async () => {
  const started = await api("/api/extract", { method: "POST", headers: admin, body: JSON.stringify({ email_text: EMAIL }) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.ok(started.body.job_id, "回一個工作編號給前端輪詢");
  const pending = await api(`/api/extract?job=${started.body.job_id}`, { headers: admin });
  assert.equal(pending.body.status, "running");
  assert.equal(pending.body.input, undefined, "輪詢不會把信件內容與附件再送回前端");
  assert.equal((await api(`/api/extract?job=${started.body.job_id}`)).status, 401, "查進度也要 token");
  assert.equal((await api("/api/extract?job=zzzzzzzz", { headers: admin })).status, 404, "過期或不存在的工作說找不到");
  assert.equal((await api("/api/extract-background", { method: "POST", body: JSON.stringify({ job_id: started.body.job_id }) })).status, 401, "background needs the token too");

  // 背景函式才是真的做事的那一支：輸入自己從 job 讀，觸發只帶 job_id
  const ran = await api("/api/extract-background", { method: "POST", headers: admin, body: JSON.stringify({ job_id: started.body.job_id }) });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const done = await api(`/api/extract?job=${started.body.job_id}`, { headers: admin });
  assert.equal(done.body.status, "done");
  assert.ok(done.body.result.visit.guests.length, "結果留在工作上，前端輪到就拿得到");
  assert.equal(done.body.result.visit.date, "2026-10-07");
});

test("plan 也跑在背景：提示詞帶整份頁次索引，10 秒同樣不夠", async () => {
  assert.equal((await api("/api/plan", { method: "POST", body: JSON.stringify({ visit: {} }) })).status, 401, "needs the admin token");
  assert.equal((await api("/api/plan", { method: "POST", headers: admin, body: "{}" })).status, 400, "需要 visit");
  const started = await api("/api/plan", { method: "POST", headers: admin, body: JSON.stringify({ visit: { org: { name: "UWA" }, date: "2026-10-07", start_time: "10:00", end_time: "11:30" } }) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await api(`/api/plan?job=${started.body.job_id}`, { headers: admin })).body.status, "running");
  assert.equal((await api("/api/plan-background", { method: "POST", headers: admin, body: "{}" })).status, 400, "background needs a job_id");
  assert.equal((await api("/api/plan-background", { method: "POST", body: JSON.stringify({ job_id: started.body.job_id }) })).status, 401, "background needs the token too");
  assert.equal((await api("/api/plan-background", { method: "POST", headers: admin, body: JSON.stringify({ job_id: started.body.job_id }) })).status, 200);
  const done = await api(`/api/plan?job=${started.body.job_id}`, { headers: admin });
  assert.equal(done.body.status, "done");
  assert.equal(done.body.input, undefined, "輪詢不會把整筆參訪再送回前端");
  assert.ok(done.body.result.visit.programme.length, "行程留在工作上，前端輪到就拿得到");
});

test("存檔：幾點開始、幾點結束是主，總分鐘跟著算", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const r = await put({ org: { name: "Clock University" }, date: "2026-11-05", code: "clock", start_time: "09:30", end_time: "12:00" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.visit.end_time, "12:00");
  assert.equal(r.body.visit.duration_minutes, 150, "總分鐘由開始與結束算出來");
  // 結束早於開始＝填錯：不要把這一場算成負的，沿用原本的長度
  const bad = await put({ ...r.body.visit, start_time: "09:30", end_time: "08:00" });
  assert.equal(bad.body.visit.duration_minutes, 150, "填錯不動原本的長度");
  assert.equal(bad.body.visit.end_time, "12:00");
  // 舊資料只有總分鐘：結束時間算得回來，來賓端也拿得到
  const legacy = await put({ org: { name: "Legacy University" }, date: "2026-11-06", code: "legacy", start_time: "10:00", duration_minutes: 90 });
  assert.equal(legacy.body.visit.end_time, "11:30");
  const pub = await api(`/api/visits?id=${legacy.body.visit.visit_id}&public=1`);
  assert.equal(pub.body.visit.end_time, "11:30", "來賓專頁的日期那一行要寫得出幾點到幾點");
  // 這兩場是這個測試自己建的，收乾淨（後面的測試在數同一個清單）
  for (const id of [r.body.visit.visit_id, legacy.body.visit.visit_id]) {
    assert.equal((await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin })).status, 200);
  }
});

test("plan → programme, itinerary, slides (always-slides present), then save", async () => {
  const ex = await extract({ email_text: EMAIL });
  const visit = { ...ex.body.visit, code: "uwa", start_time: "10:00", end_time: "11:30" }; // 90 分鐘
  const p = await plan(visit);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const planned = p.body.visit;
  for (const n of [1, 2, 3, 4, 72]) assert.ok(planned.slides.includes(n), `slide ${n} missing`);
  assert.ok(planned.programme.some((b) => b.kind === "tour"));
  assert.equal(planned.itinerary[0].room, "briefing", "route starts with the overall briefing");
  const kinds = planned.programme.map((b) => b.kind);
  assert.ok(kinds.includes("discussion"), "programme always has a 綜合討論 block");
  assert.ok(kinds.indexOf("tour") < kinds.indexOf("discussion"), "討論 comes after the tour");
  const disc = planned.programme.find((b) => b.kind === "discussion");
  assert.equal(disc.title_en, "General discussion");
  assert.equal(disc.title_2nd, "", "English visit: second-language title stays empty");
  // 90 分鐘：總體介紹 20、研究室 5×11、合照 5、綜合討論 10（不夠時先縮研究室）
  const mins = (b) => { const [sh, sm] = b.start.split(":").map(Number); const [eh, em] = b.end.split(":").map(Number); return eh * 60 + em - (sh * 60 + sm); };
  assert.equal(mins(planned.programme.find((b) => b.kind === "briefing")), 20);
  assert.equal(mins(disc), 10);
  assert.equal(planned.itinerary[0].minutes, 20);
  assert.equal(planned.itinerary[0].location, "302", "the briefing is in 302 by default");
  assert.ok(planned.itinerary.slice(1).every((s) => s.minutes === 11));
  const p2 = await plan({ ...visit, itinerary: [{ room: "briefing", minutes: 20, location: "304" }] });
  assert.equal(p2.body.visit.itinerary[0].location, "304", "an organiser-chosen briefing room survives the AI plan");
  assert.ok(planned.itinerary[0].minutes > 0);
  assert.equal(planned.itinerary.reduce((s, x) => s + x.minutes, 0) <= 90, true);
  const saved = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(planned) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  visitId = saved.body.visit.visit_id;
  assert.equal(visitId, "2026-10-07-uwa");
  assert.equal(saved.body.visit.page_url, "https://visit.example.test/2026-10-07-uwa");
});

test("public visit view exists without a token and leaks nothing personal", async () => {
  const r = await api(`/api/visits?id=${visitId}&public=1`);
  assert.equal(r.status, 200);
  const s = JSON.stringify(r.body);
  assert.ok(!s.includes("@uwa.edu.au"));
  assert.ok(r.body.visit.programme.length > 0);
  assert.equal((await api(`/api/visits?id=2026-10-07-nope&public=1`)).status, 404);
});

test("產檔那一刻的行程指紋由伺服器蓋；行程一改就回報簡報過期", async () => {
  const put = (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const before = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;
  assert.deepEqual((await api(`/api/visits?id=${visitId}`, { headers: admin })).body.stale, [], "還沒產過簡報，沒有什麼會過期");
  // 產檔：前端只送 generated_at，指紋是伺服器蓋的（算法只有一份）
  const made = await put({ ...before, deck: { ...(before.deck || {}), generated_at: new Date().toISOString(), slides: 12 } });
  assert.ok(made.body.visit.deck.fingerprint, "伺服器蓋了指紋");
  assert.deepEqual(made.body.stale, [], "剛產出來的不算舊");
  // 行程改了：手上那份 .pptx 的第 2 頁就錯了
  const moved = await put({ ...made.body.visit, programme: [{ kind: "briefing", start: "11:00", end: "11:30", title_en: "Overview", title_2nd: "總體介紹", slides_range: "" }] });
  assert.deepEqual(moved.body.stale.map((x) => x.key), ["deck"], JSON.stringify(moved.body.stale));
  assert.equal(moved.body.visit.deck.fingerprint, made.body.visit.deck.fingerprint, "沒有重新產檔就不要偷偷換掉指紋");
  // 重新產一次就乾淨了
  const again = await put({ ...moved.body.visit, deck: { ...moved.body.visit.deck, generated_at: new Date(Date.now() + 1000).toISOString() } });
  assert.deepEqual(again.body.stale, []);
  await put(before); // 把這一場擺回去，後面的測試照原本那一份跑
});

test("confirmation letter draft is stored on the visit", async () => {
  const r = await runJob("letter", { visit_id: visitId, kind: "confirmation", sender: "director" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.draft.body.includes("https://visit.example.test/2026-10-07-uwa"));
  const v = await api(`/api/visits?id=${visitId}`, { headers: admin });
  assert.ok(v.body.visit.letters.confirmation.subject);
});

test("respond: anonymous suggestion is stored with no identity; named onsite email is kept", async () => {
  const anon = await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: visitId, anonymous: true, name: "Simon", email: "simon.kilbane@uwa.edu.au", suggestion: "Room 302 was hard to follow.", cooperate_rooms: ["301", "303"], next_actions: ["papers"] }) });
  assert.equal(anon.status, 200, JSON.stringify(anon.body));
  const onsite = await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: visitId, source: "onsite", name: "Walk-in Guest", email: "walkin@example.org", note: "please send the CAVE paper" }) });
  assert.equal(onsite.status, 200);
  assert.equal((await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: visitId }) })).status, 400);
  assert.equal((await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: "2026-01-01-nope", suggestion: "x" }) })).status, 404);
  const rows = JSON.parse(await readFile(path.join(tmp, "responses.json"), "utf8"));
  const a = rows.find((r) => r.anonymous);
  assert.equal(a.name, "");
  assert.equal(a.email, "");
  assert.equal(a.submitted_at.length, 10);
  assert.deepEqual(a.cooperate_rooms, ["301", "303"]);
  assert.ok(!JSON.stringify(a).includes("Simon"));
  const w = rows.find((r) => r.source === "onsite");
  assert.equal(w.email, "walkin@example.org");
});

test("signbook: photo stored, OCR entries returned, then saved as responses", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const r = await runJob("signbook", { visit_id: visitId, image: `data:image/png;base64,${png.toString("base64")}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.photo_key.startsWith(`signbook/${visitId}/`));
  assert.ok(r.body.entries.length >= 1);
  const media = await api(`/api/media?key=${r.body.photo_key}`, { headers: admin });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/png");
  assert.equal((await api(`/api/media?key=${r.body.photo_key}`)).status, 401);
  const save = await api("/api/signbook", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "save", entries: [{ text: "Wonderful visit", signed_by: "S.K.", language: "en" }] }) });
  assert.equal(save.body.saved, 1);
});

test("materials: upload photo and PDF, public media, links; the thanks letter only promises what the page has", async () => {
  const before = await runJob("letter", { visit_id: visitId, kind: "thanks", sender: "director" });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.ok(!/PDF|photo/i.test(before.body.draft.body), "nothing uploaded yet → the letter must not promise slides or photos");
  assert.ok(before.body.draft.body.includes(`https://visit.example.test/${visitId}`));

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const up = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "upload", kind: "photo", name: "合照 group.JPG", data: `data:image/png;base64,${png.toString("base64")}` }) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.key, new RegExp(`^materials/${visitId}/\\d+-group\\.png$`));
  assert.deepEqual(up.body.materials.photos, [up.body.key]);
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  const pdf = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "upload", kind: "pdf", name: "GHRC deck.pdf", data: `data:application/pdf;base64,${pdfBytes.toString("base64")}` }) });
  assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
  assert.ok(pdf.body.materials.deck_pdf.endsWith("-GHRC-deck.pdf"));
  const wrongKind = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "upload", kind: "pdf", name: "x.png", data: `data:image/png;base64,${png.toString("base64")}` }) });
  assert.equal(wrongKind.status, 400);
  // 公開媒體：合照與 PDF 不用 token；簽名簿照片仍要
  const pub = await api(`/api/media?key=${encodeURIComponent(up.body.key)}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("content-type"), "image/png");
  assert.ok((pub.headers.get("cache-control") || "").includes("public"));
  assert.equal((await api(`/api/media?key=materials/${visitId}/../secret`)).status, 400);
  // 連結
  const saved = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "save", materials: { ...pdf.body.materials, links: [{ title: "Lab 303 papers", url: "https://scholar.example/303" }, { title: "bad", url: "javascript:x" }] } }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.materials.links, [{ title: "Lab 303 papers", url: "https://scholar.example/303" }]);
  // 來賓端看得到，且只有 key／連結
  const pubVisit = await api(`/api/visits?id=${visitId}&public=1`);
  assert.equal(pubVisit.body.visit.materials.deck_pdf, pdf.body.materials.deck_pdf);
  assert.deepEqual(pubVisit.body.visit.materials.photos, [up.body.key]);
  assert.equal(pubVisit.body.visit.materials.links.length, 1);
  // 存檔（visits POST）不會把 materials 洗掉，也不吃壞值
  const v = await api(`/api/visits?id=${visitId}`, { headers: admin });
  const resaved = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...v.body.visit, materials: { ...v.body.visit.materials, photos: [...v.body.visit.materials.photos, "not-a-key"] } }) });
  assert.deepEqual(resaved.body.visit.materials.photos, [up.body.key]);
  // 移除照片會刪檔
  const rm = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "remove", key: up.body.key }) });
  assert.deepEqual(rm.body.materials.photos, []);
  assert.equal((await api(`/api/media?key=${encodeURIComponent(up.body.key)}`)).status, 404);
  // 再放一張，讓後面的感謝信測得到「合照」
  const again = await api("/api/materials", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "upload", kind: "photo", name: "photo2.png", data: png.toString("base64"), media_type: "image/png" }) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("master deck: chunked upload, manifest, chunk download, replace, delete", async () => {
  const rawPost = (id, i, total, body) => fetch(`${base}/api/master?upload=${id}&part=${i}&total=${total}`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" }, body });
  const part0 = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(3000, 1)]);
  const part1 = Buffer.alloc(2000, 2);
  assert.equal((await api("/api/master")).status, 401, "needs the admin token");
  assert.equal((await api("/api/master", { headers: admin })).body.master, null, "nothing uploaded yet");
  assert.equal((await rawPost("up-one", 0, 2, part0)).status, 200);
  const early = await api("/api/master?upload=up-one&commit=1&total=2&name=slim.pptx", { method: "POST", headers: admin });
  assert.equal(early.status, 400, "commit before every part is there fails");
  assert.equal((await rawPost("up-one", 1, 2, part1)).status, 200);
  assert.equal((await rawPost("up-bad", 0, 1, Buffer.from("not a zip at all"))).status, 400, "first part must look like a zip");
  const c = await api("/api/master?upload=up-one&commit=1&total=2&name=%E6%AF%8D%E7%B0%A1%E5%A0%B1%2Fslim.pptx", { method: "POST", headers: admin });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.master.parts, 2);
  assert.equal(c.body.master.size, 5004);
  assert.equal(c.body.master.name, "slim.pptx", "path segments stripped from the name");
  const m = await api("/api/master", { headers: admin });
  assert.equal(m.body.master.upload_id, "up-one");
  const p1 = await fetch(`${base}/api/master?part=1`, { headers: admin });
  assert.equal(p1.status, 200);
  assert.equal((await p1.arrayBuffer()).byteLength, 2000);
  assert.equal((await api("/api/master?part=2", { headers: admin })).status, 400);
  // 換新版：舊分塊被清掉
  assert.equal((await rawPost("up-two", 0, 1, part0)).status, 200);
  const c2 = await api("/api/master?upload=up-two&commit=1&total=1&name=v2.pptx", { method: "POST", headers: admin });
  assert.equal(c2.body.master.upload_id, "up-two");
  assert.equal((await fetch(`${base}/api/master?part=0`, { headers: admin })).status, 200);
  const d = await api("/api/master", { method: "DELETE", headers: admin });
  assert.equal(d.status, 200);
  assert.equal((await api("/api/master", { headers: admin })).body.master, null);
  assert.equal((await api("/api/master?part=0", { headers: admin })).status, 404);
});

test("translate: mock translations are cached server-side", async () => {
  const r1 = await runJob("translate", { texts: ["健康景觀智能室", "療癒環境規劃室"], target: "ko" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.translations, ["[ko] 健康景觀智能室", "[ko] 療癒環境規劃室"]);
  assert.equal(r1.body.translated, 2);
  const r2 = await runJob("translate", { texts: ["療癒環境規劃室", "景觀環境模擬室"], target: "ko" });
  assert.equal(r2.body.translated, 1);
  assert.equal(r2.body.from_cache, 1);
  // 整批都翻過就不必等背景函式，當場回（產簡報時一批一批來，不能每批都空等三秒）
  const cached = await api("/api/translate", { method: "POST", headers: admin, body: JSON.stringify({ texts: ["健康景觀智能室", "療癒環境規劃室"], target: "ko" }) });
  assert.equal(cached.status, 200, JSON.stringify(cached.body));
  assert.equal(cached.body.from_cache, 2);
  assert.equal(cached.body.job_id, undefined, "沒有要叫 Claude 就不開工作");
  assert.equal((await api("/api/translate", { method: "POST", headers: admin, body: JSON.stringify({ texts: ["x"], target: "fr" }) })).status, 400);
  assert.equal((await api("/api/translate", { method: "POST", body: JSON.stringify({ texts: ["x"], target: "ko" }) })).status, 401);
});

test("dictation: multipart audio → transcript → extraction → save", async () => {
  const form = new FormData();
  form.append("visit_id", visitId);
  form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "d.webm");
  const r = await runJob("transcribe", form);
  const body = r.body;
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.ok(body.audio_key.startsWith(`dictation/${visitId}/`), "音檔先存下來，轉文字才在背景跑");
  assert.ok(body.transcript.includes("303"));
  assert.deepEqual(body.extracted.most_wanted_rooms, ["303"]);
  const typed = await runJob("transcribe", { visit_id: visitId, transcript: "今天校長來，最想看 304，問了能不能合作。" });
  assert.equal(typed.status, 200);
  assert.deepEqual(typed.body.extracted.most_wanted_rooms, ["304"]);
  const save = await api("/api/transcribe", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "save" }) });
  assert.equal(save.status, 200);
});

test("thanks letter: recipients = list + onsite, wording is the 請益 question, send without Gmail reports sent:false", async () => {
  const rec = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "recipients" }) });
  assert.deepEqual(rec.body.recipients.map((r) => r.email).sort(), ["jane.doe@uwa.edu.au", "kim.lee@uwa.edu.au", "simon.kilbane@uwa.edu.au", "walkin@example.org"]);
  const d = await runJob("letter", { visit_id: visitId, kind: "thanks", sender: "contact" });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(d.body.draft.body.includes("From your perspective, what should we be doing better?"));
  assert.ok(d.body.draft.body.includes("A single sentence is plenty."));
  assert.ok(d.body.draft.body.includes("#respond"));
  assert.ok(!/satisf|rate us|rating/i.test(d.body.draft.body));
  assert.ok(/slides \(PDF\)/.test(d.body.draft.body) && /photos/.test(d.body.draft.body) && /links/.test(d.body.draft.body), "after uploading, the letter may mention the PDF, photos and links");
  assert.ok(!/contact details/.test(d.body.draft.body), "no teacher emails in labs.json yet → no promise of contact details");
  const send = await runJob("letter", { visit_id: visitId, action: "send", subject: d.body.draft.subject, body: d.body.draft.body, recipients: rec.body.recipients });
  assert.equal(send.status, 200);
  assert.equal(send.body.sent, false);
  assert.equal(send.body.reason, "gmail_not_configured");
  assert.ok(send.body.mailto.startsWith("mailto:?bcc="));
});

test("summary writes visit.summary and slide_performance rows; digest lists suggestions; exports work", async () => {
  const s = await runJob("summary", { visit_id: visitId });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.summary.includes("2026-10-07"));
  const perf = JSON.parse(await readFile(path.join(tmp, "slide_performance.json"), "utf8"));
  assert.ok(perf.length > 0);
  assert.ok(perf.every((p) => p.visit_id === visitId && p.used));
  const dg = await runJob("summary", { digest: true });
  assert.equal(dg.body.count, 1);
  const csv = await api("/api/visits?export=csv&table=responses", { headers: admin });
  assert.equal(csv.status, 200);
  assert.ok(String(csv.body).startsWith("visit_id,"));
  const list = await api("/api/visits", { headers: admin });
  assert.equal(list.body.visits.length, 1);
});

test("drive backup: lists everything the archive folder should get; refuses to upload until Google is configured", async () => {
  assert.equal((await api(`/api/drive?id=${visitId}`)).status, 401, "needs the admin token");
  const r = await api(`/api/drive?id=${visitId}`, { headers: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.configured, false, "no Google credentials in the test environment");
  assert.ok(r.body.hint.includes("GOOGLE_DRIVE_FOLDER_ID"));
  const names = r.body.items.map((i) => i.name);
  assert.ok(names.includes("參訪資料.json") && names.includes("回覆.csv"));
  assert.ok(names.includes("一頁摘要.md"), "the summary written earlier is archived too");
  assert.ok(names.some((n) => n.startsWith("簽名簿.")), "signbook photo");
  assert.ok(names.some((n) => n.startsWith("主持人口述.")), "dictation audio");
  assert.ok(names.includes("當天簡報.pdf"), "materials PDF");
  assert.ok(names.includes("photo2.png"), "合照在 Drive 上用原始檔名，不是流水號");
  assert.equal((await api(`/api/drive?id=2026-01-01-nope`, { headers: admin })).status, 404);
  const post = await api("/api/drive", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, key: "visit.json" }) });
  assert.equal(post.status, 503);
  assert.ok(post.body.error.includes("Google Drive"));
});

test("drive auto-backup: the background sync endpoint needs the token and stands down until Google is configured", async () => {
  assert.equal((await api("/api/drive-sync-background", { method: "POST", body: JSON.stringify({ visit_id: visitId }) })).status, 401);
  const r = await api("/api/drive-sync-background", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId }) });
  assert.equal(r.status, 503, "no Google credentials in the test environment");
  assert.ok(r.body.error.includes("GOOGLE_CLIENT_ID"));
  assert.equal((await api("/api/drive-sync-background", { method: "POST", headers: admin, body: "{}" })).status, 400);
  // 沒設定 Drive 時，寫入端點照常運作（triggerDriveSync 直接跳過）
  const v = await api(`/api/visits?id=${visitId}`, { headers: admin });
  assert.equal((await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(v.body.visit) })).status, 200);
  assert.equal((await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: visitId, anonymous: true, suggestion: "auto-backup should not break this" }) })).status, 200);
});

test("cards: 名片讀成名單，確認後才併進 guests，原圖留著", async () => {
  const cardPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const post = (body) => runJob("cards", body);
  assert.equal((await api("/api/cards", { method: "POST", body: JSON.stringify({ visit_id: visitId, image: cardPng }) })).status, 401, "needs the admin token");
  assert.equal((await post({ visit_id: "2026-01-01-nope", image: cardPng })).status, 404);
  assert.equal((await post({ visit_id: visitId })).status, 400, "needs an image");

  const before = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit.guests.length;
  const read = await post({ visit_id: visitId, image: `data:image/png;base64,${cardPng}` });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.match(read.body.photo_key, new RegExp(`^cards/${visitId}/\\d+\\.png$`), "原圖存進媒體庫");
  assert.ok(read.body.people.length, "讀出人");
  // 讀完不會自己動名單
  assert.equal((await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit.guests.length, before, "讀名片不會自己改名單");

  const person = { name: "陳大文", title: "Professor", affiliation: "Example University", email: "Card@Example.edu", phone: "02-1234" };
  const saved = await post({ visit_id: visitId, action: "save", guests: [person], photo_key: read.body.photo_key });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.added, 1);
  const after = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;
  const added = after.guests.find((g) => g.email === "card@example.edu");
  assert.ok(added, "名片上的人進了名單（email 轉小寫）");
  assert.equal(added.phone, "02-1234", "電話留得住（normalizeVisit 不能把它吃掉）");
  assert.equal(after.cards.length, 1, "名片原圖記在這一場");

  // 同一張再存一次不會多一個人
  const again = await post({ visit_id: visitId, action: "save", guests: [person], photo_key: read.body.photo_key });
  assert.equal(again.body.added, 0);
  assert.equal((await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit.guests.length, after.guests.length);

  // 訪後信的收件人會包含名片上的人
  const rec = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "recipients" }) });
  assert.ok(rec.body.recipients.some((r) => r.email === "card@example.edu"), "名片上的人會收到訪後信");

  const removed = await post({ visit_id: visitId, action: "remove", key: read.body.photo_key });
  assert.equal(removed.body.cards.length, 0);
  assert.equal((await api(`/api/media?key=${encodeURIComponent(read.body.photo_key)}`, { headers: admin })).status, 404, "原圖刪掉了");
});

test("research: 查網路要一到三分鐘，所以走背景工作；**還沒存檔也查得了**", async () => {
  assert.equal((await api("/api/research", { method: "POST", body: JSON.stringify({ visit_id: visitId }) })).status, 401, "needs the admin token");
  assert.equal((await api("/api/research", { method: "POST", headers: admin, body: JSON.stringify({}) })).status, 400, "沒有單位也沒有名單就查不了");
  assert.equal((await api("/api/research", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: "2026-01-01-nope" }) })).status, 404);

  // 還沒存檔的一筆：要查的東西跟著工作走，結果從輪詢拿得到
  const draft = await runJob("research", { visit: { org: { name: "University of Western Australia" }, guests: [{ name: "Simon Kilbane" }] } });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.ok(draft.body.purposes.length, "可能的參訪目的");
  assert.ok(draft.body.rooms.every((x) => ["301", "302", "303", "304", "305"].includes(x.room)), "只會指到中心的五間研究室");

  // 存過檔的一筆：狀態與結果另外寫回那一場，重新整理接得回去
  const started = await api("/api/research", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId }) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.ok(started.body.job_id);
  assert.equal((await api(`/api/research?id=${visitId}`, { headers: admin })).body.background.status, "running", "狀態記在參訪上，重新整理也看得到");

  assert.equal((await api("/api/research-background", { method: "POST", body: JSON.stringify({ job_id: started.body.job_id }) })).status, 401, "background needs the token too");
  const done = await api("/api/research-background", { method: "POST", headers: admin, body: JSON.stringify({ job_id: started.body.job_id }) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const b = (await api(`/api/research?id=${visitId}`, { headers: admin })).body.background;
  assert.equal(b.status, "done");
  assert.ok(b.purposes.length, "可能的參訪目的");
  assert.ok(b.researched_at);
  assert.deepEqual((await api(`/api/research?job=${started.body.job_id}`, { headers: admin })).body.result.purposes, b.purposes, "輪詢拿到的跟寫回參訪的是同一份");

  // 存過檔、但畫面上的名單剛改過（例如刪掉一個人）：查的要是**送上來的那一份**，不是伺服器上的舊名單，
  // 不然剛刪掉的人又會出現在「名單上的人」裡
  const stored = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;
  assert.ok(stored.guests.length >= 2, "這一場本來就有兩個人以上");
  const onlyOne = await runJob("research", { visit_id: visitId, visit: { ...stored, guests: [stored.guests[0]] } });
  assert.equal(onlyOne.status, 200, JSON.stringify(onlyOne.body));
  assert.deepEqual(onlyOne.body.people.map((p) => p.name), [stored.guests[0].name], "只查名單上還在的人");
});

test("排程會參考歷次累積：同類單位選過哪幾頁、哪幾頁被提問（功能 4 回饋功能 2）", async () => {
  // 這時候 store 裡已經有一場存過 slides 的參訪，也跑過一頁摘要（slide_performance 有列）
  const p = await plan({ org: { name: "Another University", type: "university" }, date: "2026-12-20", start_time: "10:00", end_time: "12:00" });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const h = p.body.history;
  assert.ok(h, "有歷史就要帶進排程");
  assert.ok(h.visits >= 1, "算過的場次");
  assert.equal(h.same_type.org_type, "university", "同類單位另外算一份");
  assert.ok(h.same_type.visits >= 1);

  // 第一場（store 還空著）沒有歷史可參考，也不能因此壞掉
  const perf = (await api("/api/visits?export=json&table=slide_performance", { headers: admin })).body.rows;
  assert.ok(perf.length, "一頁摘要寫過 slide_performance");
});

test("設定：預設值存得起來，外部服務只回「接好了沒」不回金鑰", async () => {
  assert.equal((await api("/api/settings")).status, 401, "要 token");
  const r = await api("/api/settings", { headers: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.sender_default, "director", "預設是中心主任");
  assert.equal(r.body.status.ai_mock, true, "測試跑在 AI_MOCK");
  assert.ok(!JSON.stringify(r.body).includes("test-signal"), "**不回金鑰內容**");
  assert.ok(!JSON.stringify(r.body).includes("test-token"), "**不回 ADMIN_TOKEN**");

  const saved = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { sender_default: "contact" } }) });
  assert.equal(saved.body.settings.sender_default, "contact");
  assert.equal((await api("/api/settings", { headers: admin })).body.settings.sender_default, "contact", "存得住");
  const bad = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { sender_default: "someone-else" } }) });
  assert.equal(bad.body.settings.sender_default, "contact", "亂填的值不收");
  await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { sender_default: "director" } }) });

  // 後續提醒寄到哪裡：留空就退回 Netlify 的寄件帳號；不是 email 的不收
  assert.equal(r.body.settings.reminder_to, "", "預設留空");
  assert.equal(r.body.effective.reminder_to, "ghrc@example.test", "留空時用寄件帳號");
  const notEmail = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { reminder_to: "中心信箱" } }) });
  assert.equal(notEmail.status, 400, JSON.stringify(notEmail.body));
  const to = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { reminder_to: "Wrapup@NTU.edu.tw" } }) });
  assert.equal(to.body.settings.reminder_to, "wrapup@ntu.edu.tw", "存小寫");
  assert.equal(to.body.effective.reminder_to, "wrapup@ntu.edu.tw");
  assert.equal((await api("/api/settings", { headers: admin })).body.status.reminder, false, "沒接 Gmail 就還是寄不出提醒");
  await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { reminder_to: "" } }) });
});

test("一頁摘要不必人記得按：每晚掃一次，過完又有回覆的自己產", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Summary Cron University" }, date: "2026-08-20", code: "sum", start_time: "10:00", end_time: "12:00" })).body.visit;

  // 排程函式不是誰都打得動（會花 Claude 的錢）：要嘛是 Netlify 的排程器（POST {next_run}），要嘛帶 token
  assert.equal((await api("/api/summary-cron")).status, 401, "路過的人打不動");
  assert.equal((await api("/api/reminder-cron")).status, 401, "寄信那支也一樣");
  assert.equal((await api("/api/drive-cron")).status, 401, "備份那支也一樣");
  const scheduled = await api("/api/summary-cron", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next_run: "2026-09-14T17:00:00.000Z" }) });
  assert.equal(scheduled.status, 200, "Netlify 的排程器打得動");
  assert.ok(!String(scheduled.body).includes(v.visit_id), "還沒有任何回饋的場次不產摘要");

  // 有人回覆之後就該產（過完了、有東西可寫、還沒有摘要）
  await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: v.visit_id, anonymous: true, suggestion: "301 的工具鏈想多看" }) });
  const swept = await api("/api/summary-cron", { method: "POST", headers: admin, body: "{}" });
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  assert.ok(String(swept.body).includes(v.visit_id), `該產摘要的場次要被掃到：${swept.body}`);

  // 摘要產出來之後（模擬背景函式跑完）就不再重複產，除非又有新的回覆。
  // 不具名那一筆只有日期（真匿名的代價），系統一律當成那一天的最後一刻——寧可多寫一次，也不要漏掉
  // 匿名建議。所以這裡用「隔天凌晨那一次排程」的時間對照（真正的 cron 就是那個時候跑的）。
  const done = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
  done.summary = "（測試用摘要）";
  done.summary_at = new Date(Date.now() + 24 * 3600e3).toISOString();
  await put(done);
  const again = await api("/api/summary-cron", { method: "POST", headers: admin, body: "{}" });
  assert.ok(!String(again.body).includes(v.visit_id), "摘要比回覆新就不必重寫");
});

test("後續提醒：依結束時間寄信給自己，一場只寄一次；沒接 Gmail 就老實說", async () => {
  const cron = () => api("/api/reminder-cron", { method: "POST", headers: admin, body: "{}" });
  const stood = await cron();
  assert.equal(stood.status, 200);
  assert.ok(String(stood.body).includes("Gmail"), `沒接 Gmail 要說清楚：${stood.body}`);

  // 剛結束、什麼都還沒做的一場（結束時間＝開始 ＋ 總分鐘，這裡設在十分鐘前）
  const start = new Date(Date.now() - 70 * 60000);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(start);
  const date = new Date(start.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Reminder Normal University" }, date, code: "rmd", start_time: hhmm, duration_minutes: 60 })).body.visit;
  const later = (await put({ org: { name: "Tomorrow University" }, date, code: "tmr", start_time: "23:30", duration_minutes: 60 })).body.visit;

  process.env.MAIL_MOCK = "1"; // 不真的打 Gmail：信會寫進媒體庫讓這裡讀
  try {
    const sent = await cron();
    assert.ok(String(sent.body).includes(v.visit_id), `結束了又沒後續的場次要提醒：${sent.body}`);
    assert.ok(!String(sent.body).includes(later.visit_id), "還沒結束的場次不提醒");

    const mail = JSON.parse(await readFile(path.join(tmp, "media", "mail", "last.json"), "utf8"));
    assert.equal(mail.to, "ghrc@example.test", "留空就寄給 Netlify 設的寄件帳號");
    assert.ok(mail.subject.includes("後續提醒") && mail.subject.includes("Reminder Normal University"));
    assert.ok(mail.text.includes("拍一張簽名簿") && mail.text.includes("三十秒口述"), "信裡列出還缺哪幾件");
    assert.ok(mail.text.includes(`/admin.html#wrapup=${v.visit_id}`), "附一個直接打開後續頁的連結");

    assert.ok(!String((await cron()).body).includes(v.visit_id), "一場只寄一次");

    // 四件事都做完的那一場，本來就不該吵
    const done = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
    done.reminders = {};
    done.signbook = { photo_key: "signbook/x/1.jpg" };
    done.cards = [{ key: "cards/x/1.jpg", names: ["A"], read_at: new Date().toISOString() }];
    done.dictation = { transcript: "今天校長來" };
    done.materials = { deck_pdf: "", photos: [], links: [{ title: "t", url: "https://x.example" }] };
    await put(done);
    assert.ok(!String((await cron()).body).includes(v.visit_id), "後續做完了就不必提醒");

    // 什麼都沒有、但四件事都標了「本次沒有」的那一場，也不該吵——沒有簽名簿、沒交換名片很正常
    const na = (await put({ org: { name: "Nothing To Collect University" }, date, code: "nna", start_time: hhmm, duration_minutes: 60 })).body.visit;
    assert.ok(String((await cron()).body).includes(na.visit_id), "先確認它本來會被提醒");
    const marked = (await api(`/api/visits?id=${na.visit_id}`, { headers: admin })).body.visit;
    marked.reminders = {};
    marked.wrapup = { na: ["signbook", "cards", "dictation", "materials"] };
    const saved = await put(marked);
    assert.deepEqual(saved.body.visit.wrapup.na, ["signbook", "cards", "dictation", "materials"], "標記存得住");
    assert.ok(!String((await cron()).body).includes(na.visit_id), "標了本次沒有就不再提醒");
    await api(`/api/visits?id=${na.visit_id}`, { method: "DELETE", headers: admin });
  } finally {
    delete process.env.MAIL_MOCK;
  }
});

test("一般存檔不會清掉別的端點寫的東西（摘要、提醒紀錄、簽名簿、當天資料）", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Keep Fields College" }, date: "2026-08-21", code: "keep" })).body.visit;
  const full = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
  full.summary = "摘要";
  full.summary_at = "2026-08-22T00:00:00.000Z";
  full.reminders = { wrapup_sent_at: "2026-08-21T05:00:00.000Z", wrapup_to: "wrapup@ntu.edu.tw" };
  full.signbook = { photo_key: "signbook/x/1.jpg" };
  await put(full);

  // 後台在別的分頁開著舊資料按一下存檔（body 裡沒有這些欄位）→ 不能被清掉
  const stale = await put({ visit_id: v.visit_id, org: { name: "Keep Fields College" }, date: "2026-08-21", code: "keep" });
  assert.equal(stale.body.visit.summary, "摘要");
  assert.equal(stale.body.visit.reminders.wrapup_sent_at, "2026-08-21T05:00:00.000Z", "提醒紀錄留著，不然後續提醒會重寄一次");
  assert.equal(stale.body.visit.signbook.photo_key, "signbook/x/1.jpg");
});

test("兩封信同一套：確認信也寄得出去，寄了之後網址就固定", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Letter Test University" }, date: "2026-11-20", code: "ltr", guests: [{ name: "A", email: "a@example.edu" }] })).body.visit;

  const draft = await runJob("letter", { visit_id: v.visit_id, kind: "confirmation", sender: "contact" });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.ok(draft.body.draft.body.includes(v.visit_id), "確認信裡有來賓專頁的網址");

  // 沒設定 Gmail 的環境：當場回 mailto，也就還沒真的寄出去，網址還能改
  const send = await runJob("letter", { visit_id: v.visit_id, action: "send", kind: "confirmation", subject: draft.body.draft.subject, body: draft.body.draft.body, recipients: [{ name: "A", email: "a@example.edu" }] });
  assert.equal(send.body.sent, false);
  assert.equal(send.body.reason, "gmail_not_configured");
  assert.equal((await put({ ...v, code: "ltr2" })).body.visit.visit_id, "2026-11-20-ltr2", "還沒寄出去，網址還能改");

  // 背景函式真的跑完（模擬 Gmail 寄出）之後，網址就固定了
  const after = (await api(`/api/visits?id=2026-11-20-ltr2`, { headers: admin })).body.visit;
  after.letters.confirmation = { ...(after.letters.confirmation || { subject: "s", body: "b", drafted_at: new Date().toISOString() }), sent_at: new Date().toISOString(), sent_to: [{ name: "A", email: "a@example.edu" }] };
  await put(after);
  const fixed = await put({ ...after, code: "ltr3" });
  assert.equal(fixed.body.visit.visit_id, "2026-11-20-ltr2", "確認信寄出去之後網址不再改（對方手上的連結不能失效）");
  assert.equal(fixed.body.url_fixed, true);
});

test("網址還沒用出去就跟著日期與代碼走；不要的那一場直接刪掉", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const a = (await put({ org: { name: "Test Org" }, date: "2026-11-01", code: "tst" })).body.visit;
  assert.equal(a.visit_id, "2026-11-01-tst");

  // 日期打錯再改：網址跟著換，舊的那一筆不會留在列表裡
  const b = (await put({ ...a, date: "2026-11-08" })).body.visit;
  assert.equal(b.visit_id, "2026-11-08-tst");
  assert.equal((await api("/api/visits?id=2026-11-01-tst", { headers: admin })).status, 404, "舊網址不留著");

  // 有人回覆之後網址就固定了——已經有人拿著那個連結
  await api("/api/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: b.visit_id, anonymous: true, suggestion: "第 303 間講太快" }) });
  const c = await put({ ...b, code: "changed" });
  assert.equal(c.body.visit.visit_id, b.visit_id, "已經有人回覆，網址不再跟著改");
  assert.equal(c.body.url_fixed, true);
  assert.equal((await api(`/api/visits?id=${b.visit_id}`, { method: "DELETE", headers: admin })).status, 409, "有回覆的那一場不給刪");

  // 建錯的那一場：刪掉就好
  const d = (await put({ org: { name: "Throwaway" }, date: "2026-12-01", code: "bye" })).body.visit;
  assert.equal((await api(`/api/visits?id=${d.visit_id}`, { method: "DELETE" })).status, 401, "刪除也要 token");
  assert.equal((await api(`/api/visits?id=${d.visit_id}`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal((await api(`/api/visits?id=${d.visit_id}`, { headers: admin })).status, 404);
});

test("暫存：還沒交出去的東西存得住，改網址跟著走，刪掉那一場就一起消失", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const save = (id, fields) => api("/api/draft", { method: "POST", headers: admin, body: JSON.stringify({ id, fields }) });
  const get = (id) => api(`/api/draft?id=${encodeURIComponent(id)}`, { headers: admin });

  assert.equal((await api("/api/draft?id=new")).status, 401, "暫存裡有貼進來的信，一樣要 token");
  assert.equal((await save("../etc/passwd", { emailText: "x" })).status, 400, "id 只收 visit_id 或 new");

  // 還沒有單位名稱、存不成一場的那一份：先擺在 new 底下
  assert.equal((await save("new", { emailText: "Dear Prof. Chang, we would like to visit…", form: { org: { name: "" }, date: "2026-11-20" } })).status, 200);
  const held = (await get("new")).body.draft;
  assert.equal(held.fields.emailText.startsWith("Dear Prof. Chang"), true);
  assert.equal(held.fields.form.date, "2026-11-20");
  assert.ok(held.saved_at, "有時間才比得出站台與這台瀏覽器哪一份新");

  // 存成一場之後改網址代碼：暫存跟著新的 visit_id 走，不然手改過的信會跟著舊網址不見
  const v = (await put({ org: { name: "Draft Org" }, date: "2026-11-20", code: "dft" })).body.visit;
  await save(v.visit_id, { thanksBody: "手改過、還沒寄出的感謝信" });
  const renamed = (await put({ ...v, code: "dft2" })).body.visit;
  assert.equal(renamed.visit_id, "2026-11-20-dft2");
  assert.equal((await get(v.visit_id)).body.draft, null, "舊網址底下不留一份");
  assert.equal((await get(renamed.visit_id)).body.draft.fields.thanksBody, "手改過、還沒寄出的感謝信");

  // 交出去了（寄了、存了）＝前端重新比對，送上來的就是空的 → 這一筆刪掉
  assert.equal((await save(renamed.visit_id, {})).body.draft, null);
  assert.equal((await get(renamed.visit_id)).body.draft, null);

  // 一格最多 20 萬字（貼一封長信的上限，跟 /api/extract 一致），整筆太大就不收——
  // 但要講清楚（前端只在這種情形才吵人，其他失敗有本機那一份頂著）
  const long = "字".repeat(200000);
  assert.equal((await save(renamed.visit_id, { emailText: long + "超過的部分會被切掉" })).body.draft.fields.emailText.length, 200000);
  const tooLong = await save(renamed.visit_id, { emailText: long, transcript: long, confirmBody: long });
  assert.equal(tooLong.status, 413);
  assert.equal(tooLong.body.too_long, true);

  // 整場刪掉：暫存不該留在後面
  await save(renamed.visit_id, { emailText: "還在打的內容" });
  assert.equal((await api(`/api/visits?id=${renamed.visit_id}`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal((await get(renamed.visit_id)).body.draft, null);
  assert.equal((await api(`/api/draft?id=new`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal((await get("new")).body.draft, null);
});

test("參訪清單帶得出「以前做過的」那一列要講的話：選了幾頁、有沒有摘要", async () => {
  const list = (await api("/api/visits", { headers: admin })).body.visits;
  const row = list.find((v) => v.visit_id === visitId);
  assert.ok(row, "剛做過的那一場在清單裡");
  assert.equal(typeof row.slides, "number", "選了幾頁");
  assert.equal(typeof row.summary, "boolean", "有沒有一頁摘要");
  assert.equal(typeof row.guests, "number", "名單幾個人");
  assert.ok(row.slides > 0, "這一場排過行程，選過頁");
  assert.equal(row.type, "university");
});

test("背景工作的規矩：每一支跑得久的 AI 都一樣", async () => {
  const started = await api("/api/summary", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId }) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.job_id;
  const pending = await api(`/api/summary?job=${id}`, { headers: admin });
  assert.equal(pending.body.status, "running");
  assert.equal(pending.body.input, undefined, "輪詢不會把輸入（信件全文、名片原圖的位置）再送回前端");

  // 六支新改的＋原本兩支，查進度與背景函式的規矩一致
  for (const name of ["extract", "plan", "letter", "summary", "signbook", "transcribe", "cards", "translate"]) {
    assert.equal((await api(`/api/${name}?job=${id}`)).status, 401, `${name}：查進度要 token`);
    assert.equal((await api(`/api/${name}?job=zzzzzzzz`, { headers: admin })).status, 404, `${name}：過期或不存在的工作回 404`);
    assert.equal((await api(`/api/${name}-background`, { method: "POST", body: "{}" })).status, 401, `${name}-background：要 token`);
    assert.equal((await api(`/api/${name}-background`, { method: "POST", headers: admin, body: "{}" })).status, 400, `${name}-background：需要 job_id`);
    assert.equal((await api(`/api/${name}-background`, { method: "POST", headers: admin, body: JSON.stringify({ job_id: "zzzzzzzz" }) })).status, 404, `${name}-background：工作不在就不做事`);
  }
});

test("session: 貼一次 ADMIN_TOKEN 就換到 cookie，之後這台瀏覽器不必再授權", async () => {
  assert.equal((await api("/api/session")).status, 401, "no cookie, no token → not signed in");
  const bad = await api("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "nope" }) });
  assert.equal(bad.status, 401);
  assert.ok(!bad.headers.get("set-cookie"), "a wrong token never gets a cookie");

  const ok = await api("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test-token" }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const setCookie = ok.headers.get("set-cookie") || "";
  assert.match(setCookie, /^ghrc_admin=v1\.\d+\.[0-9a-f]{64};/, "cookie is a signed value, never the token itself");
  assert.ok(!setCookie.includes("test-token"), "the admin token never leaves in the cookie");
  assert.ok(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=15552000/.test(setCookie), setCookie);
  const cookie = { cookie: setCookie.split(";")[0] };

  // cookie 就能當授權用：不必再帶 Bearer
  const list = await api("/api/visits", { headers: cookie });
  assert.equal(list.status, 200, "the cookie alone authorises the admin API");
  assert.equal((await api("/api/session", { headers: cookie })).status, 200, "still signed in");
  assert.equal((await api("/api/visits", { headers: { cookie: "ghrc_admin=v1.99999999999999.0000000000000000000000000000000000000000000000000000000000000000" } })).status, 401, "a forged signature is refused");
  assert.equal((await api("/api/visits", { headers: { cookie: "ghrc_admin=v1.1000000000000.deadbeef" } })).status, 401, "an expired or malformed cookie is refused");

  const out = await api("/api/session", { method: "DELETE" });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") || "", /^ghrc_admin=; .*Max-Age=0/, "logout clears the cookie");
});

test("drive: needsSync only fires when something changed after the last backup", async () => {
  const { needsSync, plan } = await import("../netlify/lib/drive.mts");
  const base = { visit_id: "x", date: "2026-11-17", updated_at: "2026-11-17T10:00:00.000Z", org: { name: "X" }, materials: { deck_pdf: "", photos: [], links: [] } };
  assert.equal(needsSync(base, []), true, "never backed up");
  const backed = { ...base, drive: { backed_up_at: "2026-11-17T11:00:00.000Z" } };
  assert.equal(needsSync(backed, []), false, "nothing new since the backup");
  assert.equal(needsSync({ ...backed, updated_at: "2026-11-17T12:00:00.000Z" }, []), true, "the visit changed");
  assert.equal(needsSync(backed, [{ submitted_at: "2026-11-17T12:30:00.000Z" }]), true, "a guest replied");
  assert.equal(needsSync(backed, [{ submitted_at: "2026-11-17T10:30:00.000Z" }]), false, "an older reply is already in the backup");
  assert.deepEqual(plan(base).map((i) => i.name), ["參訪資料.json", "回覆.csv"]);
  // 合照用原始檔名（拿掉上傳時加的時間戳），同名的加序號，不靠流水號——刪掉中間一張才不會蓋到別張
  const full = plan({
    ...base,
    summary: "x",
    signbook: { photo_key: "signbook/x/1.jpg" },
    materials: { deck_pdf: "materials/x/a.pdf", photos: ["materials/x/1789133705833-IMG_0696.jpg", "materials/x/1789134238242-IMG_7836.jpg", "materials/x/1789134999999-IMG_0696.jpg", "https://example.com/p.jpg"], links: [] },
  });
  assert.deepEqual(full.map((i) => i.name), ["參訪資料.json", "回覆.csv", "一頁摘要.md", "簽名簿.jpg", "當天簡報.pdf", "IMG_0696.jpg", "IMG_7836.jpg", "IMG_0696-2.jpg"]);
  assert.equal(full.find((i) => i.name === "IMG_7836.jpg").key, "materials/x/1789134238242-IMG_7836.jpg");
});

test("static: guest page served for /<visit_id> fallback and admin page exists", async () => {
  const r = await fetch(`${base}/${visitId}`);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("text/html"));
  assert.equal((await fetch(`${base}/admin.html`)).status, 200);
});

test.after(() => server.close());
