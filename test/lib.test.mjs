import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTimeline, plannedEntries } from "../lib/timeline.mjs";
import { makeVisitId, isValidVisitId, sanitizeResponse, publicVisit, recipientList, toCSV, wrapupICS } from "../lib/visit.mjs";

const visit = {
  visit_id: "2026-10-07-uwa",
  date: "2026-10-07",
  start_time: "10:00",
  duration_minutes: 90,
  programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "11:00" }],
  itinerary: [{ room: "301", minutes: 10 }, { room: "302", minutes: 10 }, { room: "303", minutes: 10 }, { room: "304", minutes: 10 }],
  guests: [
    { name: "Simon Kilbane", title: "Programme Director", email: "simon@uwa.example", role: "lead" },
    { name: "A. Companion", title: "", email: "companion@uwa.example", role: "member" },
    { name: "No Email", title: "", email: "", role: "member" },
  ],
  org: { name: "University of Western Australia", type: "university", country: "Australia" },
  letters: { thanks: { subject: "s", body: "b" } },
  dictation: { transcript: "secret" },
};

test("plannedEntries starts at the tour block and chains room minutes", () => {
  const rows = plannedEntries(visit);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].planned.toISOString(), "2026-10-07T02:20:00.000Z");
  assert.equal(rows[3].planned.toISOString(), "2026-10-07T02:50:00.000Z");
});

test("no signals → the schedule itself, source schedule", () => {
  const t = reconcileTimeline(visit, []);
  assert.equal(t.length, 4);
  assert.ok(t.every((r) => r.source === "schedule"));
  assert.equal(t[0].minutes, 10);
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
  assert.equal(t[0].source, "nfc");
  assert.equal(t[0].enter, "2026-10-07T02:21:30.000Z");
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
