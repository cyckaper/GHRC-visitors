import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posterContent, posterLang, writtenIn, roomRange } from "../public/lib/poster.mjs";

const i18n = JSON.parse(readFileSync("public/data/i18n.json", "utf8"));

test("歡迎海報：英文為主、來訪者的語言為輔；英語與中文來賓的第二語言都是中文", () => {
  assert.deepEqual(["en", "zh", "ko", "ja", undefined].map(posterLang), ["zh", "zh", "ko", "ja", "zh"]);
  const c = posterContent({ language: "ko", org: { name: "Rural Development Administration", name_local: "농촌진흥청" }, date: "2026-09-07", page_url: "https://visit.example.test/2026-09-07-rda" }, i18n);
  assert.deepEqual([c.welcome.en, c.welcome.l2], ["Welcome", "환영합니다"]);
  assert.deepEqual([c.org.en, c.org.l2], ["Rural Development Administration", "농촌진흥청"]);
  assert.equal(c.qr_url, "https://visit.example.test/2026-09-07-rda");
  assert.equal(c.caption.l2, i18n.ko.poster_qr);
  assert.deepEqual(c.warnings, []);
  // 固定的字四種語言都有（跟來賓專頁同一份、同一套校對）
  for (const lang of ["en", "zh", "ko", "ja"]) for (const k of ["poster_welcome", "poster_programme", "poster_qr"]) assert.ok(i18n[lang][k], `${lang}.${k}`);
});

test("對方的名稱不翻譯：當地語名稱不是那個語言的字就不印，並說一聲", () => {
  const c = posterContent({ language: "ko", org: { name: "Rural Development Administration", name_local: "韓國農村振興廳" } }, i18n);
  assert.equal(c.org.l2, "", "韓國團的海報不印中文寫的名稱");
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0].zh, /不是韓文/);
  assert.match(c.warnings[0].en, /not in Korean/);
  assert.equal(posterContent({ language: "ja", org: { name: "Awaji Landscape Planning and Horticulture Academy", name_local: "淡路景観園芸学校" } }, i18n).org.l2, "淡路景観園芸学校", "日文的單位名稱可以全是漢字");
  assert.equal(posterContent({ language: "en", org: { name: "University of Western Australia", name_local: "" } }, i18n).org.l2, "", "沒有就不印，也不必說");
  assert.equal(posterContent({ language: "zh", org: { name: "Dun Yang Engineering", name_local: "Dun Yang Engineering" } }, i18n).org.l2, "", "跟英文一樣就不重複");
  assert.ok(writtenIn("西澳大學", "zh") && !writtenIn("농촌진흥청", "zh") && !writtenIn("Western", "zh") && !writtenIn("", "ko"));
});

test("主賓：名單上標主賓的人；四位以上寫前兩位加「and N colleagues」，跟簡報封面同一個寫法", () => {
  const g = (name, role = "lead", title = "") => ({ name, title, role });
  const one = posterContent({ language: "en", guests: [g("Simon Kilbane", "lead", "Programme Director"), g("Jane Doe", "member")] }, i18n);
  assert.deepEqual(one.people, [{ name: "Simon Kilbane", title: "Programme Director", lang: "en" }], "隨行的人不上海報");
  assert.equal(one.more.count, 0);
  const many = posterContent({ language: "ko", guests: [g("김민수"), g("이서연"), g("박지훈"), g("최유진")] }, i18n);
  assert.equal(many.people.length, 2);
  assert.equal(many.people[0].lang, "ko", "韓文名字用韓文的字形排");
  assert.deepEqual([many.more.count, many.more.en, many.more.l2], [2, "and 2 colleagues", "외 2명"]);
  assert.equal(posterContent({ language: "zh", guests: [g("王大明", "lead", "院長")] }, i18n).people[0].lang, "zh-Hant");
});

test("流程的第二語言：自己寫的那一欄要是那個語言的字；固定的區塊用校過的寫法；自己加的區塊沒有就只印英文", () => {
  const visit = {
    language: "ko",
    itinerary: [{ room: "briefing", minutes: 20, location: "" }, { room: "301", minutes: 20 }, { room: "302", minutes: 20 }, { room: "303", minutes: 0 }, { room: "304", minutes: 20 }],
    programme: [
      { start: "14:00", kind: "briefing", title_en: "Welcome and centre overview", title_2nd: "歡迎與中心總體介紹" },
      { start: "14:20", kind: "tour", title_en: "Laboratory visits", title_2nd: "研究室參訪", rooms: [] },
      { start: "15:20", kind: "other", title_en: "Greenhouse walk", title_2nd: "溫室參觀" },
      { start: "15:40", kind: "photo", title_en: "", title_2nd: "단체 사진" },
    ],
  };
  const c = posterContent(visit, i18n);
  assert.deepEqual(c.programme.map((r) => r.l2), [i18n.ko.kind_briefing, i18n.ko.kind_tour, "", "단체 사진"], "預設那一欄是中文，韓國團不能印中文");
  assert.deepEqual(c.programme.map((r) => r.en), ["Welcome and centre overview", "Laboratory visits", "Greenhouse walk", i18n.en.kind_photo]);
  assert.deepEqual(c.programme.map((r) => r.place_en), ["Room 302", "Rooms 301, 302, 304", "", ""], "總體介紹預設在 302；不去的那一間（0 分）不寫");
  assert.equal(c.programme[0].place_l2, "302호");
  assert.equal(c.programme[0].time, "14:00");
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0].en, /Greenhouse walk/);

  const zh = posterContent({ ...visit, language: "zh" }, i18n);
  assert.deepEqual(zh.programme.map((r) => r.l2), ["歡迎與中心總體介紹", "研究室參訪", "溫室參觀", i18n.zh.kind_photo]);
  assert.equal(zh.programme[1].place_l2, "301, 302, 304 室");
  assert.deepEqual(zh.warnings, []);

  // 日文只認有假名的：只有漢字的多半是預設的中文（「綜合討論」不是日文）
  const ja = posterContent({ language: "ja", programme: [{ start: "10:00", kind: "discussion", title_en: "General discussion", title_2nd: "綜合討論" }] }, i18n);
  assert.equal(ja.programme[0].l2, i18n.ja.kind_discussion);
  // 研究室參訪自己帶著房號的就照它
  const own = posterContent({ language: "en", programme: [{ start: "10:20", kind: "tour", title_en: "Laboratory visits", rooms: ["301", "302", "303", "304", "305"] }] }, i18n);
  assert.deepEqual([own.programme[0].place_en, own.programme[0].place_l2], ["Rooms 301–305", "301–305 室"]);
});

test("房號：連號寫成範圍、不連號逐一列", () => {
  assert.equal(roomRange(["301", "302", "303", "304", "305"]), "301–305");
  assert.equal(roomRange(["304", "301"]), "301, 304");
  assert.equal(roomRange(["302", "302"]), "302");
  assert.equal(roomRange([]), "");
});
