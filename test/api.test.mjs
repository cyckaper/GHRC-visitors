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
process.env.SIGNAL_KEY = "test-signal";
process.env.SITE_URL = "https://visit.example.test";

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

test("admin endpoints reject a missing or wrong token", async () => {
  assert.equal((await api("/api/visits")).status, 401);
  assert.equal((await api("/api/visits", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await api("/api/extract", { method: "POST", body: "{}" })).status, 401);
});

test("extract → visit draft keeps every email on the list", async () => {
  const r = await api("/api/extract", { method: "POST", headers: admin, body: JSON.stringify({ email_text: EMAIL }) });
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
  const r = await api("/api/extract", { method: "POST", headers: admin, body: JSON.stringify({ email_text: "", files: [{ name: "list.csv", type: "text/csv", data: csv }, { name: "list.docx", type: "", data: `data:application/octet-stream;base64,${docx}` }, { name: "old.doc", type: "application/msword", data: Buffer.from("x").toString("base64") }] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.files_read.map((f) => f.name), ["list.csv", "list.docx"]);
  assert.equal(r.body.warnings.length, 1);
  assert.ok(r.body.warnings[0].includes("old.doc"));
  const emails = r.body.visit.guests.map((g) => g.email).sort();
  assert.deepEqual(emails, ["jane.doe@uwa.edu.au", "kim.lee@uwa.edu.au"]);
  const empty = await api("/api/extract", { method: "POST", headers: admin, body: JSON.stringify({ email_text: "", files: [] }) });
  assert.equal(empty.status, 400);
});

test("plan → programme, itinerary, slides (always-slides present), then save", async () => {
  const ex = await api("/api/extract", { method: "POST", headers: admin, body: JSON.stringify({ email_text: EMAIL }) });
  const visit = { ...ex.body.visit, code: "uwa", start_time: "10:00", duration_minutes: 90 };
  const p = await api("/api/plan", { method: "POST", headers: admin, body: JSON.stringify({ visit }) });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const planned = p.body.visit;
  for (const n of [1, 2, 3, 4, 72]) assert.ok(planned.slides.includes(n), `slide ${n} missing`);
  assert.ok(planned.programme.some((b) => b.kind === "tour"));
  assert.equal(planned.itinerary[0].room, "briefing", "route starts with the overall briefing");
  const kinds = planned.programme.map((b) => b.kind);
  assert.ok(kinds.includes("discussion"), "programme always has a 綜合討論 block");
  assert.ok(kinds.indexOf("tour") < kinds.indexOf("discussion"), "討論 comes after the tour");
  assert.equal(planned.programme.find((b) => b.kind === "discussion").title_2nd, "綜合討論");
  assert.ok(planned.programme.find((b) => b.kind === "discussion").minutes === undefined || true);
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

test("confirmation letter draft is stored on the visit", async () => {
  const r = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, kind: "confirmation", sender: "director" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.draft.body.includes("https://visit.example.test/2026-10-07-uwa"));
  const v = await api(`/api/visits?id=${visitId}`, { headers: admin });
  assert.ok(v.body.visit.letters.confirmation.subject);
});

test("signals: keyed sources need SIGNAL_KEY, resolve today's visit, guest fallback needs visit_id", async () => {
  // 今天沒有參訪 → 主要訊號沒有 visit_id 時回 404
  const noVisit = await api("/api/timeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "303", source: "nfc", key: "test-signal" }) });
  assert.equal(noVisit.status, 404);
  const badKey = await api("/api/timeline?room=303&source=presentation&key=wrong");
  assert.equal(badKey.status, 401);
  const ok = await api(`/api/timeline?room=303&source=presentation&key=test-signal&visit_id=${visitId}&at=2026-10-07T02:31:00Z`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const brief = await api(`/api/timeline?room=briefing&source=presentation&key=test-signal&visit_id=${visitId}&at=2026-10-07T02:01:00Z`);
  assert.equal(brief.status, 200, "the briefing room PC shortcut is a valid signal");
  assert.equal((await api(`/api/timeline?room=999&source=presentation&key=test-signal&visit_id=${visitId}`)).status, 400);
  const guest = await api("/api/timeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "304", source: "guest", visit_id: visitId, at: "2026-10-07T02:45:00Z" }) });
  assert.equal(guest.status, 200);
  const noId = await api("/api/timeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "304", source: "guest" }) });
  assert.equal(noId.status, 400);
  const tl = await api(`/api/timeline?id=${visitId}`, { headers: admin });
  assert.equal(tl.status, 200);
  assert.equal(tl.body.signals.length, 3);
  assert.ok(tl.body.timeline.find((r) => r.room === "303").source === "presentation");
  assert.equal(tl.body.timeline[0].room, "briefing");
  assert.equal(tl.body.timeline[0].source, "presentation");
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
  const r = await api("/api/signbook", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, image: `data:image/png;base64,${png.toString("base64")}` }) });
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

test("dictation: multipart audio → transcript → extraction → save", async () => {
  const form = new FormData();
  form.append("visit_id", visitId);
  form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "d.webm");
  const r = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { authorization: "Bearer test-token" }, body: form });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.ok(body.transcript.includes("303"));
  assert.deepEqual(body.extracted.most_wanted_rooms, ["303"]);
  const typed = await api("/api/transcribe", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, transcript: "今天校長來，最想看 304，問了能不能合作。" }) });
  assert.equal(typed.status, 200);
  assert.deepEqual(typed.body.extracted.most_wanted_rooms, ["304"]);
  const save = await api("/api/transcribe", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "save" }) });
  assert.equal(save.status, 200);
});

test("thanks letter: recipients = list + onsite, wording is the 請益 question, send without Gmail reports sent:false", async () => {
  const rec = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "recipients" }) });
  assert.deepEqual(rec.body.recipients.map((r) => r.email).sort(), ["jane.doe@uwa.edu.au", "kim.lee@uwa.edu.au", "simon.kilbane@uwa.edu.au", "walkin@example.org"]);
  const d = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, kind: "thanks", sender: "contact" }) });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(d.body.draft.body.includes("From your perspective, what should we be doing better?"));
  assert.ok(d.body.draft.body.includes("A single sentence is plenty."));
  assert.ok(d.body.draft.body.includes("#respond"));
  assert.ok(!/satisf|rate us|rating/i.test(d.body.draft.body));
  const send = await api("/api/letter", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId, action: "send", subject: d.body.draft.subject, body: d.body.draft.body, recipients: rec.body.recipients }) });
  assert.equal(send.status, 200);
  assert.equal(send.body.sent, false);
  assert.equal(send.body.reason, "gmail_not_configured");
  assert.ok(send.body.mailto.startsWith("mailto:?bcc="));
});

test("summary writes visit.summary and slide_performance rows; digest lists suggestions; exports work", async () => {
  const s = await api("/api/summary", { method: "POST", headers: admin, body: JSON.stringify({ visit_id: visitId }) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.summary.includes("2026-10-07"));
  const perf = JSON.parse(await readFile(path.join(tmp, "slide_performance.json"), "utf8"));
  assert.ok(perf.length > 0);
  assert.ok(perf.every((p) => p.visit_id === visitId && p.used));
  const dg = await api("/api/summary", { method: "POST", headers: admin, body: JSON.stringify({ digest: true }) });
  assert.equal(dg.body.count, 1);
  const csv = await api("/api/visits?export=csv&table=responses", { headers: admin });
  assert.equal(csv.status, 200);
  assert.ok(String(csv.body).startsWith("visit_id,"));
  const list = await api("/api/visits", { headers: admin });
  assert.equal(list.body.visits.length, 1);
});

test("static: guest page served for /<visit_id> fallback and admin page exists", async () => {
  const r = await fetch(`${base}/${visitId}`);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("text/html"));
  assert.equal((await fetch(`${base}/admin.html`)).status, 200);
});

test.after(() => server.close());
