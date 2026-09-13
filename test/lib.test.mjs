import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileTimeline, plannedEntries } from "../lib/timeline.mjs";
import { scanAdmin, loadDict, missing } from "../scripts/i18n-scan.mjs";
import { snapSlidesToGroups, makeVisitId, isValidVisitId, sanitizeResponse, publicVisit, recipientList, toCSV, wrapupICS, ensureBriefingFirst, briefingBlockMinutes, emptyVisit, allocateProgramme, sanitizeMaterials, pageContents, mergeGuests, applyProgrammeTimes, visitEndAt, wrapupTodo, needsSummary, DEFAULT_BRIEFING_LOCATION } from "../lib/visit.mjs";

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

test("AI 排的分鐘數一律照預設重算：每間研究室 20 分，流程時間跟著串回去", () => {
  // AI 排了五間但每間只給 12 分、總體介紹 15 分——分鐘數不歸 AI 決定
  const aiPlan = {
    start_time: "10:00",
    duration_minutes: 150,
    programme: [
      { kind: "briefing", start: "10:00", end: "10:15", title_en: "Overview" },
      { kind: "tour", start: "10:15", end: "11:15", title_en: "Laboratories" },
      { kind: "discussion", start: "11:15", end: "11:45", title_en: "General discussion" },
      { kind: "photo", start: "11:45", end: "11:50", title_en: "Group photo" },
    ],
    itinerary: [
      { room: "briefing", minutes: 15, location: "302" },
      ...["301", "302", "303", "304", "305"].map((room) => ({ room, minutes: 12 })),
    ],
  };
  const r = applyProgrammeTimes(aiPlan);
  assert.equal(r.changed, true);
  assert.deepEqual(r.itinerary.map((s) => s.minutes), [20, 20, 20, 20, 20, 20], "總體介紹與每間研究室都回到 20 分");
  assert.equal(r.itinerary[0].location, "302", "地點不會被重算弄丟");
  assert.deepEqual(r.programme.map((b) => [b.start, b.end]), [
    ["10:00", "10:20"], // 總體介紹 20
    ["10:20", "12:00"], // 五間 × 20
    ["12:00", "12:25"], // 綜合討論拿剩下的 25
    ["12:25", "12:30"], // 合照 5
  ]);

  // 時間不夠時先縮研究室（規則本身），流程時間照樣串得回去
  const short = applyProgrammeTimes({ ...aiPlan, duration_minutes: 60 });
  assert.ok(short.alloc.perRoom < 20 && short.alloc.perRoom >= 5, `每間 ${short.alloc.perRoom} 分`);
  assert.equal(short.programme[0].start, "10:00");
  assert.equal(new Set(short.itinerary.slice(1).map((s) => s.minutes)).size, 1, "縮的時候每間一樣長");

  // 只去兩間的話，那兩間仍是 20 分
  const two = applyProgrammeTimes({ ...aiPlan, itinerary: [{ room: "briefing", minutes: 15 }, { room: "301", minutes: 12 }, { room: "303", minutes: 12 }] });
  assert.deepEqual(two.itinerary.map((s) => s.minutes), [20, 20, 20]);
});

test("名片併進名單：同一個人只補空欄位，不覆寫已確認的資料，也不會把主賓降級", () => {
  const existing = [{ name: "王小明", title: "", email: "ming@x.edu.tw", affiliation: "X 大學", role: "lead" }];
  const r = mergeGuests(existing, [
    { name: "王小明", title: "教授", email: "MING@X.EDU.TW", phone: "02-1234" }, // 同 email（大小寫不同）
    { name: "李小華", title: "研究員", affiliation: "X 大學", email: "hua@x.edu.tw" }, // 新的人
    { name: "", email: "" }, // 什麼都沒讀到的一列要丟掉
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.merged, 1);
  assert.equal(r.guests.length, 2);
  assert.equal(r.guests[0].role, "lead", "主賓身分不會被名片改掉");
  assert.equal(r.guests[0].title, "教授", "空的欄位會被補上");
  assert.equal(r.guests[0].phone, "02-1234");
  assert.equal(r.guests[0].email, "ming@x.edu.tw", "已經有的 email 不會被覆寫成大寫");
  assert.equal(r.guests[1].role, "member");

  // 沒有 email 時用「姓名＋單位」判斷同一個人
  const again = mergeGuests(r.guests, [{ name: "李小華", title: "研究員", affiliation: "X 大學", email: "hua@x.edu.tw" }]);
  assert.equal(again.added, 0, "同一張名片再讀一次不會多一個人");
  assert.deepEqual(mergeGuests([{ name: "陳大文", affiliation: "Y 所" }], [{ name: "陳大文", affiliation: "Y 所", phone: "09" }]).guests.length, 1);
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

test("結束時間：今日流程與總分鐘取晚的那一個（提醒早到會在來賓還在的時候響）", () => {
  // 流程只排到 11:00，但總長 90 分 → 11:30。取晚的那一個
  assert.equal(visitEndAt(visit).toISOString(), "2026-10-07T03:30:00.000Z");
  // 流程排得比總分鐘長（主持人自己把綜合討論拉長）→ 以流程為準
  assert.equal(visitEndAt({ ...visit, programme: [...visit.programme, { kind: "discussion", start: "11:00", end: "12:30" }] }).toISOString(), "2026-10-07T04:30:00.000Z");
  // 沒有流程表就只能用總分鐘
  assert.equal(visitEndAt({ date: "2026-10-07", start_time: "09:00", duration_minutes: 60 }).toISOString(), "2026-10-07T02:00:00.000Z");
});

test("收工提醒講的四件事：做了的打勾，名片說幾張", () => {
  const bare = wrapupTodo({});
  assert.deepEqual(bare.map((t) => t.key), ["signbook", "cards", "dictation", "materials"]);
  assert.equal(bare.every((t) => !t.done), true, "什麼都還沒做");
  const done = wrapupTodo({ signbook: { photo_key: "signbook/x/1.jpg" }, cards: [{ key: "cards/x/1.jpg" }, { key: "cards/x/2.jpg" }], dictation: { transcript: "今天校長來" }, materials: { links: [{ title: "t", url: "https://x.example" }] } });
  assert.equal(done.every((t) => t.done), true);
  assert.equal(done[1].detail, "已經讀了 2 張");
});

test("一頁摘要自己產的條件：過完了、有回饋、而且比最新回覆舊", () => {
  const past = { ...visit, date: "2026-09-01", summary: "", summary_at: "", dictation: {}, signbook: {} };
  const resp = [{ visit_id: past.visit_id, submitted_at: "2026-09-02T10:00:00.000Z", suggestion: "第 303 間講太快" }];
  const now = new Date("2026-09-05T00:00:00.000Z");
  assert.equal(needsSummary(past, resp, now), true, "過完了、有回覆、還沒摘要 → 產");
  assert.equal(needsSummary(past, [], now), false, "沒有任何回饋就沒什麼可寫");
  assert.equal(needsSummary({ ...past, dictation: { transcript: "主持人講的" } }, [], now), true, "只有口述也算有東西可寫");
  assert.equal(needsSummary({ ...visit, date: "2026-12-31" }, resp, now), false, "還沒參訪就不產");
  const fresh = { ...past, summary: "已經有摘要", summary_at: "2026-09-03T00:00:00.000Z" };
  assert.equal(needsSummary(fresh, resp, now), false, "摘要比回覆新 → 不必重寫");
  assert.equal(needsSummary(fresh, [...resp, { visit_id: past.visit_id, submitted_at: "2026-09-04T08:00:00.000Z" }], now), true, "又有人回覆 → 重寫一份");
  // 不具名那一筆只有日期（真匿名的代價）：當天最後一刻算，才不會被當成很舊
  assert.equal(needsSummary(fresh, [{ visit_id: past.visit_id, submitted_at: "2026-09-03" }], now), true);
});

test("世界地圖的資料：投影好的座標、國名對得到、常見寫法有別名", () => {
  const w = JSON.parse(readFileSync("public/data/world.json", "utf8"));
  assert.equal(w.viewBox, "0 0 720 360");
  assert.ok(w.land.startsWith("M") && w.land.length > 20000, "陸地輪廓");
  assert.ok(w.countries.length > 150, `${w.countries.length} 個國家`);
  // 座標是已經投影好的（等距長方，一度兩像素），前端只要畫，不必再算投影
  const at = (name) => w.countries.find((c) => c.name === name);
  const lonlat = (c) => [(c.x / 720) * 360 - 180, 90 - (c.y / 360) * 180];
  const near = (name, lon, lat) => {
    const c = at(name);
    assert.ok(c, `${name} 要在資料裡`);
    const [gotLon, gotLat] = lonlat(c);
    assert.ok(Math.abs(gotLon - lon) < 6 && Math.abs(gotLat - lat) < 6, `${name} 落在 ${gotLon.toFixed(1)},${gotLat.toFixed(1)}`);
  };
  near("Taiwan", 121, 24);
  near("Japan", 138, 37);
  near("Australia", 134, -25);
  near("United States of America", -99, 39);
  near("Russia", 100, 62); // 跨換日線那一國最容易被算到海上
  assert.ok(w.countries.every((c) => c.x >= 0 && c.x <= 720 && c.y >= 0 && c.y <= 360), "每個點都落在圖上");

  // 來信裡的國名寫法千百種：別名一定要對得到真的國名
  const names = new Set(w.countries.map((c) => c.name));
  for (const [k, v] of Object.entries(w.aliases)) assert.ok(names.has(v), `別名 ${k} 對到不存在的 ${v}`);
  assert.equal(w.aliases["台灣"], "Taiwan");
  assert.equal(w.aliases["韓國"], "South Korea");
  assert.equal(w.aliases["usa"], "United States of America");
  assert.equal(w.aliases["uk"], "United Kingdom");
  assert.ok(at("Singapore") && at("Hong Kong"), "1:110m 放不下的小地方要手動補上");
});

test("選頁以區塊為單位：挑到一頁就整區進去，必選頁永遠在", () => {
  const index = JSON.parse(readFileSync("public/data/slides.json", "utf8"));
  const always = index.slides.filter((s) => s.always).map((s) => s.n);
  assert.deepEqual(snapSlidesToGroups([], index), always, "什麼都沒挑也留必選頁");

  // AI 只挑了 301 的其中兩頁 → 整個 301 區塊都進去
  const lab301 = index.groups.find((g) => g.id === "lab301");
  const picked = snapSlidesToGroups([lab301.slides[1], lab301.slides[3]], index);
  for (const n of lab301.slides) assert.ok(picked.includes(n), `301 的第 ${n} 頁要一起進去`);
  for (const n of always) assert.ok(picked.includes(n));
  assert.equal(picked.length, lab301.slides.length + always.length, "不會多帶別區的頁");
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b), "依母簡報頁序");

  // 再挑一頁 302 → 兩區都在
  const lab302 = index.groups.find((g) => g.id === "lab302");
  const two = snapSlidesToGroups([lab301.slides[0], lab302.slides[5]], index);
  assert.equal(two.length, lab301.slides.length + lab302.slides.length + always.length);

  // 沒有區塊表就照原樣（母簡報改版、索引還沒更新時不要把人的選擇吃掉）
  assert.deepEqual(snapSlidesToGroups([9, 3, 9], { slides: index.slides }), [3, 9]);
});

test("五間研究室各有自己的顏色：labs.json 是全站唯一來源", () => {
  const labs = JSON.parse(readFileSync("public/data/labs.json", "utf8")).labs;
  assert.equal(labs.length, 5);
  const colors = labs.map((l) => l.color);
  for (const [i, c] of colors.entries()) assert.match(String(c), /^#[0-9a-f]{6}$/, `${labs[i].room} 要有一個 #rrggbb 的顏色`);
  assert.equal(new Set(colors).size, 5, "五間不能撞色——303 與 305 同屬驗證，但現場是兩間不同的房間");
  // 後台與來賓端都用 var(--c301)…var(--c305)，值由 labs.json 在載入時寫進去；
  // 樣式表裡那五個是還沒載到時的備用值，改顏色改 labs.json 就好
  for (const f of ["public/admin.html", "public/index.html"]) {
    const html = readFileSync(f, "utf8");
    for (const lab of labs) assert.ok(html.includes(`--c${lab.room}:`), `${f} 要有 --c${lab.room} 的備用值`);
    assert.ok(/setProperty\(`--c\$\{lab\.room\}`, lab\.color\)/.test(html), `${f} 要把 labs.json 的 color 寫進 CSS 變數`);
  }
});

test("後台的英文：畫面上每一句中文都有翻譯", () => {
  const strings = scanAdmin();
  assert.ok(strings.length > 200, "應該掃得到整頁的中文");
  const gaps = missing(strings);
  assert.deepEqual(gaps, [], `這幾句還沒有英文（改完中文請一起補 public/data/i18n-admin.json）：\n${gaps.join("\n")}`);
  const dict = loadDict();
  // patterns 是帶數字的那種（「已存 14:32」）：正則要編得起來，且英文裡的 $1 不能超過括號數
  for (const [re, en] of dict.patterns) {
    const r = new RegExp(re);
    const groups = new RegExp(`${re}|`).exec("").length - 1;
    for (const m of en.matchAll(/\$(\d)/g)) assert.ok(Number(m[1]) <= groups, `${re} 只有 ${groups} 個括號，英文卻用到 ${m[0]}`);
    assert.ok(r.source, re);
  }
});

test("母簡報索引與來賓端字串：兩種語言都齊", () => {
  const index = JSON.parse(readFileSync("public/data/slides.json", "utf8"));
  for (const s of index.slides) assert.ok(s.title_en, `第 ${s.n} 頁少了 title_en`);
  for (const g of index.groups) assert.ok(g.title_en, `區塊 ${g.id} 少了 title_en`);
  // 來賓端可以把中文切成主語言，所以 zh 不能有缺（kind_other 四種語言都是空的，那是刻意的）
  const i18n = JSON.parse(readFileSync("public/data/i18n.json", "utf8"));
  const gaps = Object.keys(i18n.en).filter((k) => i18n.en[k] && !i18n.zh[k]);
  assert.deepEqual(gaps, [], `中文版缺這幾個字串：${gaps.join(", ")}`);
});
