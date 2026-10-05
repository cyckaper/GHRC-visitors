import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { scanAdmin, loadDict, missing } from "../scripts/i18n-scan.mjs";
import { weekdayOf } from "../public/lib/rota.mjs";
import { minutesBetween, endTimeOf, snapSlidesToGroups, makeVisitId, isValidVisitId, sanitizeResponse, publicVisit, recipientList, toCSV, wrapupICS, ensureBriefingFirst, briefingBlockMinutes, emptyVisit, allocateProgramme, sanitizeMaterials, pageContents, mergeGuests, applyProgrammeTimes, visitEndAt, wrapupTodo, wrapupNA, wrapupSettled, needsSummary, defaultProgramme, scheduleFingerprint, deckFingerprint, staleOutputs, withLabMinutes, retimeProgramme, rotaRooms, geoKey, needsGeo, sanitizeGeo, sanitizePublic, visitLogEntries, institutionKeys, extractedDate, DEFAULT_BRIEFING_LOCATION, toForumProgramme, labRecipients, labStops, FORUM_TITLES, splitItems, sanitizeDictation, hasDictation, visitRecord, zhNumber, zhDate, promisedItems } from "../lib/visit.mjs";

const visit = {
  visit_id: "2026-10-07-uwa",
  date: "2026-10-07",
  start_time: "10:00",
  duration_minutes: 90,
  programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "11:00" }],
  itinerary: [{ room: "briefing", minutes: 20, location: "304" }, { room: "301", minutes: 10 }, { room: "302", minutes: 10 }, { room: "303", minutes: 10 }, { room: "304", minutes: 10 }],
  guests: [
    { name: "Simon Kilbane", title: "Programme Director", email: "simon@uwa.example", role: "lead" },
    { name: "Office", title: "Secretary", email: "office@uwa.example", role: "member", contact: true },
    { name: "A. Companion", title: "", email: "companion@uwa.example", role: "member" },
    { name: "No Email", title: "", email: "", role: "member" },
  ],
  org: { name: "University of Western Australia", type: "university", country: "Australia" },
  letters: { thanks: { subject: "s", body: "b" } },
  dictation: { transcript: "secret" },
};

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

test("讀信抽出來的日期：沒有就用候選的，都沒有就留空——絕不補今天", () => {
  // 實際發生過：信裡寫「請問您下週 10/5（一）有空嗎？……10/5 週一早上 9:00 到中心」，
  // AI 只把 10/5 放進候選，程式把空的日期補成當天（10/3）
  assert.deepEqual(extractedDate("", ["2026-10-05"]), { date: "2026-10-05", notes: ["日期先填了信裡提的 2026-10-05，還要跟對方確認"] });
  assert.deepEqual(extractedDate("2026-10-05", []), { date: "2026-10-05", notes: [] });
  const none = extractedDate("", []);
  assert.equal(none.date, "", "沒有日期就留空，不是今天");
  assert.match(none.notes[0], /填上日期才會存/);
  const many = extractedDate(" ", ["十月初", "2026-10-05", "2026-10-06"]);
  assert.equal(many.date, "2026-10-05", "第一個真的日期");
  assert.deepEqual(many.notes.slice(1), ["另一個候選日期：2026-10-06", "候選日期：十月初"], "其他候選照列，寫不成日期的也照列");
  assert.deepEqual(extractedDate("2026-10-05", ["2026-10-05", "2026-10-06"]).notes, ["另一個候選日期：2026-10-06"], "跟 date 一樣的那個不再列一次");
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
  assert.deepEqual(r.map((x) => x.email), ["simon@uwa.example", "office@uwa.example", "companion@uwa.example", "walkin@x.example"]);
  // 確認信只寄給「聯絡人」：協調參訪的人不一定等於參加參訪的人
  assert.deepEqual(r.filter((x) => x.contact).map((x) => x.email), ["office@uwa.example"]);
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

test("後續提醒講的四件事：做了的打勾，名片說幾張", () => {
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

  // **輸出的頁序照區塊順序**，不是母簡報的頁碼順序：母簡報把 Lab 304 放在 49–53、Lab 305 放在 43–48，
  // 但講的時候 304 在 305 前面。要改講述順序就調 slides.json 的區塊順序，不必動母簡報。
  const three = snapSlidesToGroups([29, 43, 49], index);
  const at = (n) => three.indexOf(n);
  assert.ok(at(49) < at(43), `304（49）要排在 305（43）前面：${three.join(",")}`);
  assert.ok(at(29) < at(49), "303 還是在 304 前面");
  assert.equal(three[0], 1, "封面永遠第一");
  assert.equal(three[three.length - 1], 72, "謝謝永遠最後");
  // 研究成果 39–42 併進 Lab 303：挑 303 就跟著進去
  for (const n of [39, 40, 41, 42]) assert.ok(three.includes(n), `研究成果第 ${n} 頁跟著 Lab 303 一起進去`);
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

test("中心首頁的內容（center.json）：中英兩份都在、只有五間、不放預算、HEALS 不是中心的", () => {
  const center = JSON.parse(readFileSync("public/data/center.json", "utf8"));
  const labs = JSON.parse(readFileSync("public/data/labs.json", "utf8")).labs;
  // 整頁一種語言，切過去不能開天窗：有 _en 就要有 _zh（反過來也是），日期條目的 en／zh 也一樣
  const walk = (o, at) => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const m = /^(?:(.*)_)?(en|zh)$/.exec(k);
      if (m) {
        const twin = `${m[1] ? m[1] + "_" : ""}${m[2] === "en" ? "zh" : "en"}`;
        assert.ok(String(o[twin] || "").trim(), `${at}.${k} 有了，${at}.${twin} 卻是空的`);
      }
      walk(o[k], `${at}.${k}`);
    }
  };
  walk(center, "center");
  const text = JSON.stringify({ ...center, _comment: "" });
  assert.doesNotMatch(text, /301\s*[-–—~～至]\s*304|four (research )?lab|四間|四個研究室/i, "中心只有這五間：301–305");
  assert.doesNotMatch(text, /HEALS/i, "HEALS Design 是 Lab 301 的方法論，不寫成中心的");
  assert.doesNotMatch(text, /NT\$|新臺幣|億元|萬元|預算|budget/i, "不放中心總預算數字");
  // 「五間研究室構成一條閉環證據鏈」那一段拿掉了（明確指示：「構成一條閉環證據鏈這些不要」）
  assert.doesNotMatch(text, /閉環|evidence loop/i, "首頁不放閉環證據鏈");
  // 國際平台不列康乃爾大學（明確指示）；名單少了一所，標題與說明也就不寫「八校」，免得對不上
  assert.doesNotMatch(text, /Cornell|康乃爾/i, "國際平台不列康乃爾大學");
  assert.doesNotMatch(JSON.stringify(center.platform), /八校|eight/i, "平台的標題與說明不寫校數");
  assert.equal(labs.length, 5);
});

test("中心首頁：五間研究室的卡片排在「組織架構」與「參訪與聯絡」之間，閉環那一段拿掉了", () => {
  // 明確指示：「5 間研究室的介紹移到『組織架構』與『參訪與聯絡』之間」
  const html = readFileSync("public/center.html", "utf8");
  const at = (id) => html.indexOf(`<section class="reveal" id="${id}"`) + 1 || html.indexOf(`<section class="card reveal" id="${id}"`) + 1;
  assert.ok(at("orgSec") && at("labsSec") && at("contactSec"), "三個區塊都在");
  assert.ok(at("orgSec") < at("labsSec") && at("labsSec") < at("contactSec"), "研究室在組織架構之後、參訪與聯絡之前");
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), /id="loop"|閉環/, "閉環那一段（四格、回饋那一行、同一動線那一行）不在頁面上");
});

test("研究室卡片上不再有「Lab 301 · 量測」這類小標籤：量測／設計／驗證／處方是閉環證據鏈的分法", () => {
  // 明確指示：「五間研究室的卡片上，還留著『Lab 301 · 量測』這類小標籤一起拿掉」。
  // 中心首頁、來賓專頁的老師卡片、每一間的介紹頁都拿掉；房號（門牌）改寫在名稱前面
  const labs = JSON.parse(readFileSync("public/data/labs.json", "utf8")).labs;
  for (const l of labs) assert.ok(!("stage" in l) && !("stage_zh" in l), `${l.room} 不再帶 stage`);
  for (const f of ["public/center.html", "public/index.html", "public/lab.html"]) {
    const html = readFileSync(f, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(html, /stage_zh|\.stage\b|roomPill|Lab \$\{esc\((?:l|lab)\.room\)\} ·/, `${f} 不再印階段標籤`);
    assert.match(html, /class="room-no"/, `${f} 的房號寫在名稱前面`);
  }
});

test("陳惠美老師對外稱「首任主任 Inaugural Director」，不寫 Co-PI", () => {
  // 明確指示：她是開創中心的主任，叫 Co-PI 不妥。來賓看得到的資料（首頁、老師卡片與介紹頁）都不准再出現
  const center = JSON.parse(readFileSync("public/data/center.json", "utf8"));
  const labs = JSON.parse(readFileSync("public/data/labs.json", "utf8")).labs;
  for (const [f, data] of [["center.json", { ...center, _comment: "" }], ["labs.json", labs]]) {
    assert.doesNotMatch(JSON.stringify(data), /co-?pi\b|co-principal|共同主持人/i, `${f} 不寫 Co-PI`);
  }
  const chen = labs.find((l) => l.room === "303").lead;
  assert.ok(chen.title_zh.includes("首任主任") && chen.title_en.includes("Inaugural Director"), "303 的卡片寫首任主任");
  const row = center.organisation.people.find((p) => p.name_zh === "陳惠美");
  assert.deepEqual([row.role_zh, row.role_en], ["首任主任", "Inaugural Director"], "首頁的組織架構寫首任主任");
});

test("/ 是中心首頁（center.html），/<visit_id> 仍然落到來賓專頁", () => {
  const toml = readFileSync("netlify.toml", "utf8");
  const rules = toml.split("[[redirects]]").slice(1).map((b) => ({ from: (/from\s*=\s*"([^"]+)"/.exec(b) || [])[1], to: (/to\s*=\s*"([^"]+)"/.exec(b) || [])[1], force: /force\s*=\s*true/.test(b) }));
  const root = rules.findIndex((r) => r.from === "/");
  const rest = rules.findIndex((r) => r.from === "/*");
  assert.ok(root >= 0, "要有一條 / 的規則");
  assert.equal(rules[root].to, "/center.html");
  assert.ok(rules[root].force, "根目錄本來就有 index.html，不 force 的話 Netlify 會直接給 index.html");
  assert.ok(rest > root && rules[rest].to === "/index.html", "/<visit_id> 那一條（/*）要排在後面，仍然給來賓專頁");
  assert.match(readFileSync("scripts/dev-server.mjs", "utf8"), /if \(p === "\/"\) p = "\/center\.html"/, "本機開發伺服器也要一樣");
});

test("隱私權政策 /privacy：每一個外部服務、每一個 Google 權限都寫進去，兩種語言都有", () => {
  // Google 的 OAuth 同意畫面要發布成「正式版」，Branding 頁一定要填首頁與隱私權政策的連結（https://visit.healsdesign.org/privacy）
  const toml = readFileSync("netlify.toml", "utf8");
  const rules = toml.split("[[redirects]]").slice(1).map((b) => ({ from: (/from\s*=\s*"([^"]+)"/.exec(b) || [])[1], to: (/to\s*=\s*"([^"]+)"/.exec(b) || [])[1] }));
  const at = rules.findIndex((r) => r.from === "/privacy");
  assert.ok(at >= 0 && rules[at].to === "/privacy.html", "要有一條 /privacy → /privacy.html");
  assert.ok(at < rules.findIndex((r) => r.from === "/*"), "/privacy 要排在 /*（來賓專頁）前面");
  assert.match(readFileSync("public/center.html", "utf8"), /<a [^>]*href="\/privacy"/, "首頁要連得到隱私權政策（寫在 HTML 裡，不靠 JS）");

  const html = readFileSync("public/privacy.html", "utf8");
  const open = (id) => (new RegExp(`<article id="${id}"[^>]*>`).exec(html) || [""])[0];
  const body = (id) => (new RegExp(`<article id="${id}"[^>]*>([\\s\\S]*?)</article>`).exec(html) || [])[1] || "";
  const langs = [["en", body("en")], ["zh", body("zh")]];
  assert.ok(langs.every(([, t]) => t.length > 1000), "英文與中文各一份完整的");
  assert.ok(open("en") && !/hidden/.test(open("en")) && /hidden/.test(open("zh")), "沒有 JavaScript 時看到的是英文（Google 看的是這一份），中文用切的");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href="https?:/i, "隱私權政策這一頁本身不從別的伺服器載東西");

  // 程式連到哪裡，就要點名是誰：多接一個外部服務，這一頁要跟著改
  const dirs = ["netlify/functions", "netlify/lib"];
  const code = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".mts")).map((f) => readFileSync(`${d}/${f}`, "utf8"))).join("\n");
  const PROVIDERS = [[/(^|\.)(google|googleapis)\.com$/, "Google"], [/(^|\.)openai\.com$/, "OpenAI"], [/(^|\.)anthropic\.com$/, "Anthropic"], [/(^|\.)netlify\.com$/, "Netlify"], [/^visit\.healsdesign\.org$/, ""]];
  const named = new Set(["Netlify"]); // 站台本身就在 Netlify 上
  if (/@anthropic-ai\/sdk/.test(code)) named.add("Anthropic");
  for (const host of new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))) {
    const hit = PROVIDERS.find(([re]) => re.test(host));
    assert.ok(hit, `程式會連到 ${host}：這是新的外部服務，要寫進隱私權政策（public/privacy.html），再加到這裡`);
    if (hit[1]) named.add(hit[1]);
  }
  for (const name of named) for (const [lang, t] of langs) assert.ok(t.includes(name), `隱私權政策（${lang}）要寫出 ${name}`);

  // 同意畫面上要的每一個 Google 權限都要說清楚
  const scopes = [...readFileSync("netlify/lib/google.mts", "utf8").matchAll(/googleapis\.com\/auth\/([\w.]+)/g)].map((m) => m[1]);
  assert.deepEqual(scopes, ["drive.file", "gmail.send"]);
  for (const s of scopes) for (const [lang, t] of langs) assert.ok(t.includes(`<code>${s}</code>`), `Google 的權限 ${s} 要寫進隱私權政策（${lang}）`);
  assert.match(langs[0][1], /adheres to the <a [^>]*>Google API Services User Data Policy<\/a>, including the Limited Use requirements/, "Google 要的 Limited Use 那一句");
  for (const [lang, t] of langs) {
    assert.match(t, /Limited Use/, `Limited Use（${lang}）`);
    assert.match(t, /ntughrc@gmail\.com/, `聯絡信箱（${lang}）`);
  }
});

test("座談的場次：總體介紹 → 座談、沒有研究室參訪；換成座談時研究室參訪的時間給座談；支援人力表與通告五間都問", () => {
  // 明確指示：「有一些單位參訪是跟老師們座談，不用介紹各研究室」
  const forum = defaultProgramme({ format: "forum", start_time: "14:00", duration_minutes: 120 });
  assert.deepEqual(forum.map((b) => [b.kind, b.start, b.end]), [["briefing", "14:00", "14:20"], ["forum", "14:20", "16:00"]]);
  assert.equal(forum[1].title_en, FORUM_TITLES.title_en);
  // 從照常參觀的流程換過來：研究室參訪拿掉、那一段的時間給座談（綜合討論就是座談），結束時間不變，合照照舊
  const tour = [
    { start: "10:00", end: "10:20", kind: "briefing", title_en: "Welcome", title_2nd: "歡迎" },
    { start: "10:20", end: "12:00", kind: "tour", title_en: "Laboratory visits", title_2nd: "研究室參訪", rooms: ["301", "302"] },
    { start: "12:00", end: "12:25", kind: "discussion", title_en: "General discussion", title_2nd: "綜合討論" },
    { start: "12:25", end: "12:30", kind: "photo", title_en: "Photo", title_2nd: "合照" },
  ];
  const conv = toForumProgramme(tour, "10:00");
  assert.deepEqual(conv.map((b) => [b.kind, b.start, b.end]), [["briefing", "10:00", "10:20"], ["forum", "10:20", "12:25"], ["photo", "12:25", "12:30"]]);
  assert.equal(conv[1].title_2nd, FORUM_TITLES.title_2nd);
  assert.deepEqual(toForumProgramme(tour.filter((b) => b.kind !== "discussion"), "10:00").map((b) => b.kind), ["briefing", "forum", "photo"], "沒有綜合討論就在總體介紹後面補一段座談");
  assert.deepEqual(toForumProgramme(conv, "10:00"), conv, "已經是座談的再換一次不變");
  // 支援人力表：五間都列、每一間只問出席的老師；通告五間都寄、時間寫座談那一段；動線上沒有研究室
  const labs = { labs: ["301", "302", "303", "304", "305"].map((room) => ({ room, name_zh: `${room} 室`, lead: { name_zh: `老師${room}` } })) };
  const v = { format: "forum", programme: conv, itinerary: [{ room: "briefing", minutes: 20 }] };
  assert.deepEqual(rotaRooms(v, labs), { rooms: ["301", "302", "303", "304", "305"], planned: true, forum: true });
  assert.deepEqual(labRecipients(v, labs).map((r) => [r.room, r.start, r.end]), ["301", "302", "303", "304", "305"].map((room) => [room, "10:20", "12:25"]));
  assert.deepEqual(labStops({ ...v, itinerary: [{ room: "briefing", minutes: 20 }, { room: "301", minutes: 20 }] }, labs), [], "座談不參觀研究室：動線上殘留研究室也不算");
  assert.equal(rotaRooms({ itinerary: [{ room: "briefing", minutes: 20 }] }, labs).forum, undefined, "照常參觀的場次不受影響");
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

test("幾點開始、幾點結束：總分鐘由這兩個算出來", () => {
  assert.equal(minutesBetween("10:00", "12:30"), 150);
  assert.equal(minutesBetween("09:05", "09:20"), 15);
  assert.equal(minutesBetween("10:00", "10:00"), null, "一樣長不算一場");
  assert.equal(minutesBetween("14:00", "13:00"), null, "結束早於開始＝填錯，讓上層沿用原本的長度");
  assert.equal(minutesBetween("", "12:30"), null);
  assert.equal(minutesBetween("10:00", "25:00"), null);
  // 沒填結束時間的舊資料：用「開始 ＋ 總分鐘」算回來
  assert.equal(endTimeOf({ start_time: "10:00", duration_minutes: 150 }), "12:30");
  assert.equal(endTimeOf({ start_time: "13:30", duration_minutes: 90 }), "15:00");
  assert.equal(endTimeOf({ start_time: "10:00", end_time: "11:15", duration_minutes: 150 }), "11:15", "填了就以填的為準");
  assert.equal(endTimeOf(emptyVisit()), "12:30", "新的一場就先給預設的開始與結束");
  // 後續提醒看的結束時間也跟著走
  assert.equal(visitEndAt({ date: "2026-10-07", start_time: "09:00", end_time: "10:00" }).toISOString(), "2026-10-07T02:00:00.000Z");
});

test("後續那四件事可以標「本次沒有」：不算未完成，提醒也不再為它寄信", () => {
  const v = { wrapup: { na: ["signbook", "cards", "夾帶的怪東西"] } };
  assert.deepEqual(wrapupNA(v), ["signbook", "cards"], "只認得那四個 key");
  const todo = wrapupTodo(v);
  assert.deepEqual(todo.filter((t) => t.na).map((t) => t.key), ["signbook", "cards"]);
  assert.equal(wrapupSettled(v), false, "口述與當天資料還沒處理");
  const all = { ...v, wrapup: { na: ["signbook", "cards", "dictation", "materials"] } };
  assert.equal(wrapupSettled(all), true, "四件都標了本次沒有 → 不必再提醒");
  // 做到了就以做到的為準，不會因為標過而顯示成「沒有」
  const didIt = wrapupTodo({ wrapup: { na: ["signbook"] }, signbook: { photo_key: "signbook/x/1.jpg" } });
  assert.equal(didIt[0].done, true);
  assert.equal(didIt[0].na, false);
  assert.equal(wrapupSettled({ signbook: { photo_key: "k" }, cards: [{ key: "c" }], dictation: { transcript: "t" }, materials: { links: [{ title: "t", url: "https://x.example" }] } }), true);
});

test("已經交出去的東西會不會過期：行程指紋對不上就說一句", () => {
  const base = { ...visit, slides: [1, 2, 3] };
  const sent = { ...base, letters: { confirmation: { subject: "s", body: "b", drafted_at: "", sent_at: "2026-09-01T00:00:00.000Z", fingerprint: scheduleFingerprint(base) } }, deck: { generated_at: "2026-09-01T00:00:00.000Z", fingerprint: deckFingerprint(base) } };
  assert.deepEqual(staleOutputs(sent), [], "什麼都沒改 → 沒有過期的東西");
  // 行程改了：簡報與確認信都舊了
  const moved = { ...sent, programme: [{ kind: "briefing", start: "11:00", end: "11:20" }] };
  assert.deepEqual(staleOutputs(moved).map((x) => x.key), ["deck", "confirmation"]);
  // 只改選頁：簡報舊了，信沒問題（信裡沒有頁次）
  const reslide = { ...sent, slides: [1, 2, 3, 4] };
  assert.deepEqual(staleOutputs(reslide).map((x) => x.key), ["deck"]);
  // 沒產過、沒寄過的不會被說舊
  assert.deepEqual(staleOutputs(visit), []);
  // 舊資料沒有指紋（這個功能之前寄的信）也不要亂報
  assert.deepEqual(staleOutputs({ ...moved, deck: { generated_at: "x" }, letters: { confirmation: { sent_at: "x" } } }), []);
});

test("新的一場就有一份可以改的流程：總體簡報 → 研究室參訪 → 綜合討論", () => {
  const p = defaultProgramme({ start_time: "10:00", duration_minutes: 150 });
  assert.deepEqual(p.map((b) => b.kind), ["briefing", "tour", "discussion"]);
  assert.deepEqual([p[0].start, p[0].end], ["10:00", "10:20"]);
  assert.deepEqual([p[1].start, p[1].end], ["10:20", "12:00"], "五間各 20 分");
  assert.equal(p[2].start, "12:00");
  // 只去兩間、時間短：研究室那一段跟著縮
  const two = defaultProgramme({ start_time: "14:00", duration_minutes: 90, itinerary: [{ room: "briefing", minutes: 20 }, { room: "301", minutes: 20 }, { room: "303", minutes: 20 }] });
  assert.deepEqual([two[1].start, two[1].end], ["14:20", "15:00"]);
});

test("老師自己給的一句話要一模一樣：`one_line_source: lead` 的那幾句不准被改寫", () => {
  // 明確指示：「ppt 中老師給的一句話介紹就一定要用」。以前這兩句被順手潤飾過
  // （302 的 "Our research focuses on…" 變成 "Research focused on…"、303 的 "the lab" 變成 "the laboratory"），
  // 所以這裡把原文釘死：改動 labs.json 時如果動到這兩句，測試就會擋下來。
  // 原文來自老師自己的簡報第 1 頁（302：GHRC 林寶秀 2026；303：GHRC 303 模擬室 0929；305：Chiakuen Cheng CV 1page）。
  const VERBATIM = {
    302: {
      zh: "本研究室聚焦都市微氣候、綠色基盤與人體熱舒適，整合現地量測、數值模擬與空間分析，發展氣候調適之規劃與設計策略。",
      en: "Our research focuses on urban microclimate, green infrastructure, and human thermal comfort, integrating field measurements, numerical simulation, and spatial analysis to develop climate-responsive planning and design strategies.",
    },
    303: {
      zh: "以實證設計為基礎，融合科學理論與景觀美學，開發回應不同健康需求的虛擬自然療癒環境與體驗產品。",
      en: "Grounded in evidence-based design, the lab integrates scientific theory and landscape aesthetics to develop virtual nature-based healing environments and experiential products that address diverse health needs.",
    },
    305: {
      zh: "聚焦於地方與環境的感知、依附及其變化，並探討這些經驗如何形塑景觀偏好、空間行為與旅遊決策。",
      en: "Focuses on the perception of and attachment to places and environments, and how these experiences shape landscape preferences, spatial behavior, and travel decisions.",
    },
  };
  const labs = JSON.parse(readFileSync("public/data/labs.json", "utf8")).labs;
  const marked = labs.filter((l) => l.one_line_source === "lead").map((l) => String(l.room));
  assert.deepEqual(marked, Object.keys(VERBATIM), "標了 lead 的就要在這張表裡，反之亦然");
  for (const [room, want] of Object.entries(VERBATIM)) {
    const lab = labs.find((l) => String(l.room) === room);
    assert.equal(lab.one_line_zh, want.zh, `${room} 的中文一句話要跟老師的簡報一字不差`);
    assert.equal(lab.one_line_en, want.en, `${room} 的英文一句話要跟老師的簡報一字不差`);
  }
});

test("研究室填的分鐘排進動線：有那一間就改分鐘，沒有就照房號插進去（不插在總體介紹前面）", () => {
  const it = [{ room: "briefing", minutes: 20, location: "302" }, { room: "301", minutes: 20, focus: "HealthCloud" }, { room: "304", minutes: 20 }];
  const changed = withLabMinutes(it, "301", 35);
  assert.deepEqual(changed.map((s) => [s.room, s.minutes]), [["briefing", 20], ["301", 35], ["304", 20]]);
  assert.equal(changed[1].focus, "HealthCloud", "改分鐘不動那一間的重點");
  assert.equal(it[1].minutes, 20, "回傳新的一份，不改原本的");
  assert.deepEqual(withLabMinutes(it, "303", 15).map((s) => s.room), ["briefing", "301", "303", "304"]);
  assert.deepEqual(withLabMinutes(it, "305", 15).map((s) => s.room), ["briefing", "301", "304", "305"]);
  assert.deepEqual(withLabMinutes([], "302", 25), [{ room: "302", minutes: 25, focus: "", location: "" }]);
});

test("今日流程從開始時間往後重推：研究室參訪＝動線合計、其他區塊維持原本的長度", () => {
  const v = {
    start_time: "14:00",
    itinerary: [{ room: "briefing", minutes: 20 }, { room: "301", minutes: 30 }, { room: "303", minutes: 15 }, { room: "305", minutes: 0 }],
    programme: [
      { kind: "briefing", start: "14:00", end: "14:20", title_en: "Welcome" },
      { kind: "tour", start: "14:20", end: "15:00", rooms: ["301", "303", "305"] },
      { kind: "discussion", start: "15:00", end: "15:30" },
    ],
  };
  const p = retimeProgramme(v);
  assert.deepEqual(p.map((b) => [b.kind, b.start, b.end]), [["briefing", "14:00", "14:20"], ["tour", "14:20", "15:05"], ["discussion", "15:05", "15:35"]]);
  assert.deepEqual(p[1].rooms, ["301", "303"], "留 0 的那一間不算在動線上");
  assert.equal(p[0].title_en, "Welcome", "區塊的其他欄位照舊");
  // 還沒有流程：先照預設排一份，研究室參訪一樣是動線的合計
  const fresh = retimeProgramme({ start_time: "10:00", duration_minutes: 150, itinerary: v.itinerary });
  assert.deepEqual(fresh.map((b) => b.kind), ["briefing", "tour", "discussion"]);
  const tour = fresh.find((b) => b.kind === "tour");
  assert.equal(minutesBetween(tour.start, tour.end), 45);
});

test("支援人力表列哪幾間：主辦端排了就列動線（加上已經填過的）；沒排、或只有研究室自己填進來的，五間都列", () => {
  const labs = { labs: ["301", "302", "303", "304", "305"].map((room) => ({ room })) };
  const route = (...rooms) => [{ room: "briefing", minutes: 20 }, ...rooms.map((room) => ({ room, minutes: 20 }))];
  assert.deepEqual(rotaRooms({ itinerary: route() }, labs), { rooms: ["301", "302", "303", "304", "305"], planned: false });
  assert.deepEqual(rotaRooms({ itinerary: route("301", "303") }, labs), { rooms: ["301", "303"], planned: true });
  // 主辦端排了 301、303；304 在排之前就填了人名：填過的不能看不見
  assert.deepEqual(rotaRooms({ itinerary: route("301", "303"), presenters: { 304: "王小明" } }, labs), { rooms: ["301", "303", "304"], planned: true });
  // 還沒排，301 自己填了分鐘（被排進動線）：其他四間仍要看得到格子
  assert.deepEqual(rotaRooms({ itinerary: route("301"), lab_minutes: { 301: 20 }, lab_added: ["301"] }, labs), { rooms: ["301", "302", "303", "304", "305"], planned: false });
  // 主辦端排了 301、303，兩間也都填了：仍然是排好了，其他三間免填（不是又變回五間都「未填」）
  assert.deepEqual(rotaRooms({ itinerary: route("301", "303"), lab_minutes: { 301: 30, 303: 15 } }, labs), { rooms: ["301", "303"], planned: true });
});

test("訪客地圖的位置：單位名稱或國家改了就要重查；座標不合理就當作只知道國家", () => {
  const v = { org: { name: "University of Western Australia", name_local: "西澳大學", country: "Australia" } };
  assert.equal(needsGeo(v), true, "還沒查過");
  const geo = sanitizeGeo({ key: geoKey(v), lat: -31.98, lon: 115.82, place: "澳洲伯斯", precision: "site", at: "2026-09-30T00:00:00Z" });
  assert.equal(needsGeo({ ...v, geo }), false, "查過了");
  assert.equal(geoKey({ org: { name: "  University of  Western Australia ", name_local: "西澳大學", country: "australia" } }), geoKey(v), "大小寫與多餘的空白不算改名");
  assert.equal(needsGeo({ org: { ...v.org, name: "Curtin University" }, geo }), true, "改了名字：查的是別的單位，要重查");
  assert.equal(needsGeo({ org: { ...v.org, country: "New Zealand" }, geo }), true, "改了國家也一樣");
  assert.equal(needsGeo({ org: { name: "", country: "Japan" } }), false, "沒有單位名稱的不查");
  // 0,0 是 AI「查不到」的慣用值、超出範圍的座標不可能對：一律退回「只知道國家」，不要畫在海上
  for (const bad of [{ lat: 0, lon: 0, precision: "city" }, { lat: 95, lon: 10, precision: "site" }, { lat: null, lon: 121, precision: "city" }, { lat: "x", lon: 121, precision: "city" }]) {
    const g = sanitizeGeo({ key: "k", place: "某處", ...bad });
    assert.deepEqual([g.lat, g.lon, g.precision], [null, null, "country"], JSON.stringify(bad));
  }
  assert.equal(sanitizeGeo({ key: "k", lat: 25.0171234, lon: 121.5398765, precision: "moon" }).precision, "country", "不認得的精度一律當國家");
  assert.deepEqual([sanitizeGeo({ key: "k", lat: 25.0171234, lon: 121.5398765, precision: "site" }).lat, sanitizeGeo({ key: "k", lat: 25.0171234, lon: 121.5398765, precision: "site" }).lon], [25.0171, 121.5399], "座標留到小數四位（約十公尺，夠了）");
  assert.equal(sanitizeGeo(null), undefined);
});

test("支援人力表上的星期幾照日期算，不受時區影響", () => {
  // 明確回報：11/2 是週一，表上寫成週日（以前拿台北的午夜去問 UTC，每一天都早一天）
  assert.equal(weekdayOf("2026-11-02"), "一");
  assert.equal(weekdayOf("2026-10-15"), "四");
  assert.equal(weekdayOf("2026-09-30"), "三");
  assert.equal(weekdayOf("2027-01-01"), "五");
  assert.equal(weekdayOf("2028-02-29"), "二", "閏年那一天也對");
  assert.equal(weekdayOf(""), "", "沒有日期就不寫星期");
});

test("公開的來訪紀錄：只列來過的、標了不公開的不列，原表同一列拆出來的合成一場；只給公開頁用得到的", () => {
  const now = new Date("2026-10-01T00:00:00+08:00");
  const v = (id, date, org, extra = {}) => ({ visit_id: id, date, start_time: "10:00", duration_minutes: 90, org: { name: org, name_local: "", country: "Taiwan", type: "university" }, guests: [{ name: "Private Person", email: "p@example.org" }], purpose: "internal purpose", itinerary: [{ room: "briefing", minutes: 20 }], ...extra });
  const g = (id, org, people) => v(id, "2024-01-08", org, { imported: { group: "list.xlsx#1" }, public: { people_zh: people, note_zh: "研討會講者", note_en: "Workshop speakers" } });
  const entries = visitLogEntries([
    g("2024-01-08-illinois", "UIUC", "Sullivan 教授"),
    g("2024-01-08-helsinki", "University of Helsinki", "Jyske 教授"),
    v("2025-05-01-ntu", "2025-05-01", "NTU", { itinerary: [{ room: "briefing", minutes: 20 }, { room: "303", minutes: 20 }, { room: "301", minutes: 15 }, { room: "305", minutes: 0 }] }),
    v("2025-05-01-other", "2025-05-01", "Other Co", { public: { hidden: true } }),
    v("2099-01-01-future", "2099-01-01", "Future Ministry"),
    v("2025-06-01-noname", "2025-06-01", ""),
  ], now);
  assert.deepEqual(entries.map((e) => e.id), ["2025-05-01-1", "2024-01-08-1"], "新的在前；還沒來的、不公開的、沒有單位名稱的都不列");
  const ws = entries[1];
  assert.deepEqual(ws.orgs.map((o) => o.name), ["University of Helsinki", "UIUC"], "原表同一列拆出來的兩個單位是同一場");
  assert.equal(ws.people.zh, "Jyske 教授、Sullivan 教授");
  assert.deepEqual(ws.note, { zh: "研討會講者", en: "Workshop speakers" }, "同一場的交流重點只寫一次");
  assert.deepEqual(entries[0].rooms, ["301", "303"], "去了哪幾間：動線上排了分鐘的（總體介紹與 0 分的不算）");
  assert.deepEqual(entries[0].note, { zh: "", en: "" }, "系統裡排的一場沒寫公開說明就是空的——來訪目的不會跑出來");
  assert.doesNotMatch(JSON.stringify(entries), /Private Person|example\.org|internal purpose|visit_id|2024-01-08-illinois/, "名單、email、來訪目的、visit_id（來賓專頁的網址）一律不給");
  assert.equal(sanitizePublic({ note_zh: "  a\r\nb  ", hidden: "yes", junk: 1 }).note_zh, "a\nb");
  assert.equal(sanitizePublic({ hidden: "yes" }), undefined, "只有 true 才算不公開；什麼都沒有就是 undefined");
  assert.deepEqual(Object.keys(sanitizePublic({ hidden: true })).sort(), ["hidden", "note_en", "note_zh", "people_en", "people_zh"]);
});

test("同一個單位：中文名稱一樣、或英文名稱去掉空白與標點後一樣（國家也一樣）；一路串下去；代碼跟順序無關", () => {
  const v = (id, name, local, country) => ({ visit_id: id, org: { name, name_local: local, country } });
  const list = [
    // 實際發生過：同一家公司兩場，英文拼法不一樣
    v("a", "Dun Yang Engineering Consultants Co., Ltd.", "惇陽工程顧問有限公司", "Taiwan"),
    v("b", "Dunyang Engineering Consultants Co., Ltd.", "惇陽工程顧問有限公司", "臺灣"),
    v("c", "DUN-YANG Engineering Consultants Co Ltd", "", "Taiwan"),
    v("d", "Dunyang Engineering Consultants Co., Ltd.", "", "South Korea"),
    v("e", "Konkuk University", "건국대학교", "South Korea"),
    v("f", "Konkuk Univ.", "건국대학교", "Korea"),
    v("g", "", "", "Japan"),
  ];
  const k = institutionKeys(list);
  assert.equal(k.get("a"), k.get("b"), "中文名稱一樣：英文拼法不同、國名寫法不同都算同一個");
  assert.equal(k.get("a"), k.get("c"), "英文名稱只差空白、標點、大小寫，國家也一樣");
  assert.notEqual(k.get("b"), k.get("d"), "只有英文名稱一樣、國家不一樣的不算");
  assert.equal(k.get("e"), k.get("f"), "韓文名稱一樣");
  assert.notEqual(k.get("a"), k.get("e"));
  assert.equal(k.get("g"), "", "沒有名稱的不給代碼（呼叫的地方自己退回原本的寫法）");
  const r = institutionKeys([...list].reverse());
  assert.ok(list.every((x) => r.get(x.visit_id) === k.get(x.visit_id)), "資料的先後順序不影響代碼");
  assert.ok([...k.values()].every((x) => !/^[a-g]$/.test(x)), "代碼不是 visit_id");
  // 串起來：A、B 中文一樣，B、C 英文一樣
  const chain = institutionKeys([v("x", "Alpha Co", "甲公司", "Taiwan"), v("y", "Beta Co", "甲公司", "Taiwan"), v("z", "beta co.", "", "Taiwan")]);
  assert.ok(chain.get("x") === chain.get("y") && chain.get("y") === chain.get("z"));
  const more = institutionKeys([
    v("p", "國立臺灣大學", "", "Taiwan"), // 英文名稱那一格寫的是中文（讀信時常見）
    v("q", "National Taiwan University", "國立台灣大學", "臺灣"),
    v("r", "The University of Western Australia", "", "Australia"),
    v("s", "University of Western Australia", "西澳大學", "Australia"),
  ]);
  assert.equal(more.get("p"), more.get("q"), "英文那一格寫中文也照中文比；臺／台當同一個字");
  assert.equal(more.get("r"), more.get("s"), "英文開頭的 The 不算");
});

test("公開的來訪紀錄：同一個單位的每一場帶同一個代碼；代碼只拿列出來的那幾場算，還沒來的那一場的名稱不會透出來", () => {
  const now = new Date("2026-10-01T00:00:00+08:00");
  const v = (id, date, name, local) => ({ visit_id: id, date, start_time: "10:00", duration_minutes: 90, org: { name, name_local: local, country: "Taiwan", type: "enterprise" }, itinerary: [] });
  const entries = visitLogEntries([
    v("2026-09-23-dunyang", "2026-09-23", "Dunyang Engineering Consultants Co., Ltd.", "惇陽工程顧問有限公司"),
    v("2026-09-30-dunyang", "2026-09-30", "Dun Yang Engineering Consultants Co., Ltd.", "惇陽工程顧問有限公司"),
    v("2026-05-01-secret", "2026-05-01", "Secret Org", ""),
    v("2099-01-01-secret", "2099-01-01", "Secret Org", "還沒公開的中文名稱"),
  ], now);
  const inst = (date) => entries.find((e) => e.date === date).orgs[0].inst;
  assert.ok(inst("2026-09-23") && inst("2026-09-23") === inst("2026-09-30"), "惇陽兩場是同一個單位");
  assert.doesNotMatch(JSON.stringify(entries), /還沒公開的中文名稱|2099/, "還沒來的那一場不列，也不能從代碼裡透出來");
});

/** 訪後紀錄與答應提供的資料用的研究室資料（labs.json 整份，跟伺服器 loadPublicData("labs") 一樣）。 */
const LABS = JSON.parse(readFileSync("public/data/labs.json", "utf8"));

test("訪後重點一項一項：自己打的編號拿掉、舊資料轉過來、空的不留", () => {
  assert.deepEqual(splitItems("1. 生態 app\n(2) 論文\n一、合作\n- ESG\n\n•  名片"), ["生態 app", "論文", "合作", "ESG", "名片"]);
  assert.deepEqual(splitItems(["10.5% 的人", "2027 年再來", "3 位研究生", "1.生態"]), ["10.5% 的人", "2027 年再來", "3 位研究生", "生態"], "數字是內容的不要當成編號拿掉");
  const old = sanitizeDictation({ who_came: "x", most_wanted_rooms: ["303", "999", "303"], questions: ["a", ""], cooperation: "Homework：思考\n第二項", follow_ups: "寄論文", other: "其他一句" });
  assert.deepEqual(old, { who_came: "x", most_wanted_rooms: ["303"], notes: ["其他一句"], questions: ["a"], cooperation: ["Homework：思考", "第二項"], follow_ups: ["寄論文"] }, "以前的合作意願是一句話、「其他」是一格字串");
  assert.deepEqual(sanitizeDictation({ other: "（AI_MOCK）" }).notes, [], "測試用的範例字不算");
  assert.equal(hasDictation({}), false);
  assert.equal(hasDictation({ extracted: { notes: ["a"] } }), true, "沒錄音、只打了重點也算做了");
  assert.equal(hasDictation({ record: { text: "紀錄" } }), true);
  assert.equal(wrapupTodo({ dictation: { extracted: { follow_ups: ["寄論文"] } } }).find((t) => t.key === "dictation").done, true);
});

test("完整紀錄：事實照參訪資料排、重點一項對一項；AI 的項數對不上就用原話", () => {
  assert.deepEqual([1, 9, 10, 11, 19, 20, 21].map(zhNumber), ["一", "九", "十", "十一", "十九", "二十", "二十一"]);
  assert.equal(zhDate("2026-11-02"), "2026 年 11 月 2 日（星期一）", "照日期字串算，不經過時區");
  const v = {
    date: "2026-10-05", start_time: "09:00", duration_minutes: 150,
    org: { name: "Example University", name_local: "範例大學", country: "日本" },
    guests: [{ name: "山田太郎", title: "教授", role: "member" }, { name: "佐藤花子", title: "學院長", role: "lead" }],
    headcount: 3, contact_teacher: "張俊彥",
    itinerary: [{ room: "briefing", minutes: 20, location: "302" }, { room: "301", minutes: 20 }, { room: "303", minutes: 30 }],
    presenters: { "303": "王小明" },
    dictation: { extracted: { most_wanted_rooms: ["303"], notes: ["Homework：思考如何量測接觸不同野生物種"], questions: ["能不能用在長照"], cooperation: [], follow_ups: ["與使用者及其他賢哲共同討論療癒景觀", "在生態 app 中加入 ESG"] } },
  };
  v.programme = retimeProgramme({ ...v, programme: defaultProgramme(v) });
  const raw = visitRecord(v, LABS, null);
  assert.ok(raw.startsWith("範例大學 參訪紀錄\n"), "標題用中文名稱");
  assert.match(raw, /^一、日期：2026 年 10 月 5 日（星期一）　09:00–11:30$/m);
  assert.match(raw, /^二、地點：臺大園藝系造園館三樓　綠色健康研究中心（總體介紹在 302）$/m);
  assert.match(raw, /^四、來訪人員（共 3 位）\n1\. 佐藤花子　學院長\n2\. 山田太郎　教授$/m, "主賓排第一");
  assert.match(raw, /　　\d\d:\d\d–\d\d:\d\d　303 景觀環境模擬室　陳惠美（接待：王小明）/, "研究室參訪底下一間一行，寫接待人員");
  assert.ok(!/概要/.test(raw), "AI 沒寫成就沒有概要那一段");
  assert.match(raw, /、後續事項\n1\. 與使用者及其他賢哲共同討論療癒景觀\n2\. 在生態 app 中加入 ESG\n$/);
  assert.ok(!/合作意願/.test(raw), "沒有內容的段落整段不出現");
  const prose = { overview: "概要一段。", notes: ["寫好的一句。"], questions: ["來賓詢問……"], cooperation: [], follow_ups: ["只回了一項"] };
  const out = visitRecord(v, LABS, prose);
  assert.match(out, /、概要：概要一段。/);
  assert.match(out, /、交流重點\n1\. 寫好的一句。/);
  assert.match(out, /、後續事項\n1\. 與使用者及其他賢哲共同討論療癒景觀\n2\. 在生態 app 中加入 ESG/, "AI 回來的項數對不上：照原話，不少一項也不多一項");
  const forum = visitRecord({ ...v, format: "forum", attendance: { "301": "yes", "303": "no" }, programme: toForumProgramme(v.programme, v.start_time) }, LABS, null);
  assert.match(forum, /與中心老師座談（出席：張俊彥）/);
  assert.ok(!/研究室參訪/.test(forum), "座談的場次不寫研究室參訪");
});

test("答應提供的資料：網址或上傳的檔案；信裡用完整的網址", () => {
  const m = sanitizeMaterials({ links: [
    { title: "", url: "materials/2026-10-05-x/123-file.pdf", name: "療癒報告.pdf" },
    { title: "app", url: "https://example.org/app" },
    { title: "bad", url: "javascript:alert(1)" },
    { title: "別的", url: "../etc/passwd" },
  ] });
  assert.deepEqual(m.links, [{ title: "療癒報告", url: "materials/2026-10-05-x/123-file.pdf", name: "療癒報告.pdf" }, { title: "app", url: "https://example.org/app" }]);
  assert.deepEqual(promisedItems({ materials: m }, "https://visit.healsdesign.org/"), [
    { title: "療癒報告", url: "https://visit.healsdesign.org/api/media?key=materials/2026-10-05-x/123-file.pdf", file: true },
    { title: "app", url: "https://example.org/app", file: false },
  ]);
  assert.ok(pageContents({ materials: m }, LABS).some((c) => c.key === "links" && c.zh.includes("答應提供的資料")));
  // 一頁摘要：主持人存重點的時間比摘要新，就照新的重點重寫
  const past = { visit_id: "v", date: "2026-01-01", start_time: "10:00", duration_minutes: 60, summary: "舊的", summary_at: "2026-01-02T00:00:00Z", dictation: { extracted: { notes: ["a"] }, saved_at: "2026-01-03T00:00:00Z" } };
  assert.equal(needsSummary(past, [], new Date("2026-02-01")), true);
  assert.equal(needsSummary({ ...past, summary_at: "2026-01-04T00:00:00Z" }, [], new Date("2026-02-01")), false);
});
