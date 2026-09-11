import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTimeline, plannedEntries } from "../lib/timeline.mjs";
import { makeVisitId, isValidVisitId, sanitizeResponse, publicVisit, recipientList, toCSV, wrapupICS, ensureBriefingFirst, briefingBlockMinutes, emptyVisit, allocateProgramme, sanitizeMaterials, pageContents, DEFAULT_BRIEFING_LOCATION } from "../lib/visit.mjs";

const visit = {
  visit_id: "2026-10-07-uwa",
  date: "2026-10-07",
  start_time: "10:00",
  duration_minutes: 90,
  programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "11:00" }],
  itinerary: [{ room: "briefing", minutes: 20, location: "304" }, { room: "301", minutes: 10 }, { room: "302", minutes: 10 }, { room: "303", minutes: 10 }, { room: "304", minutes: 10 }],
  guests: [
    { name: "Simon Kilbane", title: "Programme Director", email: "simon@uwa.example", role: "lead" },
    { name: "A. Companion", title: "", email: "companion@uwa.example", role: "member" },
    { name: "No Email", title: "", email: "", role: "member" },
  ],
  org: { name: "University of Western Australia", type: "university", country: "Australia" },
  letters: { thanks: { subject: "s", body: "b" } },
  dictation: { transcript: "secret" },
};

test("plannedEntries starts with the briefing at the visit start and chains room minutes", () => {
  const rows = plannedEntries(visit);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].room, "briefing");
  assert.equal(rows[0].planned.toISOString(), "2026-10-07T02:00:00.000Z");
  assert.equal(rows[1].planned.toISOString(), "2026-10-07T02:20:00.000Z");
  assert.equal(rows[4].planned.toISOString(), "2026-10-07T02:50:00.000Z");
});

test("legacy itinerary without a briefing step still starts at the tour block", () => {
  const rows = plannedEntries({ ...visit, itinerary: visit.itinerary.slice(1) });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].planned.toISOString(), "2026-10-07T02:20:00.000Z");
});

test("programme allocation: 20 + 5×20 + photo, remainder to 綜合討論; shrinks rooms first when short", () => {
  const a = allocateProgramme(150, 5);
  assert.deepEqual([a.briefing, a.perRoom, a.photo, a.discussion], [20, 20, 5, 25]);
  const b = allocateProgramme(180, 5);
  assert.equal(b.discussion, 55);
  const c = allocateProgramme(90, 5); // 不夠：研究室縮到 11 分，綜合討論保底 10
  assert.deepEqual([c.briefing, c.perRoom, c.photo, c.discussion], [20, 11, 5, 10]);
  const d = allocateProgramme(45, 5); // 更短：沒合照，研究室 5 分，總體介紹縮到 10
  assert.deepEqual([d.briefing, d.perRoom, d.photo, d.discussion], [10, 5, 0, 10]);
  const e = allocateProgramme(120, 3);
  assert.deepEqual([e.briefing, e.perRoom, e.photo, e.discussion], [20, 20, 5, 35]);
  assert.equal(emptyVisit().duration_minutes, 150);
  assert.ok(emptyVisit().itinerary.slice(1).every((s) => s.minutes === 20));
});

test("the route always starts with a briefing step", () => {
  assert.equal(emptyVisit().itinerary[0].room, "briefing");
  const fixed = ensureBriefingFirst([{ room: "301", minutes: 8 }, { room: "briefing", minutes: 15 }, { room: "302", minutes: 8 }], 20);
  assert.deepEqual(fixed.map((s) => s.room), ["briefing", "301", "302"]);
  assert.equal(fixed[0].minutes, 15);
  const added = ensureBriefingFirst([{ room: "301", minutes: 8 }], 25);
  assert.equal(added[0].room, "briefing");
  assert.equal(added[0].minutes, 25);
  assert.equal(briefingBlockMinutes(visit.programme), 20);
  assert.equal(briefingBlockMinutes([]), null);
});

test("the briefing is in 302 unless the organiser says otherwise", () => {
  assert.equal(DEFAULT_BRIEFING_LOCATION, "302");
  assert.equal(emptyVisit().itinerary[0].location, "302");
  assert.equal(ensureBriefingFirst([{ room: "301", minutes: 8 }])[0].location, "302");
  assert.equal(ensureBriefingFirst([{ room: "briefing", minutes: 20, location: "" }])[0].location, "302");
  assert.equal(ensureBriefingFirst([{ room: "briefing", minutes: 20, location: "304" }])[0].location, "304", "an explicit location is kept");
});

test("materials: only media keys or https links survive; the page-contents list only names what is really there", () => {
  const m = sanitizeMaterials({ deck_pdf: "materials/2026-11-17-new/1-slides.pdf", photos: ["javascript:alert(1)", "https://drive.example/photo.jpg", "materials/2026-11-17-new/2-photo.jpg"], links: [{ title: "", url: "https://x.example/paper" }, { title: "ftp", url: "ftp://no" }, { title: "Lab 303 papers", url: "https://x.example/303" }] });
  assert.equal(m.deck_pdf, "materials/2026-11-17-new/1-slides.pdf");
  assert.deepEqual(m.photos, ["https://drive.example/photo.jpg", "materials/2026-11-17-new/2-photo.jpg"]);
  assert.deepEqual(m.links.map((l) => l.title), ["x.example/paper", "Lab 303 papers"]);
  assert.deepEqual(sanitizeMaterials(undefined), { deck_pdf: "", photos: [], links: [] });
  assert.equal(sanitizeMaterials({ deck_pdf: "http://insecure.example/x.pdf" }).deck_pdf, "http://insecure.example/x.pdf");
  assert.equal(sanitizeMaterials({ deck_pdf: "../etc/passwd" }).deck_pdf, "");

  const labs = { labs: [{ room: "301", lead: { email: "" }, papers: [] }, { room: "303", lead: { email: "hm@ntu.example" }, papers: [{ title: "p", url: "https://x" }] }] };
  const bare = pageContents({ itinerary: [{ room: "briefing" }, { room: "301" }] }, labs).map((c) => c.key);
  assert.deepEqual(bare, ["programme", "respond"], "301 only: no papers, no contacts, nothing uploaded");
  const full = pageContents({ materials: m, itinerary: [{ room: "briefing" }, { room: "301" }, { room: "303" }] }, labs).map((c) => c.key);
  assert.deepEqual(full, ["programme", "deck_pdf", "photos", "links", "papers", "contacts", "respond"]);
  const p = publicVisit({ ...visit, materials: { deck_pdf: "materials/2026-10-07-uwa/a.pdf", photos: ["bad"], links: [] } });
  assert.deepEqual(p.materials, { deck_pdf: "materials/2026-10-07-uwa/a.pdf", photos: [], links: [] });
});

test("no signals → the schedule itself, source schedule", () => {
  const t = reconcileTimeline(visit, []);
  assert.equal(t.length, 5);
  assert.ok(t.every((r) => r.source === "schedule"));
  assert.equal(t[0].room, "briefing");
  assert.equal(t[0].minutes, 20);
  assert.equal(t[1].minutes, 10);
});

test("one NFC tap shifts every later room and sets exit of the previous room", () => {
  const t = reconcileTimeline(visit, [{ room: "302", at: "2026-10-07T02:36:00Z", source: "nfc" }]);
  const r301 = t.find((r) => r.room === "301");
  const r302 = t.find((r) => r.room === "302");
  const r303 = t.find((r) => r.room === "303");
  assert.equal(r302.source, "nfc");
  assert.equal(r301.exit, r302.enter);
  assert.equal(r301.minutes, 16);
  assert.equal(r303.enter, "2026-10-07T02:46:00.000Z"); // 平移 +6 分鐘
  assert.equal(r303.source, "schedule");
});

test("primary signal beats fallback signal for the same room; earliest primary wins", () => {
  const t = reconcileTimeline(visit, [
    { room: "301", at: "2026-10-07T02:19:00Z", source: "guest" },
    { room: "301", at: "2026-10-07T02:22:00Z", source: "presentation" },
    { room: "301", at: "2026-10-07T02:21:30Z", source: "nfc" },
  ]);
  const r301 = t.find((r) => r.room === "301");
  assert.equal(r301.source, "nfc");
  assert.equal(r301.enter, "2026-10-07T02:21:30.000Z");
  assert.equal(t.find((r) => r.room === "briefing").exit, r301.enter, "briefing ends when the first lab is entered");
});

test("visit id generation and validation", () => {
  assert.equal(makeVisitId("2026-10-07", "University of Western Australia"), "2026-10-07-western");
  assert.equal(makeVisitId("2026-10-07", "University of Western Australia", "UWA"), "2026-10-07-uwa");
  assert.equal(makeVisitId("2026-10-07", "臺北市立建國高級中學"), "2026-10-07-visit");
  assert.ok(isValidVisitId("2026-10-07-uwa"));
  assert.ok(!isValidVisitId("../etc"));
  assert.ok(!isValidVisitId("2026-10-07-UWA"));
});

test("anonymous responses carry no name, email, or time of day", () => {
  const row = sanitizeResponse({ visit_id: "2026-10-07-uwa", anonymous: true, name: "Simon", email: "simon@uwa.example", suggestion: "302 was hard to follow", cooperate_rooms: ["302", "999"] }, new Date("2026-10-08T03:04:05Z"));
  assert.equal(row.name, "");
  assert.equal(row.email, "");
  assert.equal(row.submitted_at, "2026-10-08");
  assert.deepEqual(row.cooperate_rooms, ["302"]);
  assert.equal(row.suggestion, "302 was hard to follow");
  const named = sanitizeResponse({ visit_id: "x", anonymous: false, name: "Simon", email: "S@UWA.example" }, new Date("2026-10-08T03:04:05Z"));
  assert.equal(named.email, "s@uwa.example");
  assert.equal(named.submitted_at, "2026-10-08T03:04:05.000Z");
});

test("public subset hides emails, letters and transcripts", () => {
  const p = publicVisit(visit);
  assert.equal(p.org.name, "University of Western Australia");
  assert.equal(p.guests, undefined);
  assert.equal(p.letters, undefined);
  assert.equal(p.dictation, undefined);
  assert.ok(!JSON.stringify(p).includes("uwa.example"));
  assert.ok(!JSON.stringify(p).includes("secret"));
});

test("recipient list = everyone on the list + onsite emails, deduplicated, anonymous rows excluded", () => {
  const r = recipientList(visit, [
    { visit_id: "2026-10-07-uwa", anonymous: false, name: "Walk-in", email: "walkin@x.example", source: "onsite" },
    { visit_id: "2026-10-07-uwa", anonymous: false, name: "Dup", email: "SIMON@uwa.example", source: "onsite" },
    { visit_id: "2026-10-07-uwa", anonymous: true, name: "", email: "", suggestion: "x" },
    { visit_id: "other", anonymous: false, name: "Other visit", email: "o@x.example" },
  ]);
  assert.deepEqual(r.map((x) => x.email), ["simon@uwa.example", "companion@uwa.example", "walkin@x.example"]);
});

test("csv escapes commas and quotes; ics has an alarm at the end time", () => {
  const csv = toCSV([{ a: 'x,"y"', b: 1 }]);
  assert.equal(csv, 'a,b\n"x,""y""",1');
  const ics = wrapupICS(visit, "https://visit.healsdesign.org/");
  assert.ok(ics.includes("DTSTART:20261007T020000Z"));
  assert.ok(ics.includes("DTEND:20261007T033000Z"));
  assert.ok(ics.includes("admin.html#wrapup=2026-10-07-uwa"));
  assert.ok(ics.includes("BEGIN:VALARM"));
});
