/**
 * 端到端（不含瀏覽器）：透過本機 dev server 打每一個 function。
 * 用 file 後端（暫存目錄）與 AI_MOCK，完全不需要外部服務。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/**
 * 別的端點或背景工作寫的東西（簽名簿、摘要、提醒紀錄、寄出紀錄……）：一般存檔帶了也不算（visits.mts 的 KEPT），
 * 測試要先擺好這些就直接寫進資料層——跟那些端點一樣走 updateVisit（dev server 跟這裡是同一個程序、同一份 store）。
 */
const { getStore } = await import("../netlify/lib/store.mts");
const seed = (id, change) => getStore().updateVisit(id, (v) => { change(v); });

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

  // 信裡沒有寫哪一天：日期留空、說一聲填上才會存——**不補今天**（以前補了，信裡寫 10/5 的那一場變成當天）
  const undated = await extract({ email_text: "Dear Prof. Chang,\n\nWe would love to visit your center some time.\n\nAnna Lee, University of Testing\nanna.lee@testing.example" });
  assert.equal(undated.body.visit.date, "", JSON.stringify(undated.body.visit.uncertainties));
  assert.ok(undated.body.visit.uncertainties.some((u) => /填上日期才會存/.test(u)));
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

test("行前通告：收件人是這一場動線上的研究室，內容照動線寫；簡報人員回填後回報那一則帶著走", async () => {
  const put = (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const before = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;

  // 收件人＝動線上那幾間的老師（不是五間全寄）
  const rec = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "recipients", kind: "notice" }) });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  const rooms = rec.body.recipients.map((r) => r.room);
  const onRoute = before.itinerary.filter((s) => s.room !== "briefing" && s.minutes > 0).map((s) => s.room);
  assert.deepEqual(rooms, onRoute, "只寄給這一場會走到的那幾間");
  assert.ok(rec.body.recipients.every((r) => r.start && r.end), "每一間都帶自己的時段，通告才寫得出來");

  // 通告：中文、條列、貼得進 LINE；動線每一間都在
  const notice = await runJob("letter", { visit_id: visitId, kind: "notice", sender: "director" });
  assert.equal(notice.status, 200, JSON.stringify(notice.body));
  const body = notice.body.draft.body;
  assert.ok(body.startsWith("各位老師好："), "開頭固定這一句");
  // 結尾就是「一句話＋支援人力表的連結」（明確指示，字照給的寫）——後面沒有接龍、回覆期限、署名
  assert.match(body, new RegExp(`\\n請各研究室回覆，該時段由哪位老師或人員接待\\nhttps://visit\\.example\\.test/rota\\?key=[a-z0-9]{24}#${visitId}$`), "最後一段是那一句話與直接跳到這一場的連結，後面什麼都不接");
  assert.ok(!/接龍|前回覆|張俊彥|Chun-Yen|Director/.test(body), "不要接龍、不要回覆期限、不要署名（貼進中心自己的 LINE 群組，誰發的大家都看得到）");
  // 動線照今日流程的區塊列，**研究室參訪是一整段**——還沒問到人就把各室時間寫死是先斬後奏
  assert.ok(/當天動線（時間已排定）：/.test(body) && /研究室參訪（/.test(body), "動線照流程區塊列，研究室參訪不拆到各室");
  assert.ok(/尚未分配到各室/.test(body), "…並說明各室時段之後才補");
  const saved = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;
  assert.ok(saved.letters.notice.body, "草稿存回這一場");
  assert.ok(!saved.letters.notice.sent_at, "草擬不算寄出");

  // 回填接待人員（走支援人力表那一支；整筆存檔帶了也不算）→ 回報那一則就帶著走。
  // 用一場遠在將來的複本：支援人力表不收已經結束的場次，測試不能哪天因為日期過了就壞掉
  const fut = (await put({ ...saved, visit_id: "", code: "rundown", date: "2099-10-07", org: { ...saved.org, name: "Rundown Future University" } })).body.visit;
  const sneak = await put({ ...fut, presenters: { [onRoute[0]]: "從整筆存檔偷塞的" } });
  assert.deepEqual(sneak.body.visit.presenters, {}, "接待人員只有 /api/rota 在寫，整筆存檔帶了也不算");
  const who = await api("/api/rota", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: fut.visit_id, room: onRoute[0], name: "王小明" }) });
  assert.equal(who.status, 200, JSON.stringify(who.body));
  const rundown = await runJob("letter", { visit_id: fut.visit_id, kind: "rundown" });
  const rb = rundown.body.draft.body;
  assert.ok(rb.includes("王小明"), "回報那一則要寫出接待人員");
  assert.ok(rb.includes("（待補）"), "還沒回覆的那幾間標待補，不要留白");
  assert.ok(!/張俊彥 Chun-Yen|Director/.test(rb), "回報也不署名");
  await api(`/api/visits?id=${fut.visit_id}`, { method: "DELETE", headers: admin });

  await put(before); // 擺回去，後面的測試照原本那一份跑
});

test("老師卡片：公開讀得到，後台改過的疊在 repo 那一份上面，改回原稿就退回去", async () => {
  // 公開（來賓專頁與 /lab/<房號> 都讀這一支）
  const pub = await api("/api/labs");
  assert.equal(pub.status, 200);
  assert.equal(pub.body.labs.length, 5);
  const before = pub.body.labs.find((l) => l.room === "303");
  assert.equal(before.lead.name_zh, "陳惠美");

  // 沒有 token 不給改
  assert.equal((await api("/api/labs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "303", fields: { one_line_zh: "x" } }) })).status, 401);

  const save = (body) => api("/api/labs", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const r = await save({
    room: "303",
    fields: {
      one_line_zh: "在模擬室裡把療癒環境做成可以驗證的東西。",
      expertise_zh: ["景觀模擬", "  ", "VR 教材"],
      papers: [{ title: "A paper", venue: "LUP", url: "https://doi.org/10.1/x" }, { title: "沒有網址的不要", venue: "", url: "" }],
      confirmed: true,
      room: "999", // 改不到房號：不在可改欄位裡
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = r.body.labs.find((l) => l.room === "303");
  assert.equal(after.one_line_zh, "在模擬室裡把療癒環境做成可以驗證的東西。");
  assert.deepEqual(after.expertise_zh, ["景觀模擬", "VR 教材"], "空白那一行丟掉");
  assert.equal(after.papers.length, 1, "沒有網址的論文不收");
  assert.equal(after.confirmed, true);
  assert.equal(after.room, "303", "房號、顏色、名稱只跟 repo 那一份走");
  assert.equal(after.color, before.color);
  assert.equal(after.one_line_en, before.one_line_en, "沒改的欄位不動");

  // 照片的 key 要長得對，/api/media 才給公開
  const bad = await save({ room: "303", fields: { photo: "cards/2026-10-07-uwa/1.jpg" } });
  assert.equal(bad.body.labs.find((l) => l.room === "303").photo, "", "只收 labs/<房號>/<檔名> 或 https");

  assert.equal((await save({ room: "399", fields: {} })).status, 400, "只有 301–305");

  const reset = await save({ room: "303", reset: true });
  assert.equal(reset.body.labs.find((l) => l.room === "303").one_line_zh, before.one_line_zh, "改回原稿");
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
  // 頁面上真的有的才承諾：305 在 labs.json 有公開信箱（老師自己的 CV 上就印著），
  // 其餘四間沒有，所以這一句在不在，要看這一場走到哪幾間
  const has305 = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit.itinerary.some((s) => String(s.room) === "305");
  assert.equal(/contact details/.test(d.body.draft.body), has305, "只有走到有公開信箱的那一間，信裡才提得到聯絡方式");
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
  assert.ok(r.body.hint.includes("連上 Google"), "the hint points at the settings button, not at env vars");
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
  assert.ok(r.body.error.includes("連上 Google"), "says where to fix it: the button on the settings tab, not an env var list");
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

  // 「研究室老師的信箱」「影片連結」明確指示拿掉了：送了也不收，以前存過的也不再帶出去
  const legacy = JSON.parse(await readFile(path.join(tmp, "media", "settings.json"), "utf8"));
  await writeFile(path.join(tmp, "media", "settings.json"), JSON.stringify({ ...legacy, lab_emails: { 301: "old@ntu.edu.tw" }, video_links: { 19: "https://youtu.be/old" } }));
  const cleaned = (await api("/api/settings", { headers: admin })).body.settings;
  assert.ok(!("lab_emails" in cleaned) && !("video_links" in cleaned), "舊的值讀的時候就丟掉");
  const posted = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { lab_emails: { 302: "x@ntu.edu.tw" }, video_links: { 35: "https://youtu.be/x" } } }) });
  assert.ok(!("lab_emails" in posted.body.settings) && !("video_links" in posted.body.settings), "送了也不收");
  assert.ok(!/old@ntu|youtu\.be/.test(await readFile(path.join(tmp, "media", "settings.json"), "utf8")), "下一次存檔就清乾淨");
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
  await seed(v.visit_id, (x) => {
    x.summary = "（測試用摘要）";
    x.summary_at = new Date(Date.now() + 24 * 3600e3).toISOString();
  });
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

    // 四件事都做完的那一場，本來就不該吵（提醒紀錄清掉＝還沒提醒過，四件事是各自的端點寫的）
    await seed(v.visit_id, (x) => {
      x.reminders = {};
      x.signbook = { photo_key: "signbook/x/1.jpg" };
      x.cards = [{ key: "cards/x/1.jpg", names: ["A"], read_at: new Date().toISOString() }];
      x.dictation = { transcript: "今天校長來" };
      x.materials = { deck_pdf: "", photos: [], links: [{ title: "t", url: "https://x.example" }] };
    });
    assert.ok(!String((await cron()).body).includes(v.visit_id), "後續做完了就不必提醒");

    // 什麼都沒有、但四件事都標了「本次沒有」的那一場，也不該吵——沒有簽名簿、沒交換名片很正常
    const na = (await put({ org: { name: "Nothing To Collect University" }, date, code: "nna", start_time: hhmm, duration_minutes: 60 })).body.visit;
    assert.ok(String((await cron()).body).includes(na.visit_id), "先確認它本來會被提醒");
    await seed(na.visit_id, (x) => { x.reminders = {}; });
    const saved = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: na.visit_id, action: "wrapup", na: ["signbook", "cards", "dictation", "materials"] }) });
    assert.deepEqual(saved.body.visit.wrapup.na, ["signbook", "cards", "dictation", "materials"], "標記存得住");
    assert.ok(!String((await cron()).body).includes(na.visit_id), "標了本次沒有就不再提醒");
    await api(`/api/visits?id=${na.visit_id}`, { method: "DELETE", headers: admin });
  } finally {
    delete process.env.MAIL_MOCK;
  }
});

test("開著舊資料的後台分頁自動存檔，不會洗掉確認信的寄出紀錄；網址也不會因此又能改", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Stale Tab University" }, date: "2099-09-01", code: "staletab", guests: [{ name: "A", email: "a@example.edu", contact: true }] })).body.visit;
  // 後台開著的那一份：確認信寄出之前載入的。後台的 readForm() 以前就是把手上這一份**整個**送回來
  const stale = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;

  process.env.MAIL_MOCK = "1"; // 不真的打 Gmail：信寫進媒體庫
  let sent;
  try {
    const draft = await runJob("letter", { visit_id: v.visit_id, kind: "confirmation", sender: "contact" });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const send = await runJob("letter", { visit_id: v.visit_id, action: "send", kind: "confirmation", subject: draft.body.draft.subject, body: draft.body.draft.body, recipients: [{ name: "A", email: "a@example.edu" }] });
    assert.equal(send.body.sent, true, JSON.stringify(send.body));
    sent = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
  } finally {
    delete process.env.MAIL_MOCK;
  }
  assert.ok(sent.letters.confirmation.sent_at, "寄出紀錄記在這一場");
  assert.equal(sent.status, "confirmed", "確認信寄出，狀態跟著改");

  // 訪前分頁改一個字 → 自動存檔送回來的是寄出之前那一份
  const resaved = await put({ ...stale, purpose: "改一個字觸發存檔" });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  const after = resaved.body.visit;
  assert.equal(after.purpose, "改一個字觸發存檔", "存檔本身照常");
  assert.equal(after.letters.confirmation?.sent_at, sent.letters.confirmation.sent_at, "寄出紀錄還在");
  assert.deepEqual(after.letters.confirmation?.sent_to, sent.letters.confirmation.sent_to);
  assert.equal(after.letters.confirmation?.fingerprint, sent.letters.confirmation.fingerprint, "寄出那一刻的行程指紋也在（行程改了才說得出對方手上是舊的）");
  assert.equal(after.status, "confirmed", "狀態沒有被改回 draft");
  assert.equal((await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit.letters.confirmation?.sent_at, sent.letters.confirmation.sent_at, "存進去的也是");

  // 以前寄出紀錄一洗掉，isUnused() 就把網址當成還沒用出去：舊的那一份再存一次、代碼一改就搬家，寄出去的連結失效
  const again = await put({ ...stale, code: "staletab2" });
  assert.equal(again.body.visit.visit_id, v.visit_id, "網址還是固定的");
  assert.equal(again.body.url_fixed, true);
  assert.equal((await api(`/api/visits?id=${v.visit_id}&public=1`)).status, 200, "對方手上那個連結還打得開");
  assert.equal((await api(`/api/visits?id=2099-09-01-staletab2`, { headers: admin })).status, 404, "沒有搬到新網址");
  await getStore().deleteVisit(v.visit_id); // 寄過信的那一場照規矩是固定的，測試自己收掉
});

test("一般存檔不會清掉別的端點寫的東西：帶了舊的、帶了亂填的、沒帶，一律沿用伺服器上那一份", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Keep Fields College" }, date: "2026-08-21", code: "keep" })).body.visit;
  // 後台開著的那一份：下面這些東西寫進去之前載入的
  const stale = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
  // 別的端點與背景工作寫的（摘要、後續提醒、Drive、名片、簽名簿、口述、信件、當天資料、寄信時改的狀態、本次沒有）
  const written = {
    summary: "摘要",
    summary_at: "2026-08-22T00:00:00.000Z",
    reminders: { wrapup_sent_at: "2026-08-21T05:00:00.000Z", wrapup_to: "wrapup@ntu.edu.tw" },
    drive: { folder_id: "f1", backed_up_at: "2026-08-22T01:00:00.000Z", items: 3 },
    cards: [{ key: `cards/${v.visit_id}/1.jpg`, names: ["A"], read_at: "2026-08-21T04:00:00.000Z" }],
    signbook: { photo_key: `signbook/${v.visit_id}/1.jpg`, entries: [{ text: "好", signed_by: "S", language: "zh" }] },
    dictation: { transcript: "今天校長來" },
    letters: { thanks: { subject: "s", body: "b", sender: "director", drafted_at: "2026-08-21T06:00:00.000Z", sent_at: "2026-08-21T07:00:00.000Z", sent_to: [{ name: "A", email: "a@example.edu" }] } },
    materials: { deck_pdf: "", photos: [], links: [{ title: "t", url: "https://x.example" }] },
    status: "done",
    wrapup: { na: ["cards"] },
  };
  await seed(v.visit_id, (x) => Object.assign(x, structuredClone(written)));

  const old = (await put({ ...stale, purpose: "改一個字" })).body.visit; // 舊的那一份整個送回來
  const forged = (await put({ ...stale, summary: "偷塞的摘要", summary_at: "", letters: {}, status: "draft", materials: { deck_pdf: "https://elsewhere.example/x.pdf", photos: [], links: [] }, wrapup: { na: [] }, reminders: {}, drive: {}, signbook: {}, dictation: {}, cards: [] })).body.visit;
  const bare = (await put({ visit_id: v.visit_id, org: { name: "Keep Fields College" }, date: "2026-08-21", code: "keep" })).body.visit; // 只送表單那幾格
  for (const [label, got] of [["舊的那一份", old], ["帶了亂填的", forged], ["沒帶", bare]]) {
    for (const k of Object.keys(written)) assert.deepEqual(got[k], written[k], `${label}：${k} 沿用伺服器上那一份`);
  }
  assert.equal(old.purpose, "改一個字", "表單那幾格照常存");
  assert.equal((await api(`/api/visits?id=${v.visit_id}`, { method: "DELETE", headers: admin })).status, 409, "感謝信寄出去了就不給刪——這一道也靠寄出紀錄，洗掉了就擋不住");

  // 新的一場從空的開始：拿別場的整份當底建一場，不會把那一場的信件與檔案一起帶過來
  // （檔案的 key 是那一場的——刪掉這一場時會連那一場的照片、簽名簿一起刪）
  const copy = (await put({ ...bare, visit_id: "", code: "keepcopy" })).body.visit;
  assert.equal(copy.visit_id, "2026-08-21-keepcopy");
  assert.deepEqual([copy.summary, copy.letters, copy.signbook, copy.dictation, copy.status, copy.wrapup], ["", {}, {}, {}, "draft", { na: [] }]);
  assert.deepEqual(copy.materials, { deck_pdf: "", photos: [], links: [] });
  assert.ok(!("cards" in copy) && !("reminders" in copy) && !("drive" in copy) && !("summary_at" in copy), "名片、提醒、Drive 都不跟著過來");
  assert.equal((await api(`/api/visits?id=${copy.visit_id}`, { method: "DELETE", headers: admin })).status, 200);
  await getStore().deleteVisit(v.visit_id);
});

test("「本次沒有」走自己的那一支：只動 wrapup；一般存檔帶什麼都不算", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const mark = (body, headers = admin) => api("/api/visits", { method: "POST", headers, body: JSON.stringify({ action: "wrapup", ...body }) });
  const v = (await put({ org: { name: "Not This Time College" }, date: "2099-08-02", code: "natime", purpose: "原本的目的" })).body.visit;
  const stale = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit;
  assert.equal((await mark({ visit_id: v.visit_id, na: ["cards"] }, { "content-type": "application/json" })).status, 401, "要 token");
  assert.equal((await mark({ visit_id: "2099-01-01-nope", na: ["cards"] })).status, 404);
  assert.equal((await mark({ visit_id: "../x", na: ["cards"] })).status, 400);

  const r = await mark({ visit_id: v.visit_id, na: ["signbook", "cards", "nonsense"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.visit.wrapup.na, ["signbook", "cards"], "只收認得的那四件事");
  assert.equal(r.body.visit.purpose, "原本的目的", "其他欄位不動");
  // 後續分頁以前是把手上那一份整筆送回一般存檔：那一份是舊的，帶著的 wrapup 也不算
  const resaved = (await put({ ...stale, wrapup: { na: [] }, purpose: "改一個字" })).body.visit;
  assert.deepEqual(resaved.wrapup.na, ["signbook", "cards"], "舊的那一份蓋不掉剛標的");
  assert.deepEqual((await mark({ visit_id: v.visit_id, na: [] })).body.visit.wrapup.na, [], "改回「還要做」也走這一支");
  await api(`/api/visits?id=${v.visit_id}`, { method: "DELETE", headers: admin });
});

test("訪前功課：還沒存檔就查好的跟著存檔進去（查完之前自動存檔先建好這一場也一樣）；舊分頁的那一份蓋不掉新的", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  // 查的時候還沒存檔（畫面上連單位名稱都還沒打）：結果只在畫面上，存檔時跟著進去
  const { ok, ...early } = (await runJob("research", { visit: { org: { name: "Early Research Institute" }, guests: [{ name: "X" }] } })).body;
  assert.equal(early.status, "done");
  const first = (await put({ org: { name: "Early Research Institute" }, date: "2099-08-03", code: "early", background: early })).body.visit;
  assert.equal(first.background.researched_at, early.researched_at, "新的一場：第一次存檔帶進去");
  // 單位名稱一打完就自動存檔（伺服器上還沒有研判），查完之後那一次存檔才帶著結果來
  const raced = (await put({ org: { name: "Raced Research Institute" }, date: "2099-08-04", code: "raced" })).body.visit;
  assert.ok(!raced.background);
  const filled = (await put({ ...raced, background: early })).body.visit;
  assert.equal(filled.background.researched_at, early.researched_at, "伺服器上還沒有研判：收");

  // 存過檔的那一場再查一次（research-background 直接寫回這一場）；開著舊資料的分頁送回來的是比較舊的那一份
  const rerun = await runJob("research", { visit_id: raced.visit_id });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
  const fresh = (await api(`/api/research?id=${raced.visit_id}`, { headers: admin })).body.background;
  assert.ok(fresh.researched_at > early.researched_at);
  assert.equal((await put({ ...filled, purpose: "改一個字" })).body.visit.background.researched_at, fresh.researched_at, "舊的那一份蓋不掉新的");
  // 還在查（「查資料中」記在這一場上）的時候也一樣
  assert.equal((await api("/api/research", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: raced.visit_id }) })).status, 202);
  assert.equal((await put({ ...filled, purpose: "再改一個字" })).body.visit.background.status, "running", "蓋不掉「查資料中」");
  for (const id of [first.visit_id, raced.visit_id]) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
});

test("簡報（deck）只有簡報分頁在寫：訪前分頁的存檔不送也洗不掉；勾「不用簡報」只改那一格；指紋只由伺服器蓋", async () => {
  const put = async (body) => api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(body) });
  const v = (await put({ org: { name: "Deck Keep College" }, date: "2099-08-05", code: "deckkeep" })).body.visit;
  const stale = (await api(`/api/visits?id=${v.visit_id}`, { headers: admin })).body.visit; // 還沒產檔時載入的（deck 是空的）
  const made = (await put({ ...stale, deck: { generated_at: "2099-08-01T00:00:00.000Z", slides: 12 } })).body.visit;
  assert.ok(made.deck.fingerprint, "產檔：伺服器蓋指紋");
  const { deck: _deck, ...form } = made;
  assert.deepEqual((await put({ ...form, purpose: "改一個字" })).body.visit.deck, made.deck, "沒帶 deck（訪前分頁的存檔）：產檔紀錄與指紋都還在");
  assert.deepEqual((await put({ ...stale, purpose: "再改一個字" })).body.visit.deck, made.deck, "舊的那一份帶著空的 deck：也洗不掉");
  const skipped = (await put({ ...form, deck: { skip: true } })).body.visit;
  assert.deepEqual(skipped.deck, { ...made.deck, skip: true }, "勾「不用簡報」只改 skip");
  assert.equal((await put({ ...form, deck: { fingerprint: "forged" } })).body.visit.deck.fingerprint, made.deck.fingerprint, "送來的指紋不算");
  await api(`/api/visits?id=${v.visit_id}`, { method: "DELETE", headers: admin });
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

  // 真的寄出去之後（MAIL_MOCK：背景函式照常跑完，只是不打 Gmail），網址就固定了
  process.env.MAIL_MOCK = "1";
  try {
    const sent = await runJob("letter", { visit_id: "2026-11-20-ltr2", action: "send", kind: "confirmation", subject: draft.body.draft.subject, body: draft.body.draft.body, recipients: [{ name: "A", email: "a@example.edu" }] });
    assert.equal(sent.body.sent, true, JSON.stringify(sent.body));
  } finally {
    delete process.env.MAIL_MOCK;
  }
  const after = (await api(`/api/visits?id=2026-11-20-ltr2`, { headers: admin })).body.visit;
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
  for (const name of ["extract", "plan", "letter", "summary", "signbook", "transcribe", "cards", "translate", "import"]) {
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

test("支援人力表：連結自動產生、才打得開，各室只填接待人員與共需幾分鐘，後台舊資料蓋不掉，過去的擋在伺服器", async () => {
  // 空 key 不能當通行證（不然產生之前誰都打得開）；亂猜、不帶也一樣
  assert.equal((await api("/api/rota?key=")).status, 403, "空的連結打不開");
  assert.equal((await api("/api/rota?key=whatever")).status, 403, "亂猜的連結打不開");
  assert.equal((await api("/api/rota")).status, 403, "連 key 都沒帶也一樣");

  // **連結自動產生**（明確要求）：打開設定就有，不必先按什麼；再打開一次還是同一個
  const auto = (await api("/api/settings", { headers: admin })).body.settings.rota_key;
  assert.match(auto, /^[a-z0-9]{24}$/, "打開設定就有一個猜不到的連結");
  assert.equal((await api("/api/settings", { headers: admin })).body.settings.rota_key, auto, "…而且一直是同一個（不會每打開一次就換掉、讓貼出去的連結失效）");
  // 沒有「收回」：送空的過去不會把連結拿掉
  await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { rota_key: "" } }) });
  assert.equal((await api("/api/settings", { headers: admin })).body.settings.rota_key, auto, "送空的不會收回連結");
  // 外流時「重新產生」換一個，舊的立刻失效
  const made = await api("/api/settings", { method: "POST", headers: admin, body: JSON.stringify({ settings: { rota_key: "new" } }) });
  const key = made.body.settings.rota_key;
  assert.match(key, /^[a-z0-9]{24}$/);
  assert.notEqual(key, auto, "重新產生會換一個");
  assert.equal((await api(`/api/rota?key=${auto}`)).status, 403, "舊的連結立刻失效");

  // 用一場遠在將來的：支援人力表不收已經結束的場次，測試不能哪天因為日期過了就壞掉
  const src = (await api(`/api/visits?id=${visitId}`, { headers: admin })).body.visit;
  const fid = (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...src, visit_id: "", code: "rotafuture", date: "2099-10-07", org: { ...src.org, name: "Future Rota University" } }) })).body.visit.visit_id;
  // 後台手上那一份：老師還沒填之前載入的（等一下拿它整份存回去）
  const stale = (await api(`/api/visits?id=${fid}`, { headers: admin })).body.visit;

  const list = await api(`/api/rota?key=${key}`);
  assert.equal(list.status, 200);
  const row = list.body.visits.find((v) => v.visit_id === fid);
  assert.ok(row, "這一場在表上");
  // 列出要走哪幾間，但**不印各室排定的時段**：通告說「尚未分配到各室」，各室回報要多少時間才排得出來
  assert.ok(row.stops.length && row.stops.every((s) => /^30[1-5]$/.test(s.room) && !("start" in s) && !("minutes" in s)), "只有房號，沒有各室的時段");
  assert.equal(row.planned, true, "排好行程的那一場只列動線上那幾間");
  // **行程還沒排的那一場，五間都列出來**（明確指示：還沒填的也要看得到，才知道有填沒填）——
  // 以前這種場次只有一句「行程還沒排」，老師從通告點進來沒地方填
  const bareId = (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name: "Unplanned Rota University" }, date: "2099-10-08", code: "unplanned", start_time: "10:00", end_time: "12:00" }) })).body.visit.visit_id;
  const bare = (await api(`/api/rota?key=${key}`)).body.visits.find((v) => v.visit_id === bareId);
  assert.deepEqual(bare.stops.map((s) => s.room), ["301", "302", "303", "304", "305"], "行程還沒排：五間都列出來");
  assert.equal(bare.planned, false);
  await api(`/api/visits?id=${bareId}`, { method: "DELETE", headers: admin });
  // 連結轉出去就擋不住，所以表上不放名單與 email
  assert.ok(!("guests" in row) && !JSON.stringify(row).includes("@"), "表上沒有來賓名單與 email");

  // 各室只填兩件事（明確指示）：接待人員、共需幾分鐘
  const room = row.stops[0].room;
  const put1 = await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: fid, room, name: "王小明" }) });
  assert.equal(put1.status, 200, JSON.stringify(put1.body));
  const put2 = await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: fid, room, minutes: "２５ 分" }) });
  assert.equal(put2.body.presenters[room], "王小明", "只送分鐘不會把人名洗掉——兩個人同時填不同格子不該互相蓋");
  assert.equal(put2.body.lab_minutes[room], 25, "「２５ 分」存成 25");
  assert.ok(!("lab_hours" in put2.body), "不再問「方便的時段」");
  assert.equal((await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: fid, room, minutes: "二十" }) })).status, 400, "分鐘填一個數字就好");
  assert.equal((await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: fid, room: "999", name: "x" }) })).status, 400, "房號只有 301–305");

  // **後台開著舊資料改一個字自動存檔，不會蓋掉老師剛填的**——後台的 readForm() 是把手上那一份整個送回來的，
  // 裡面的 presenters／lab_minutes 是老師填之前的樣子
  const resaved = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...stale, purpose: "改一個字觸發存檔" }) });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  const after = (await api(`/api/visits?id=${fid}`, { headers: admin })).body.visit;
  assert.equal(after.purpose, "改一個字觸發存檔", "存檔本身照常");
  assert.equal(after.presenters[room], "王小明", "…老師填的人名還在");
  assert.equal(after.lab_minutes[room], 25, "…分鐘也還在");

  // 清空＝拿掉那一格
  const cleared = await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: fid, room, minutes: "" }) });
  assert.ok(!(room in cleared.body.lab_minutes) && cleared.body.presenters[room] === "王小明", "分鐘清空就拿掉那一格，人名不動");

  // 已經結束的那一場不給改——畫面灰掉只是提示，擋要擋在伺服器
  const past = { ...stale, visit_id: "", code: "pastrota", date: "2020-01-01", org: { ...stale.org, name: "Past Rota Institute" } };
  const pastId = (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(past) })).body.visit.visit_id;
  const blocked = await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: pastId, room: "301", name: "太晚了" }) });
  assert.equal(blocked.status, 409, "過去的場次改不動");
  const both = await api(`/api/rota?key=${key}`);
  assert.equal(both.body.visits.find((v) => v.visit_id === pastId).past, true, "…而且表上標成已結束");
  await api(`/api/visits?id=${pastId}`, { method: "DELETE", headers: admin });

  // 通告**自動帶上連結**，後面接 #<visit_id>：點進去直接跳到這一場。連結就是通告的最後一行
  const notice = await runJob("letter", { visit_id: fid, kind: "notice" });
  const nb = notice.body.draft.body;
  assert.ok(nb.endsWith(`請各研究室回覆，該時段由哪位老師或人員接待\nhttps://visit.example.test/rota?key=${key}#${fid}`), `通告最後就是那一句話與直接指到這一場的連結：${nb.slice(-160)}`);
  assert.ok(!/請點這個連結填寫|接龍/.test(nb), "不再有「點連結怎麼填」的說明與接龍");

  await api(`/api/visits?id=${fid}`, { method: "DELETE", headers: admin });
});

test("研究室填的分鐘自動排進行程與來賓專頁；後台手上的舊資料蓋不掉，看過之後主辦端改的照他的", async () => {
  const key = (await api("/api/settings", { headers: admin })).body.settings.rota_key;
  const programme = [
    { kind: "briefing", start: "14:00", end: "14:20", title_en: "Welcome and centre overview", title_2nd: "歡迎與中心總體介紹", rooms: [] },
    { kind: "tour", start: "14:20", end: "15:00", title_en: "Laboratory visits", title_2nd: "研究室參訪", rooms: ["301", "303"] },
    { kind: "discussion", start: "15:00", end: "15:30", title_en: "General discussion", title_2nd: "綜合討論", rooms: [] },
  ];
  const itinerary = [{ room: "briefing", minutes: 20, location: "302" }, { room: "301", minutes: 20 }, { room: "303", minutes: 20 }];
  const made = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name: "Autofill Rota University" }, date: "2099-11-03", code: "autofill", start_time: "14:00", end_time: "15:30", programme, itinerary }) });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.visit.visit_id;
  const stale = made.body.visit; // 後台手上那一份：研究室還沒填之前的
  const span = (b) => `${b.start}–${b.end}`;
  const minutesOf = (v, room) => (v.itinerary.find((s) => String(s.room) === room) || {}).minutes;

  // 301 在支援人力表上填「共需 35 分」：動線改成 35、研究室參訪那一段拉長、後面往後推
  assert.equal((await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: id, room: "301", minutes: "35" }) })).status, 200);
  let v = (await api(`/api/visits?id=${id}`, { headers: admin })).body.visit;
  assert.equal(minutesOf(v, "301"), 35, "動線上 301 改成研究室填的分鐘");
  assert.deepEqual(v.programme.map(span), ["14:00–14:20", "14:20–15:15", "15:15–15:45"], "今日流程從開始時間往後重推");
  assert.deepEqual(v.programme[1].rooms, ["301", "303"]);
  // 來賓專頁的參訪流程是同一份（各間的時段由動線推出來），研究室填的欄位本身不公開
  const pub = (await api(`/api/visits?id=${id}&public=1`)).body.visit;
  assert.deepEqual(pub.programme.map(span), ["14:00–14:20", "14:20–15:15", "15:15–15:45"], "來賓專頁看到的是更新過的流程");
  assert.equal(minutesOf(pub, "301"), 35);
  assert.ok(!("lab_minutes" in pub) && !("presenters" in pub) && !("lab_minutes_at" in pub), "研究室填的那幾格不進來賓專頁");

  // 305 不在動線上（行程沒排它），但研究室填了：照房號插進動線
  await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: id, room: "305", minutes: "15" }) });
  v = (await api(`/api/visits?id=${id}`, { headers: admin })).body.visit;
  assert.deepEqual(v.itinerary.map((s) => s.room), ["briefing", "301", "303", "305"], "照房號插進去");
  assert.deepEqual(v.programme[1].rooms, ["301", "303", "305"]);
  assert.equal(span(v.programme[1]), "14:20–15:30");

  // 後台開著舊的那一份（兩間都還沒填時載入的）改一個字自動存檔：研究室填的分鐘不會被蓋回去
  const resaved = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...stale, purpose: "改一個字" }) });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  assert.deepEqual([...resaved.body.rota_applied].sort(), ["301", "305"], "回報哪幾間是研究室剛填的（後台據此說一聲為什麼行程變了）");
  v = (await api(`/api/visits?id=${id}`, { headers: admin })).body.visit;
  assert.equal(v.purpose, "改一個字", "存檔本身照常");
  assert.equal(minutesOf(v, "301"), 35, "301 還是研究室填的 35");
  assert.equal(minutesOf(v, "305"), 15, "305 也還在");
  assert.equal(span(v.programme[1]), "14:20–15:30", "今日流程照研究室填的重推");

  // 看過之後（手上是最新的那一份）主辦端要改就照他的
  const host = { ...v, itinerary: v.itinerary.map((s) => (s.room === "301" ? { ...s, minutes: 25 } : s)) };
  const edited = await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(host) });
  assert.deepEqual(edited.body.rota_applied, [], "已經看過了，不算研究室剛填的");
  assert.equal(minutesOf(edited.body.visit, "301"), 25, "主辦端改的照他的");

  // AI 排行程也蓋不掉研究室填的分鐘（預設每間 20 分那一套只管研究室沒填的）
  const planned = await plan(edited.body.visit);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const pv = planned.body.visit;
  assert.equal(minutesOf(pv, "301"), 35, "301 照研究室填的");
  assert.equal(minutesOf(pv, "305"), 15, "305 照研究室填的");
  const tour = pv.programme.find((b) => b.kind === "tour");
  assert.equal(tour.rooms.length, pv.itinerary.filter((s) => s.room !== "briefing" && s.minutes > 0).length, "研究室參訪那一段列的就是動線");
  assert.ok((planned.body.warnings || []).some((w) => w.includes("301、305") && w.includes("研究室")), `排完說一聲哪幾間照研究室填的：${planned.body.warnings}`);
  assert.equal(pv.lab_minutes["301"], 35, "排完回來的那一份帶著研究室填的，畫面上的「研究室填」標記才對得上");

  // 支援人力表：主辦端排了 301、303，301 也填了——這一場仍然是「排好了」，其他間不會又冒出「未填」
  const rowOf = async (vid) => (await api(`/api/rota?key=${key}`)).body.visits.find((x) => x.visit_id === vid);
  let row = await rowOf(id);
  assert.equal(row.planned, true);
  assert.deepEqual(row.stops.map((x) => x.room), ["301", "303", "305"], "動線上的三間（305 是研究室自己填進來的）");

  // 清空分鐘＝還沒回：主辦端排的那一間不動（說不定本來就要去）；只因為研究室填了才排進去的，跟著拿掉
  await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: id, room: "301", minutes: "" }) });
  await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: id, room: "305", minutes: "" }) });
  v = (await api(`/api/visits?id=${id}`, { headers: admin })).body.visit;
  assert.ok(!("301" in v.lab_minutes) && !("305" in v.lab_minutes) && !("305" in v.lab_minutes_at), "兩格都拿掉了");
  assert.equal(minutesOf(v, "301"), 25, "主辦端排的 301 不動");
  assert.deepEqual(v.itinerary.map((s) => s.room), ["briefing", "301", "303"], "研究室自己填進來的 305 跟著拿掉");
  assert.deepEqual(v.programme[1].rooms, ["301", "303"]);
  assert.equal(span(v.programme[1]), "14:20–15:05", "流程跟著縮回來（301 主辦端改的 25 ＋ 303 的 20）");

  // 行程還沒排研究室的那一場：第一間一填就排進動線，但其他四間的格子不能因此不見
  const bareId = (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name: "Bare Autofill University" }, date: "2099-11-04", code: "bareauto", start_time: "10:00", end_time: "12:00" }) })).body.visit.visit_id;
  await api(`/api/rota?key=${key}`, { method: "POST", body: JSON.stringify({ visit_id: bareId, room: "302", minutes: "20" }) });
  const bare = (await api(`/api/visits?id=${bareId}`, { headers: admin })).body.visit;
  assert.deepEqual(bare.itinerary.map((s) => s.room), ["briefing", "302"], "302 排進動線");
  assert.ok(bare.programme.some((b) => b.kind === "tour" && b.rooms.join() === "302"), "還沒有流程的先照預設排一份，研究室參訪那一段就是 302");
  row = await rowOf(bareId);
  assert.equal(row.planned, false, "只有研究室自己填進來的，不算主辦端排好了");
  assert.deepEqual(row.stops.map((x) => x.room), ["301", "302", "303", "304", "305"], "五間都還看得到格子");

  for (const x of [id, bareId]) await api(`/api/visits?id=${x}`, { method: "DELETE", headers: admin });
});

test("訪客地圖：每個單位查一次位置（背景工作），單位改名就重查；整筆存檔帶什麼 geo 都不算", async () => {
  const mk = async (name, country, date, code) => (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name, country }, date, code, start_time: "10:00", end_time: "11:30" }) })).body.visit.visit_id;
  const a = await mk("Konkuk University", "South Korea", "2099-12-01", "geoa");
  const b = await mk("Konkuk University", "South Korea", "2099-12-02", "geob");
  const c = await mk("Nowhere Horticultural Society", "Japan", "2099-12-03", "geoc");
  const listed = async () => new Map((await api("/api/visits", { headers: admin })).body.visits.map((v) => [v.visit_id, v]));
  let rows = await listed();
  assert.ok(rows.get(a).geo_stale && rows.get(c).geo_stale && rows.get(a).geo === null, "新的一場還沒查位置");

  const run = await runJob("geo", {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.updated >= 3 && run.body.remaining === 0, JSON.stringify(run.body));
  rows = await listed();
  for (const id of [a, b]) {
    const g = rows.get(id).geo;
    assert.ok(Math.abs(g.lat - 37.54) < 0.01 && Math.abs(g.lon - 127.08) < 0.01 && g.precision === "site" && /首爾/.test(g.place), `同一個單位兩場都落在首爾：${JSON.stringify(g)}`);
    assert.equal(rows.get(id).geo_stale, false);
  }
  const unknown = rows.get(c).geo;
  assert.deepEqual([unknown.lat, unknown.lon, unknown.precision], [null, null, "country"], "查不到城市的：只知道國家（地圖放在國家的位置），不編座標");
  assert.equal(rows.get(c).geo_stale, false, "查不到也記下來，不必每打開一次就再問一次");
  const again = await api("/api/geo", { method: "POST", headers: admin, body: "{}" });
  assert.equal(again.status, 200);
  assert.equal(again.body.pending, 0, "都查過了就不開工作");

  // 後台送回來的那一份一律不算（只有 geo-background 在寫）
  const full = (await api(`/api/visits?id=${a}`, { headers: admin })).body.visit;
  await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...full, purpose: "改一個字", geo: { key: full.geo.key, lat: 1, lon: 2, place: "亂填", precision: "site" } }) });
  const kept = (await api(`/api/visits?id=${a}`, { headers: admin })).body.visit.geo;
  assert.equal(kept.place, full.geo.place, "存檔帶來的 geo 不算，沿用伺服器上那一份");
  // 單位改了名字：查的是別的單位，要重查
  await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...full, org: { ...full.org, name: "Seoul National University" } }) });
  assert.equal((await listed()).get(a).geo_stale, true, "改了名字就要重查");
  // 來賓端看不到（名單以外的東西本來就不給，這個也一樣）
  assert.ok(!("geo" in (await api(`/api/visits?id=${b}&public=1`)).body.visit));

  for (const id of [a, b, c]) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
});

test("中心首頁的世界地圖（公開）：只列已經來過的單位、所在地與來過幾次；日期、名單、email、目的一律不給", async () => {
  const mk = async (org, date, code) => (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org, date, code, start_time: "10:00", end_time: "11:30", guests: [{ name: "Private Person", email: "private.person@example.org", role: "lead" }], purpose: "a confidential purpose" }) })).body.visit.visit_id;
  const konkuk = { name: "Konkuk University", name_local: "건국대학교", country: "South Korea" };
  const ids = [await mk(konkuk, "2025-04-21", "pubmapa"), await mk(konkuk, "2025-11-25", "pubmapb"), await mk({ name: "Ministry of Something", country: "Japan" }, "2099-12-01", "pubmapc")];
  const r = await api("/api/visitor-map"); // 不帶任何授權：首頁誰都打得開
  assert.equal(r.status, 200);
  const rows = r.body.institutions;
  const row = rows.find((x) => x.name === "Konkuk University");
  assert.ok(row && row.visits === 2 && row.country === "South Korea" && row.local === "건국대학교", `同一個單位來過兩次合成一筆：${JSON.stringify(rows)}`);
  assert.deepEqual(Object.keys(row).sort(), ["country", "geo", "local", "name", "visits"], "只給地圖用得到的欄位");
  assert.ok(!rows.some((x) => x.name === "Ministry of Something"), "還沒來的不先公告（部長級的行程不該先出現在首頁上）");
  assert.doesNotMatch(JSON.stringify(r.body), /private|@|confidential|2025-04-21|2025-11-25|visit_id|headcount|guests|purpose/i, "名單、email、日期、目的一律不給");
  assert.match(r.headers.get("cache-control") || "", /public/, "公開的，可以讓 CDN 幫忙擋");
  for (const id of ids) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
});

test("同一個單位英文拼法不一樣（實際發生過：惇陽工程兩場）：首頁地圖、來訪紀錄、資料分頁都算一個單位", async () => {
  const mk = async (name, date, code) => (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name, name_local: "測試工程顧問有限公司", country: "Taiwan", type: "enterprise" }, date, code, start_time: "10:00", end_time: "11:30" }) })).body.visit.visit_id;
  const ids = [await mk("Ce Shi Engineering Consultants Co., Ltd.", "2025-09-23", "sameorga"), await mk("Ceshi Engineering Consultants Co., Ltd.", "2025-09-30", "sameorgb")];
  const rows = (await api("/api/visitor-map")).body.institutions.filter((x) => x.local === "測試工程顧問有限公司");
  assert.equal(rows.length, 1, `首頁地圖上一個點：${JSON.stringify(rows)}`);
  assert.equal(rows[0].visits, 2);
  assert.equal(rows[0].name, "Ceshi Engineering Consultants Co., Ltd.", "名稱照最近那一場的寫法");
  const orgs = (await api("/api/visit-log")).body.visits.flatMap((e) => e.orgs).filter((o) => o.local === "測試工程顧問有限公司");
  assert.ok(orgs.length === 2 && orgs[0].inst && orgs[0].inst === orgs[1].inst, `來訪紀錄上兩場帶同一個單位代碼：${JSON.stringify(orgs)}`);
  const listed = (await api("/api/visits", { headers: admin })).body.visits.filter((v) => ids.includes(v.visit_id));
  assert.ok(listed.length === 2 && listed[0].inst && listed[0].inst === listed[1].inst, "資料分頁的地圖照同一個代碼合成一個點");
  for (const id of ids) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
});

test("資料一改就清掉公開頁的快取：匯入、改公開說明、改或刪來過的那一場才清；還沒來的存再多次也不清；瀏覽器不留", async () => {
  const realFetch = globalThis.fetch;
  const purges = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://api.netlify.com/api/v1/purge")) {
      purges.push({ auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response("", { status: 202 });
    }
    return realFetch(url, init);
  };
  process.env.NETLIFY_PURGE_API_TOKEN = "purge-token"; // Netlify 在函式執行環境裡給的；本機沒有就什麼都不做
  process.env.SITE_ID = "site-123";
  try {
    for (const p of ["/api/visit-log", "/api/visitor-map"]) {
      const r = await api(p);
      assert.equal(r.headers.get("netlify-cache-tag"), "public-visits", `${p} 要帶得清的標籤`);
      assert.match(r.headers.get("cache-control") || "", /max-age=0/, `${p}：瀏覽器不留，CDN 清掉之後重新整理就是新的`);
      assert.match(r.headers.get("netlify-cdn-cache-control") || "", /s-maxage/, `${p}：CDN 照樣擋`);
    }
    const mk = async (date, code) => (await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ org: { name: "Purge Test University", country: "Japan" }, date, code, start_time: "10:00", end_time: "11:30" }) })).body.visit;
    const future = await mk("2099-03-01", "purgefuture");
    await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...future, purpose: "改一個字" }) });
    assert.equal(purges.length, 0, "還沒來的那一場不在公開頁上，存再多次也不清");
    const past = await mk("2025-03-01", "purgepast");
    assert.equal(purges.length, 1, "已經來過的那一場一存就清");
    assert.deepEqual(purges[0], { auth: "Bearer purge-token", body: { site_id: "site-123", cache_tags: ["public-visits"] } });
    await api("/api/visit-log", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: past.visit_id, public: { note_zh: "說明" } }) });
    assert.equal(purges.length, 2, "改公開頁上的說明就清");
    const geo = await runJob("geo", {});
    assert.ok(geo.body.updated >= 1, JSON.stringify(geo.body));
    assert.equal(purges.length, 3, "查到位置就清：地圖上的點換到查到的地方");
    await api(`/api/visits?id=${past.visit_id}`, { method: "DELETE", headers: admin });
    assert.equal(purges.length, 4, "刪掉來過的那一場也清");
    await api(`/api/visits?id=${future.visit_id}`, { method: "DELETE", headers: admin });
    assert.equal(purges.length, 4, "刪掉還沒來的不清");

    const { pastVisitsXlsx } = await import("./fixtures/past-visits.mjs");
    const file = { name: "GHRC-參訪名單.xlsx", data: (await pastVisitsXlsx()).toString("base64") };
    const read = await runJob("import", { file });
    assert.equal(purges.length, 4, "讀完只是預覽，還沒寫進去，不清");
    const done = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ action: "commit", file: file.name, rows: read.body.rows }) });
    assert.equal(done.body.created.length, 3);
    assert.equal(purges.length, 5, "匯入完就清：首頁的地圖與來訪紀錄頁重新整理就看得到");
    for (const id of done.body.created) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NETLIFY_PURGE_API_TOKEN;
    delete process.env.SITE_ID;
  }
});

test("匯入以前的參訪名單：讀完只給預覽，勾好才寫進去；一列有好幾個單位就拆開、算同一場；兩張地圖都看得到；重複匯入不會多出東西", async () => {
  const { pastVisitsXlsx } = await import("./fixtures/past-visits.mjs");
  const file = { name: "GHRC-參訪名單.xlsx", data: (await pastVisitsXlsx()).toString("base64") };
  assert.equal((await api("/api/import", { method: "POST", body: JSON.stringify({ file }) })).status, 401, "要 token");
  const read = await runJob("import", { file });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const rows = read.body.rows;
  assert.equal(read.body.file, "GHRC-參訪名單.xlsx");
  assert.equal(rows.length, 4, `第 1 列拆成兩個單位，第二張工作表（統計）不算：${JSON.stringify(rows.map((r) => r.org.name_local))}`);
  const [uiuc, helsinki, jorjin, nodate] = rows;
  assert.ok(uiuc.split && helsinki.split && uiuc.source_row === helsinki.source_row, "同一列拆出來的，source_row 一樣");
  assert.equal(uiuc.date, "2024-01-08", "日期格子存的是 45299，要照格式轉回日期");
  assert.equal(helsinki.org.country, "芬蘭", "照單位名稱開頭的國名分");
  assert.deepEqual(uiuc.people, [{ name: "John A. Smith", title: "教授" }], "來訪人員照括號裡的單位分");
  assert.equal(jorjin.org.type, "enterprise");
  assert.equal(jorjin.org.name_local, "佐臻股份有限公司", "括號裡的說明拿掉");
  assert.deepEqual(nodate.problems, ["沒有日期"]);
  assert.equal(nodate.visit_id, "", "沒有日期的不能匯入");
  assert.ok(uiuc.visit_id && helsinki.visit_id && uiuc.visit_id !== helsinki.visit_id, "同一天的兩筆網址不能撞在一起");
  assert.equal((await api("/api/visits", { headers: admin })).body.visits.filter((v) => v.imported).length, 0, "讀完只是預覽，還沒有寫進去");

  const done = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ action: "commit", file: file.name, rows }) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.created.length, 3);
  assert.deepEqual(done.body.skipped.map((x) => x.reason), ["沒有日期"], "沒有日期的那一筆送上來也不建");

  const list = (await api("/api/visits", { headers: admin })).body.visits.filter((v) => v.imported);
  assert.equal(list.length, 3);
  const g = list.filter((v) => v.date === "2024-01-08");
  assert.ok(g.length === 2 && g[0].group && g[0].group === g[1].group, "同一列拆出來的那兩筆 group 相同（資料分頁算一場）");
  assert.ok(list.every((v) => v.geo_stale), "匯入之後位置照舊由 /api/geo 去查");
  const one = (await api(`/api/visits?id=${list.find((v) => v.org === "佐臻股份有限公司").visit_id}`, { headers: admin })).body.visit;
  assert.equal(one.status, "done");
  assert.equal(one.headcount, 1, "只有一個有名字的人、沒有其他人");
  assert.equal(one.contact_teacher, "", "原表沒寫對口老師就不補");
  assert.equal(one.purpose, "參訪 303 與 304");
  assert.equal(one.imported.from, "GHRC-參訪名單.xlsx");
  assert.equal(one.imported.people, "王大明副總經理");
  assert.deepEqual(one.guests.map((x) => x.name), ["王大明"]);

  // 一般存檔沒帶 imported 也不會把它清掉
  const { imported, ...rest } = one;
  await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...rest, purpose: "參訪 303 與 304（改過）" }) });
  assert.equal((await api(`/api/visits?id=${one.visit_id}`, { headers: admin })).body.visit.imported?.row, "2");

  // 中心首頁的地圖：都是過去的參訪，所以都列；支援人力表：系統上線之前的，不列
  const pub = (await api("/api/visitor-map")).body.institutions.map((x) => x.name);
  assert.ok(["美國伊利諾大學", "芬蘭赫爾辛基大學", "佐臻股份有限公司"].every((n) => pub.includes(n)), JSON.stringify(pub));
  const rota = (await api("/api/rota", { headers: admin })).body.visits;
  assert.ok(!rota.some((v) => list.some((x) => x.visit_id === v.visit_id)), "支援人力表不列匯入的舊紀錄");

  // 同一份再匯入一次：同一天、同一個單位的已經有了，不重複建立
  const again = await runJob("import", { file });
  assert.equal(again.body.rows.filter((r) => r.exists).length, 3, JSON.stringify(again.body.rows.map((r) => [r.org.name_local, r.exists])));
  const twice = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ action: "commit", file: file.name, rows: again.body.rows }) });
  assert.equal(twice.body.created.length, 0);

  // 不是試算表／文字的檔：直接說，不開工作
  const pdf = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ file: { name: "list.pdf", data: Buffer.from("%PDF-1.4").toString("base64") } }) });
  assert.equal(pdf.status, 400);
  assert.match(pdf.body.error, /試算表/);

  for (const v of list) await api(`/api/visits?id=${v.visit_id}`, { method: "DELETE", headers: admin });
});

test("參訪名單（Google 試算表）：匯入時存成一份，之後有人加一列就自己加進來；沒改就不讀；改舊的那一列、勾掉的那一筆不會被加回來", async () => {
  const { pastVisitsXlsx } = await import("./fixtures/past-visits.mjs");
  const { mockSheetWrite } = await import("../netlify/lib/drive.mts");
  const { getStore } = await import("../netlify/lib/store.mts");
  const post = (body) => api("/api/visit-list", { method: "POST", headers: admin, body: JSON.stringify(body) });
  assert.equal((await api("/api/visit-list")).status, 401, "要 token");
  assert.equal((await api("/api/visit-list", { headers: admin })).body.configured, false, "Google Drive 還沒接好");
  process.env.DRIVE_MOCK = "1"; // 不真的打 Google：「Drive 上的試算表」存在媒體庫
  const ids = [];
  try {
    const st0 = (await api("/api/visit-list", { headers: admin })).body;
    assert.ok(st0.configured && !st0.linked);
    assert.equal((await post({ action: "check" })).status, 409, "還沒連上名單");

    // 匯入照舊：先預覽、勾好才寫——主辦端把赫爾辛基那一筆勾掉了
    const file = { name: "GHRC-參訪名單.xlsx", data: (await pastVisitsXlsx()).toString("base64") };
    const read = await runJob("import", { file });
    const rows = read.body.rows.filter((r) => r.org.name_local !== "芬蘭赫爾辛基大學");
    const done = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ action: "commit", file: file.name, rows }) });
    assert.equal(done.body.created.length, 2, JSON.stringify(done.body));
    ids.push(...done.body.created);

    // 同時存成 Google 試算表
    const link = await runJob("visit-list", { action: "link", file });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const st = (await api("/api/visit-list", { headers: admin })).body;
    assert.ok(st.linked && st.file_id && /docs\.google\.com\/spreadsheets/.test(st.url), JSON.stringify(st));
    assert.equal(st.name, "GHRC 參訪名單");
    assert.equal(st.from, "GHRC-參訪名單.xlsx");
    assert.equal(st.rows, 3, "這份檔裡現在有的列都算讀過了（含勾掉的那一筆與沒寫日期的那一列）");
    assert.ok(!("seen" in st), "讀過哪幾列那一長串不必送給後台");
    assert.equal((await post({ action: "link", file })).body.file_id, st.file_id, "已經連上了就不另外再建一份");
    assert.equal((await post({ action: "link", file: { name: "list.docx", data: file.data } })).body.file_id, st.file_id);

    // 沒人改過：當場回，不開工作
    const same = await post({ action: "check" });
    assert.equal(same.status, 200);
    assert.equal(same.body.unchanged, true);

    // 有人在試算表裡加了一列，也順手改了佐臻那一列的交流重點
    const edited = await pastVisitsXlsx({ extra: [[4, 45930, "國際", "日本", "日本千葉大學園藝學院", "山田太郎教授", "", "園藝療法交流"]], jorjinPurpose: "參訪 303、304（改過）" });
    await mockSheetWrite(st.file_id, new Uint8Array(edited));
    const synced = await runJob("visit-list", { action: "check" });
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    ids.push(...synced.body.added);
    assert.equal(synced.body.added.length, 1, `只有新加的那一列；改了交流重點的不是新的一列，勾掉的赫爾辛基也不會被偷偷加回來：${JSON.stringify(synced.body)}`);
    const v = (await api(`/api/visits?id=${synced.body.added[0]}`, { headers: admin })).body.visit;
    assert.equal(v.org.name_local, "日本千葉大學園藝學院");
    assert.equal(v.date, "2025-09-30");
    assert.equal(v.imported.from, "GHRC 參訪名單");
    assert.equal(v.public?.note_zh, "園藝療法交流", "交流重點跟匯入的一樣帶過來（公開頁要用）");
    assert.ok((await api("/api/visit-log")).body.visits.some((e) => e.orgs.some((o) => o.local === "日本千葉大學園藝學院")), "公開的來訪紀錄上看得到");
    const after = (await api("/api/visit-list", { headers: admin })).body;
    assert.equal(after.rows, 4);
    assert.deepEqual(after.last.added, synced.body.added, "後台那一行寫得出上一次加了幾筆");
    assert.ok(!after.error && !after.running_since);

    // 再看一次：讀過了；「現在就看一次」不管修改時間，但沒有新的列就什麼都不加
    assert.equal((await post({ action: "check" })).body.unchanged, true);
    const forced = await runJob("visit-list", { action: "sync" });
    assert.equal(forced.body.added.length, 0);

    // 排程與「打開資料分頁」剛好同時讀：只讓一輪讀，同一列不會建兩次
    const twoRows = await pastVisitsXlsx({ extra: [[4, 45930, "國際", "日本", "日本千葉大學園藝學院", "山田太郎教授", "", "園藝療法交流"], [5, 45931, "國內", "臺灣", "某某科技大學", "", "", ""]] });
    await mockSheetWrite(st.file_id, new Uint8Array(twoRows));
    const jobs = [await post({ action: "sync" }), await post({ action: "sync" })];
    await Promise.all(jobs.map((j) => api("/api/visit-list-background", { method: "POST", headers: admin, body: JSON.stringify({ job_id: j.body.job_id }) })));
    const results = await Promise.all(jobs.map(async (j) => (await api(`/api/visit-list?job=${j.body.job_id}`, { headers: admin })).body.result));
    const both = results.flatMap((r) => r.added || []);
    ids.push(...both);
    assert.equal(both.length, 1, `兩輪同時讀，新的那一列只建一次：${JSON.stringify(results)}`);
    assert.ok(results.some((r) => r.busy), "另一輪讓給正在讀的那一輪");

    // 排程那一支：要授權；名單沒改過就不開工作
    assert.equal((await api("/api/visit-list-cron")).status, 401);
    assert.match(String((await api("/api/visit-list-cron", { method: "POST", headers: admin, body: "{}" })).body), /沒有改過/);
  } finally {
    delete process.env.DRIVE_MOCK;
    await getStore().deleteMedia("sync/visit-list.json");
    for (const id of ids) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
  }
});

test("連上 Google：後台按一下走 Google 的同意畫面，refresh token 存在站台；過期了講人話、設定分頁看得出來；金鑰不外流", async () => {
  const { getStore } = await import("../netlify/lib/store.mts");
  const realFetch = globalThis.fetch;
  let refresh = "ok"; // 換 access token 時 Google 怎麼回：ok／expired
  const exchanged = [];
  const jwt = (o) => ["e30", Buffer.from(JSON.stringify(o)).toString("base64url"), "sig"].join(".");
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "authorization_code") {
        exchanged.push(Object.fromEntries(body));
        return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-secret-1", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send", id_token: jwt({ email: "center@example.test" }) }), { status: 200 });
      }
      if (refresh === "expired") return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: `at-${body.get("refresh_token")}`, expires_in: 3600 }), { status: 200 });
    }
    if (String(url).startsWith("https://gmail.googleapis.com/")) {
      // 這個用戶端的專案沒有啟用 Gmail API（Google 實際回的樣子）
      return new Response(JSON.stringify({ error: { code: 403, message: "Gmail API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403 });
    }
    return realFetch(url, init);
  };
  const manual = (p, headers = {}) => api(p, { redirect: "manual", headers });
  try {
    assert.equal((await manual("/api/google-auth?start=1")).status, 401, "要登入");
    assert.equal((await manual("/api/google-auth?start=1", admin)).status, 409, "Netlify 環境變數裡沒有 OAuth 用戶端");
    // Google 說 redirect_uri_mismatch 時，要看得出網站用的是哪一個用戶端（實際踩過：主控台裡不只一個，網址加錯了一個）：
    // 設定分頁寫出用戶端 ID 的開頭與它在 Netlify 的哪一個環境變數。只有寄信那一組時用的就是那一組
    process.env.GMAIL_CLIENT_ID = "123456789012-gmailclientabcdef.apps.googleusercontent.com";
    process.env.GMAIL_CLIENT_SECRET = "gmail-secret-1";
    const g0 = (await api("/api/settings", { headers: admin })).body.status.google;
    assert.deepEqual({ hint: g0.client_hint, from: g0.client_from }, { hint: "123456789012-gmailcl…", from: "GMAIL_CLIENT_ID" });
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = "client-1.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret-1";
    const st0 = (await api("/api/settings", { headers: admin })).body.status;
    assert.deepEqual({ drive: st0.drive, gmail: st0.gmail, connected: st0.google.connected, client: st0.google.client }, { drive: false, gmail: false, connected: false, client: true }, "只有用戶端、還沒連上");
    assert.deepEqual({ hint: st0.google.client_hint, from: st0.google.client_from, uri: st0.google.redirect_uri }, { hint: "client-1.apps.google…", from: "GOOGLE_CLIENT_ID", uri: "https://visit.example.test/api/google-auth" }, "GOOGLE_ 那一組優先");
    assert.ok(!JSON.stringify(st0).includes("client-1.apps.googleusercontent.com") && !JSON.stringify(st0).includes("client-secret-1"), "用戶端 ID 只給開頭，密鑰不給");
    const start = await manual("/api/google-auth?start=1", admin);
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(to.searchParams.get("client_id"), "client-1.apps.googleusercontent.com");
    assert.equal(to.searchParams.get("redirect_uri"), "https://visit.example.test/api/google-auth");
    assert.equal(to.searchParams.get("redirect_uri"), st0.google.redirect_uri, "設定分頁叫人去登記的，就是導到 Google 時帶的那一條");
    assert.match(to.searchParams.get("scope"), /drive\.file/);
    assert.match(to.searchParams.get("scope"), /gmail\.send/);
    assert.equal(to.searchParams.get("access_type"), "offline");
    assert.equal(to.searchParams.get("prompt"), "consent", "每次都要給 refresh token");
    const state = to.searchParams.get("state");

    // 導回來：state 不對、被改過、或沒有允許
    const back = async (q) => new URL((await manual(`/api/google-auth?${q}`)).headers.get("location"));
    // 簽章最後一個字換成別的（原本是 0 就換 1——直接換成 0 的話，十六次有一次根本沒改到，CI 上就遇到過）
    const tampered = state.slice(0, -1) + (state.endsWith("0") ? "1" : "0");
    assert.equal((await back(`code=x&state=${encodeURIComponent(tampered)}`)).searchParams.get("google"), "expired", "簽章對不上");
    assert.equal((await back("error=access_denied")).searchParams.get("google"), "denied");
    assert.equal(exchanged.length, 0, "state 不對就不去換");

    // 正常導回來：換到 refresh token、存起來；同一個 state 用第二次就不算
    const ok = await back(`code=auth-code-1&state=${encodeURIComponent(state)}`);
    assert.equal(ok.pathname, "/admin.html");
    assert.equal(ok.searchParams.get("google"), "ok");
    assert.equal(exchanged.length, 1);
    assert.equal(exchanged[0].redirect_uri, "https://visit.example.test/api/google-auth");
    assert.equal((await back(`code=auth-code-1&state=${encodeURIComponent(state)}`)).searchParams.get("google"), "expired", "一次性");

    // 設定分頁：連上了、哪個帳號、能用；不回任何金鑰
    const st = await api("/api/settings", { headers: admin });
    assert.deepEqual({ connected: st.body.status.google.connected, ok: st.body.status.google.ok, email: st.body.status.google.email, via: st.body.status.google.via }, { connected: true, ok: true, email: "center@example.test", via: "stored" });
    assert.doesNotMatch(JSON.stringify(st.body), /rt-secret-1|client-secret-1|at-rt/, "refresh token、密鑰、access token 都不出去");
    assert.equal((await api("/api/media?key=secrets/google.json", { headers: admin })).status, 400, "存下來的那一份不經過 /api/media");
    // 環境變數裡沒有 refresh token、只在後台連上，也算接好——Drive 備份與寄信不會被當成「沒設定」略過
    assert.deepEqual({ drive: st.body.status.drive, gmail: st.body.status.gmail }, { drive: true, gmail: true });
    // 授權是哪一個用戶端給的，就要在那一個專案裡啟用 Gmail API——沒啟用時講人話，不是一串 JSON
    const { gmailSend } = await import("../netlify/lib/mail.mts");
    await assert.rejects(gmailSend("someone@example.test", "主旨", "內文"), (e) => /還沒啟用 Gmail API/.test(e.message) && !/PERMISSION_DENIED/.test(e.message));

    // 過期了：設定分頁寫「授權過期」；Drive 那邊的錯誤講人話，不是一串 invalid_grant
    refresh = "expired";
    await getStore().deleteMedia("secrets/google.json");
    process.env.GOOGLE_REFRESH_TOKEN = "rt-env-expired"; // 環境變數那一份過期了（九月就是這樣）
    const st2 = (await api("/api/settings", { headers: admin })).body.status.google;
    assert.ok(st2.connected && !st2.ok && st2.expired && st2.via === "env", JSON.stringify(st2));
    const file = { name: "list.csv", data: Buffer.from("日期,來訪單位\n2024-01-08,美國伊利諾大學\n").toString("base64") };
    const started = await api("/api/visit-list", { method: "POST", headers: admin, body: JSON.stringify({ action: "link", file }) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await api("/api/visit-list-background", { method: "POST", headers: admin, body: JSON.stringify({ job_id: started.body.job_id }) });
    const job = (await api(`/api/visit-list?job=${started.body.job_id}`, { headers: admin })).body;
    assert.equal(job.status, "error");
    assert.match(job.error, /Google 的授權過期了/);
    assert.match(job.error, /重新連上 Google/);
    assert.doesNotMatch(job.error, /invalid_grant/);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]) delete process.env[k];
    await getStore().deleteMedia("secrets/google.json");
    await getStore().deleteMedia("sync/visit-list.json");
  }
});

test("來訪紀錄（公開）：匯入的帶原表的說明，同一列拆出來的算一場；後台可以改說明、整場不公開；名單與 email 不出去", async () => {
  const { pastVisitsXlsx } = await import("./fixtures/past-visits.mjs");
  const file = { name: "GHRC-參訪名單.xlsx", data: (await pastVisitsXlsx()).toString("base64") };
  const read = await runJob("import", { file });
  const done = await api("/api/import", { method: "POST", headers: admin, body: JSON.stringify({ action: "commit", file: file.name, rows: read.body.rows }) });
  assert.equal(done.body.created.length, 3, JSON.stringify(done.body));
  const ids = done.body.created;

  const log = await api("/api/visit-log"); // 不帶任何授權：公開頁誰都打得開
  assert.equal(log.status, 200);
  assert.match(log.headers.get("cache-control") || "", /public/);
  const ws = log.body.visits.find((e) => e.date === "2024-01-08");
  assert.ok(ws && ws.orgs.length === 2, `研討會那一列拆成兩個單位，但是同一場：${JSON.stringify(log.body.visits)}`);
  assert.equal(ws.note.zh, "研討會講者", "交流重點照原表");
  assert.match(ws.people.zh, /John A\. Smith 教授/);
  const jorjin = log.body.visits.find((e) => e.orgs.some((o) => o.local === "佐臻股份有限公司"));
  assert.equal(jorjin.people.zh, "王大明副總經理");
  // 比的是欄位名稱（單位代碼是小寫的名稱，「Summary Cron University」那種測試用的名字不算）
  assert.doesNotMatch(JSON.stringify(log.body), /"(visit_id|purpose|guests|headcount|background|summary)"|@/, "名單、email、來訪目的、背景研判、摘要、visit_id 一律不給");
  assert.ok(!log.body.visits.some((e) => e.orgs.some((o) => ids.includes(o.inst))), "單位代碼不是 visit_id");

  assert.equal((await api("/api/visit-log", { method: "POST", body: JSON.stringify({ visit_id: ids[0], public: { hidden: true } }) })).status, 401, "改要 token");
  const jid = ids.find((id) => id.startsWith("2025-02-26"));
  const hide = await api("/api/visit-log", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: jid, public: { people_zh: "王大明副總經理", note_zh: "參訪 303 與 304", hidden: true } }) });
  assert.equal(hide.status, 200, JSON.stringify(hide.body));
  assert.ok(!(await api("/api/visit-log")).body.visits.some((e) => e.orgs.some((o) => o.local === "佐臻股份有限公司")), "標了不公開就不列");
  assert.ok(!(await api("/api/visitor-map")).body.institutions.some((x) => x.local === "佐臻股份有限公司"), "首頁的地圖也不畫");

  // 同一場（原表同一列拆出來的）：交流重點一起改，來訪人員各自留著
  const [a, b] = ids.filter((id) => id.startsWith("2024-01-08"));
  await api("/api/visit-log", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: a, public: { people_zh: "改過的講者", note_zh: "改過的重點", note_en: "Edited focus" } }) });
  const other = (await api(`/api/visits?id=${b}`, { headers: admin })).body.visit.public;
  assert.equal(other.note_zh, "改過的重點");
  assert.equal(other.note_en, "Edited focus");
  assert.notEqual(other.people_zh, "改過的講者");
  // 一般存檔不會把公開說明清掉，也不會用手上那一份舊的蓋回去（「訪前」開著的那一份是改之前讀的）
  const va = (await api(`/api/visits?id=${a}`, { headers: admin })).body.visit;
  const { public: _p, ...rest } = va;
  await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify(rest) });
  assert.equal((await api(`/api/visits?id=${a}`, { headers: admin })).body.visit.public?.note_zh, "改過的重點");
  await api("/api/visits", { method: "POST", headers: admin, body: JSON.stringify({ ...rest, public: { note_zh: "舊的那一份", hidden: true } }) });
  const kept = (await api(`/api/visits?id=${a}`, { headers: admin })).body.visit.public;
  assert.ok(kept.note_zh === "改過的重點" && !kept.hidden, "公開說明只有 /api/visit-log 在寫");

  for (const id of ids) await api(`/api/visits?id=${id}`, { method: "DELETE", headers: admin });
});
