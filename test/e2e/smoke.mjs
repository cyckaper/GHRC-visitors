/**
 * 瀏覽器冒煙測試（Playwright + Chromium）：主辦端建一次參訪 → 來賓端頁面 → 匿名回覆。
 * 用 file 後端（暫存目錄）與 AI_MOCK。playwright 優先用專案的，沒有就找全域安裝。
 *   node test/e2e/smoke.mjs
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const g = execSync("npm root -g").toString().trim();
    return import(pathToFileURL(path.join(g, "playwright", "index.mjs")).href).catch(() => import(pathToFileURL(path.join(g, "playwright", "index.js")).href));
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "ghrc-e2e-"));
process.env.STORE_BACKEND = "file";
process.env.STORE_DIR = tmp;
process.env.AI_MOCK = "1";
process.env.ADMIN_TOKEN = "e2e-token";
process.env.SIGNAL_KEY = "e2e-signal";
const { createServer } = await import("../../scripts/dev-server.mjs");
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.SITE_URL = base;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
// 資源載入失敗（被擋的 CDN、登入前的 401）不算頁面錯誤；只抓 script 例外與其他 console error
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errors.push(`console: ${m.text()}`); });
// CDN 資源在沙箱裡可能抓不到：擋掉外部請求，頁面仍須正常運作
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());

const check = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

try {
  // ── 主辦端 ──
  await page.goto(`${base}/admin.html`);
  await page.fill("#token", "e2e-token");
  await page.click("#tokenSave");
  await page.waitForFunction(() => document.getElementById("backendInfo").textContent.includes("file"));
  await page.fill("#emailText", `Dear Prof. Chang,\n\nWe would like to visit on 2026-10-07 at 10:00. My colleague Jane Doe <jane@uwa.edu.au> joins me.\n\nSimon Kilbane, University of Western Australia\nsimon@uwa.edu.au`);
  await page.click("#extractBtn");
  await page.waitForFunction(() => document.getElementById("orgName").value.length > 0);
  check((await page.inputValue("#date")) === "2026-10-07", "extract fills the date");
  check((await page.locator("#guestTable tbody tr").count()) === 2, "extract lists both guests");
  await page.fill("#code", "uwa");
  await page.click("#planBtn");
  await page.waitForFunction(() => document.querySelectorAll("#programmeTable tbody tr").length > 0);
  check((await page.locator("#slideGrid input[data-slide]:checked").count()) >= 5, "plan selects slides");
  check((await page.locator("#programmeTable tbody tr select").evaluateAll((els) => els.map((e) => e.options[e.selectedIndex].text))).includes("綜合討論"), "programme table shows a 綜合討論 block");
  check((await page.locator("#slideGrid fieldset[data-group]").count()) >= 10, "slides are grouped into blocks");
  const before = await page.locator("#slideGrid input[data-slide]:checked").count();
  await page.click("#slidesNone");
  check((await page.locator("#slideGrid input[data-slide]:checked").count()) === 5, "全不選 keeps only the five always-slides");
  await page.click('#slideGrid [data-group-only="lab302"]');
  check((await page.locator('#slideGrid [data-group="lab302"] input[data-slide]:checked').count()) === 8 && (await page.locator("#slideGrid input[data-slide]:checked").count()) === 13, "只選這區 selects the whole block plus always-slides");
  await page.check('#slideGrid [data-group-toggle="ch06"]');
  check((await page.locator("#slideGrid input[data-slide]:checked").count()) === 19, "block toggle adds the whole block");
  await page.click("#slidesAll");
  check((await page.locator("#slideGrid input[data-slide]:checked").count()) === 72, "全選 selects every slide");
  await page.click("#slidesNone");
  await page.click('#slideGrid [data-group-only="lab303"]');
  check(before > 0, "restored a selection for the rest of the flow");
  check((await page.textContent("#itinerary label:first-child")).includes("總體介紹"), "route starts with the overall briefing");
  check((await page.inputValue('#itinerary input[data-room="briefing"]')) !== "0", "briefing has minutes");
  await page.click("#saveBtn");
  await page.waitForSelector("#afterSave:not([hidden])");
  const link = await page.textContent("#pageLink");
  check(link === `${base}/2026-10-07-uwa`, `saved visit has page url ${link}`);
  await page.click("#confirmLetterBtn");
  await page.waitForFunction(() => document.getElementById("confirmBody").value.length > 0);
  check(true, "confirmation letter drafted");

  // 收工分頁：用打字的逐字稿
  await page.click('[data-tab="wrapup"]');
  await page.selectOption("#wrapVisitSelect", "2026-10-07-uwa");
  await page.fill("#transcript", "今天校長來，最想看 303 的模擬，問了能不能合作。");
  await page.click("#extractDictationBtn");
  await page.waitForSelector("#dictationFields:not([hidden])");
  check((await page.inputValue("#dRooms")) === "303", "dictation extraction finds room 303");
  await page.click("#dictationSave");
  await page.waitForFunction(() => document.getElementById("dictationInfo").textContent.includes("已存入"));

  // 訪後信分頁
  await page.click('[data-tab="post"]');
  await page.selectOption("#postVisitSelect", "2026-10-07-uwa");
  await page.click("#thanksBtn");
  await page.waitForFunction(() => document.getElementById("thanksBody").value.includes("what should we be doing better"));
  await page.waitForFunction(() => document.querySelectorAll("#recipients input").length === 2);
  check(true, "thanks letter drafted with the 請益 wording and 2 recipients");

  // ── 來賓端 ──
  await page.goto(`${base}/2026-10-07-uwa`);
  await page.waitForSelector("#lab-303");
  check((await page.locator("#labs article").count()) === 6, "guest page shows the briefing step plus five lab cards");
  check((await page.textContent("#labs article:first-child")).includes("Center overview"), "briefing card comes first");
  check((await page.textContent("#lab-303")).includes("陳惠美") && !(await page.textContent("#lab-303")).includes("鄭佳昆"), "303 lists only 陳惠美");
  check((await page.locator("#programme li").count()) > 0, "programme rendered");
  check((await page.textContent("#qBetter")) === "From your perspective, what should we be doing better?", "open-suggestion wording is the 請益 question");
  await page.check("#anonymous");
  check(await page.isHidden("#identity"), "identity fields hidden when anonymous");
  await page.check('input[name="coop"][value="302"]');
  await page.fill("#suggestion", "Room 302 was hard to follow.");
  await page.click("#respondSend");
  await page.waitForSelector("#respondDone:not([hidden])");
  const rows = JSON.parse(await readFile(path.join(tmp, "responses.json"), "utf8"));
  const anon = rows.find((r) => r.suggestion === "Room 302 was hard to follow.");
  check(anon && anon.anonymous && anon.name === "" && anon.email === "" && anon.submitted_at.length === 10, "anonymous response stored without identity");

  await page.fill("#emailEmail", "walkin@example.org");
  await page.click("#emailSend");
  await page.waitForSelector("#emailDone:not([hidden])");
  check(true, "onsite email captured");

  check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  console.log("\nSMOKE OK");
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(tmp, "failure.png"), fullPage: true }).catch(() => {});
  console.error(`screenshot: ${path.join(tmp, "failure.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
