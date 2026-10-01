/** 匯入以前的參訪名單：照欄名讀、日期各種寫法、拆列、預覽時找出已經有的、做成要存的那一筆。 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDate, splitList, guessOrgType, parseVisitTable, planImport, importedVisit, cleanRow } from "../lib/import.mjs";

test("日期：各種寫法都收成 YYYY-MM-DD，看不出來就留空", () => {
  assert.equal(normalizeDate("2024-01-08"), "2024-01-08");
  assert.equal(normalizeDate("2024/1/8"), "2024-01-08");
  assert.equal(normalizeDate("2024.1.8"), "2024-01-08");
  assert.equal(normalizeDate("2024年1月8日"), "2024-01-08");
  assert.equal(normalizeDate("113/1/8"), "2024-01-08", "民國年");
  assert.equal(normalizeDate("45299"), "2024-01-08", "Excel 的日期數字（CSV 匯出常見）");
  assert.equal(normalizeDate("2024/2/30"), "", "不存在的日子不算");
  assert.equal(normalizeDate("明年春天"), "");
  assert.equal(normalizeDate(""), "");
});

test("一格裡的幾樣東西用頓號分；括號裡的頓號不算", () => {
  assert.deepEqual(splitList("美國伊利諾大學、芬蘭赫爾辛基大學"), ["美國伊利諾大學", "芬蘭赫爾辛基大學"]);
  assert.deepEqual(splitList("韓國建國大學農業治癒融合研究中心（Digital Humanities、Konkuk University）"), ["韓國建國大學農業治癒融合研究中心（Digital Humanities、Konkuk University）"]);
  assert.deepEqual(splitList("美國, 芬蘭", /[、，,]/), ["美國", "芬蘭"]);
});

test("單位類型：公司、學校、大學、政府、團體；看不出來再參考原表的類別", () => {
  assert.equal(guessOrgType("佐臻股份有限公司（AR眼鏡公司）"), "enterprise");
  assert.equal(guessOrgType("亞太區 Apple 團隊"), "enterprise");
  assert.equal(guessOrgType("國立臺灣大學學生事務處"), "university");
  assert.equal(guessOrgType("國立臺灣師範大學附屬高級中學"), "school", "大學的附中是高中");
  assert.equal(guessOrgType("農業部桃園區農業改良場"), "government");
  assert.equal(guessOrgType("法國高等教育暨研究與創新部"), "government");
  assert.equal(guessOrgType("某某", "政府"), "government");
  assert.equal(guessOrgType("某某"), "other");
});

test("照欄名讀 CSV：引號裡的逗號與換行、表頭不在第一列、國家寫了好幾國就拆開", () => {
  const csv = [
    "以前的參訪,,,",
    "日期,來訪單位,國家,來訪人員,交流重點",
    '2024/1/8,"美國伊利諾大學、芬蘭赫爾辛基大學","美國、芬蘭","John A. Smith 教授（伊利諾大學）、Aino Virtanen 教授（赫爾辛基大學）","講者, 工作坊',
    '第二行"',
    "2024/4/21,國立臺灣大學生物產業傳播暨發展學系 EMBA,臺灣,EMBA 學員，共 38 位,",
    "",
    "統計,22",
  ].join("\n");
  const { rows, skipped } = parseVisitTable(csv);
  assert.deepEqual(skipped, []);
  assert.equal(rows.length, 3, "空行之後是統計，不算");
  assert.deepEqual(rows.map((r) => [r.org.name_local, r.org.country]), [["美國伊利諾大學", "美國"], ["芬蘭赫爾辛基大學", "芬蘭"], ["國立臺灣大學生物產業傳播暨發展學系 EMBA", "臺灣"]]);
  assert.equal(rows[0].source_row, rows[1].source_row, "同一列拆出來的");
  assert.equal(rows[0].purpose, "講者, 工作坊\n第二行");
  assert.deepEqual(rows[1].people, [{ name: "Aino Virtanen", title: "教授" }]);
  assert.equal(rows[1].headcount, 1, "只有一個有名字的人");
  assert.equal(rows[2].headcount, 38, "原表寫了人數就照填");
  assert.deepEqual(rows[2].people, [], "「學員」不是一個人");
  assert.match(parseVisitTable("姓名,email\nKim,kim@x").skipped[0], /表頭/, "沒有日期與來訪單位的欄名就說找不到表頭");
});

test("只寫職稱的、單位加職稱的，都不當成人名", () => {
  const tsv = ["日期\t來訪單位\t國家\t來訪人員", "2024-06-21\t美國德州大學阿靈頓分校建築學院\t美國\t建築與公共事務學院院長、景觀系主任", "2025-02-26\t佐臻股份有限公司\t臺灣\t王大明副總經理", "2024-04-29\t農業部桃園區農業改良場\t臺灣\t陳小華場長與同仁"].join("\n");
  const rows = parseVisitTable(tsv).rows;
  assert.deepEqual(rows[0].people, []);
  assert.deepEqual(rows[1].people, [{ name: "王大明", title: "副總經理" }]);
  assert.equal(rows[2].headcount, 0, "「與同仁」：不知道幾位就是 0");
});

test("預覽：配網址、同一天撞名接 -2；系統裡已經有的（同一天、同一個單位）與名單裡重複的不再建", () => {
  const existing = [{ visit_id: "2025-04-21-konkuk", date: "2025-04-21", org: { name: "Konkuk University", name_local: "韓國建國大學" } }, { visit_id: "2024-01-08-illinois", date: "2024-01-08", org: { name: "Other place" } }];
  const plan = planImport(
    [
      { source_row: "1", date: "2024-01-08", org: { name: "University of Illinois Urbana-Champaign", name_local: "美國伊利諾大學", type: "university", country: "United States" } },
      { source_row: "1", date: "2024/1/8", code: "Helsinki!", org: { name: "University of Helsinki", name_local: "芬蘭赫爾辛基大學", type: "university", country: "Finland" } },
      { source_row: "15", date: "2025-04-21", org: { name: "Konkuk University Agro-Healing Center", name_local: "韓國建國大學", type: "nope", country: "South Korea" } },
      { source_row: "16", date: "2024-01-08", org: { name: "university of illinois urbana-champaign", name_local: "", type: "university", country: "United States" } },
      { source_row: "17", date: "", org: { name: "No Date University", type: "university", country: "" } },
    ],
    existing,
  );
  assert.equal(plan[0].visit_id, "2024-01-08-illinois-2", "撞到既有的網址就接 -2");
  assert.equal(plan[1].visit_id, "2024-01-08-helsinki", "AI 給的代碼只留小寫英數");
  assert.equal(plan[1].date, "2024-01-08");
  assert.ok(plan[0].split && plan[1].split && !plan[2].split);
  assert.equal(plan[2].exists, "2025-04-21-konkuk", "中文名稱對得上就算已經有了");
  assert.equal(plan[2].visit_id, "");
  assert.equal(plan[2].org.type, "university", "AI 給了不認得的類型就自己猜");
  assert.ok(plan[3].duplicate && !plan[3].visit_id, "名單裡同一天同一個單位出現兩次");
  assert.deepEqual(plan[4].problems, ["沒有日期"]);
});

test("要存的那一筆：原表沒有的不補；臺灣來的輔助語言用中文；記著從哪裡來、同一列算同一場", () => {
  const r = cleanRow({ source_row: "14", date: "2025-02-26", code: "jorjin", org: { name: "Jorjin Technologies Inc.", name_local: "佐臻股份有限公司", type: "enterprise", country: "Taiwan" }, people: [{ name: "王大明", title: "副總經理" }], people_text: "王大明副總經理", headcount: 1, companions: "", purpose: "參訪 303 與 304" });
  const v = importedVisit({ ...r, visit_id: "2025-02-26-jorjin" }, { file: "GHRC-參訪名單.xlsx", at: "2026-10-01T00:00:00Z" });
  assert.equal(v.visit_id, "2025-02-26-jorjin");
  assert.equal(v.language, "zh");
  assert.equal(v.contact_teacher, "", "對口老師不知道就留空");
  assert.deepEqual(v.itinerary, [], "不知道當天去了哪幾間");
  assert.equal(v.status, "done");
  assert.deepEqual(v.guests, [{ name: "王大明", title: "副總經理", email: "", role: "lead" }]);
  assert.deepEqual(v.imported, { from: "GHRC-參訪名單.xlsx", row: "14", group: "GHRC-參訪名單.xlsx#14", at: "2026-10-01T00:00:00Z", people: "王大明副總經理", companions: "" });
});
