/**
 * 瀏覽器冒煙測試（Playwright + Chromium）：主辦端建一次參訪 → 來賓端頁面 → 匿名回覆。
 * 用 file 後端（暫存目錄）與 AI_MOCK。playwright 優先用專案的，沒有就找全域安裝。
 *   node test/e2e/smoke.mjs
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Deck } from "../../cli/lib/pptx.mjs";

// 瀏覽器產檔用的合成母簡報（同 deck 測試；沒有 python-pptx 就跳過那一段）
const FIXTURE = "test/fixtures/generated/master-fixture.pptx";
if (!existsSync(FIXTURE)) spawnSync("python3", ["scripts/make-fixture.py", FIXTURE], { stdio: "inherit" });
const fixtureAvailable = existsSync(FIXTURE);

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
// 只有產簡報用的 JSZip 改由本機 node_modules 供應（後註冊的 route 先比對）
await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\//, (route) => route.fulfill({ path: "node_modules/jszip/dist/jszip.min.js", contentType: "text/javascript" }));

const check = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

try {
  // ── 主辦端 ──
  await page.goto(`${base}/admin.html`);
  await page.fill("#token", "e2e-token");
  await page.click("#tokenSave");
  await page.waitForFunction(() => document.getElementById("backendInfo").textContent.includes("file"));
  check(await page.isHidden("#token") && await page.isVisible("#authOk"), "token field is put away after login");
  await page.fill("#emailText", `Dear Prof. Chang,\n\nWe would like to visit on 2026-10-07 at 10:00. My colleague Jane Doe <jane@uwa.edu.au> joins me.\n\nSimon Kilbane, University of Western Australia\nsimon@uwa.edu.au`);
  await page.click("#extractBtn");
  await page.waitForFunction(() => document.getElementById("orgName").value.length > 0);
  check((await page.inputValue("#date")) === "2026-10-07", "extract fills the date");
  check((await page.locator("#guestTable tbody tr").count()) === 2, "extract lists both guests");
  await page.fill("#code", "uwa");
  await page.click("#planBtn");
  await page.waitForFunction(() => document.querySelectorAll("#programmeTable tbody tr").length > 0);
  check((await page.locator("#programmeTable tbody tr select").evaluateAll((els) => els.map((e) => e.options[e.selectedIndex].text))).includes("綜合討論"), "programme table shows a 綜合討論 block");
  check((await page.locator("#tab-pre #slideGrid").count()) === 0, "the pre-visit tab no longer carries the slide picker");
  check((await page.textContent("#itinerary label:first-child")).includes("總體介紹"), "route starts with the overall briefing");
  check((await page.inputValue('#itinerary input[data-room="briefing"]')) !== "0", "briefing has minutes");
  check((await page.inputValue("#itinerary [data-briefing-location]")) === "302", "briefing room defaults to 302");
  await page.click("#saveBtn");
  await page.waitForSelector("#afterSave:not([hidden])");
  const link = await page.textContent("#pageLink");
  check(link === `${base}/2026-10-07-uwa`, `saved visit has page url ${link}`);
  check((await page.textContent("#deckState")).includes("已選"), "the pre-visit tab only reports how many slides are picked");

  // ── 簡報分頁：選頁、不用簡報、產檔 ──
  await page.click("#openDeck");
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-slide]").length > 0);
  check((await page.inputValue("#deckVisitSelect")) === "2026-10-07-uwa", "「選頁與產生簡報」opens the deck tab on this visit");
  check((await page.locator("#slideGrid input[data-slide]:checked").count()) >= 5, "the plan's slides are waiting in the deck tab");
  check((await page.locator("#slideGrid fieldset[data-group]").count()) >= 10, "slides are grouped into blocks");
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
  await page.click("#slidesSave");
  await page.waitForFunction(() => /已儲存/.test(document.getElementById("slidesInfo").textContent));
  check(true, "選頁 saved from the deck tab");

  // 有些參訪只口頭介紹：勾「這場不用簡報」就收起選頁與產檔，而且存得住
  await page.check("#noDeck");
  await page.waitForFunction(() => document.getElementById("deckWork").hidden);
  await page.waitForFunction(() => /只口頭介紹/.test(document.getElementById("flash").textContent));
  await page.click('[data-tab="pre"]');
  check((await page.textContent("#deckState")).includes("不用簡報"), "the pre-visit tab says this visit has no deck");
  await page.click('[data-tab="deck"]');
  await page.waitForFunction(() => document.getElementById("deckStatus").textContent.includes("2026-10-07") || document.getElementById("deckStatus").textContent.includes("Western"));
  check(await page.isChecked("#noDeck"), "「不用簡報」survives a reload of the tab (stored on the visit)");
  await page.uncheck("#noDeck");
  await page.waitForSelector("#deckWork:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-slide]:checked").length > 0);

  // 直接在瀏覽器產 .pptx：站台沒有母簡報 → 按「產生簡報」直接跳選檔（這裡用合成母簡報）→ 下載 → 結構驗證
  if (fixtureAvailable) {
    await page.waitForFunction(() => /還沒放上站台/.test(document.getElementById("masterRow").textContent));
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#deckBtn")]);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), chooser.setFiles(FIXTURE)]);
    check(download.suggestedFilename() === "GHRC_2026-10-07-uwa.pptx", `one click → file picker → ${download.suggestedFilename()} downloaded`);
    const pptxPath = path.join(tmp, "browser.pptx");
    await download.saveAs(pptxPath);
    const built = await Deck.load(await readFile(pptxPath));
    const v = await built.validate();
    check(v.errors.length === 0 && v.slideCount === 6, `browser-built deck is valid with ${v.slideCount} slides (4 always-slides + ask + QR)${v.errors.length ? ": " + v.errors.join("; ") : ""}`);
    await page.waitForFunction(() => /已下載/.test(document.getElementById("deckInfo").textContent));
    // 把這份母簡報存到站台（分塊上傳），重新載入後不必選檔就能產
    await page.click("#saveMasterBtn");
    await page.waitForFunction(() => /移除/.test(document.getElementById("masterRow").textContent), null, { timeout: 60000 });
    const storedMb = parseFloat((/([\d.]+) MB/.exec(await page.textContent("#masterRow")) || [])[1] || "99");
    check(storedMb < 3, `master was slimmed in the browser before storing (${storedMb} MB, fixture is 11.3 MB with a video)`);
    check(/瘦身：抽掉 1 個影片/.test(await page.textContent("#deckReport")), "slim report shown: 1 video stripped");
    check((await page.locator("#subLinks").count()) === 0, "the pre-visit block does not carry the two interaction links");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("backendInfo").textContent.includes("file"));
    await page.click('[data-tab="deck"]');
    await page.selectOption("#deckVisitSelect", "2026-10-07-uwa");
    await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-slide]").length > 0);
    await page.waitForFunction(() => /移除/.test(document.getElementById("masterRow").textContent));
    const [download2] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#deckBtn")]);
    const pptxPath2 = path.join(tmp, "browser2.pptx");
    await download2.saveAs(pptxPath2);
    const v2 = await (await Deck.load(await readFile(pptxPath2))).validate();
    check(v2.errors.length === 0 && v2.slideCount === 6, "deck built from the master stored on the site (chunked download, no file picker)");
  } else console.log("skip - browser deck build (python-pptx fixture unavailable)");
  await page.click('[data-tab="pre"]');
  await page.selectOption("#preVisitSelect", "2026-10-07-uwa");
  await page.waitForSelector("#afterSave:not([hidden])");
  check((await page.textContent("#deckState")).includes("已選"), "the pre-visit tab reports the saved slide count after a reload");
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
  const wrapLinks = await page.textContent("#wrapLinks");
  check(wrapLinks.includes("#email") && wrapLinks.includes("#respond"), "after the visit, the wrap-up tab produces the on-site email and response links");

  // 動作三：合照與連結放上專屬頁面
  const pngPath = path.join(tmp, "group.png");
  await writeFile(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  await page.setInputFiles("#photoFiles", pngPath);
  await page.waitForSelector("#photoList img");
  check((await page.textContent("#materialsStatus")).includes("已放上 1 張"), "the photo upload reports back where the work is happening, not only at the top of the page");

  // 縮圖失敗（iPhone 的 HEIC、壞檔）不能沒有反應：退回原檔上傳，狀態列要有交代
  const badPath = path.join(tmp, "broken.jpg");
  await writeFile(badPath, Buffer.from("這不是圖檔，瀏覽器解不開"));
  await page.evaluate(() => (document.getElementById("materialsStatus").textContent = ""));
  await page.setInputFiles("#photoFiles", badPath);
  await page.waitForFunction(() => /已放上 1 張合照/.test(document.getElementById("materialsStatus").textContent), null, { timeout: 20000 });
  check((await page.$$("#photoList img")).length === 2, "a photo the browser cannot decode is uploaded as-is instead of hanging with no feedback");
  await page.click("#photoList [data-remove-photo]:last-of-type");
  await page.waitForFunction(() => document.querySelectorAll("#photoList img").length === 1);
  check(true, "removing a photo takes it off the visit page");

  await page.click("#linkAdd");
  await page.fill("#linkTable tbody tr:last-child td:nth-child(1) input", "Lab 303 papers");
  await page.fill("#linkTable tbody tr:last-child td:nth-child(2) input", "https://scholar.example/303");
  await page.click("#materialsSave");
  await page.waitForFunction(() => document.getElementById("materialsInfo").textContent.includes("已儲存"));
  check(true, "photo uploaded and link saved for the visit page");

  // 訪後信分頁
  await page.click('[data-tab="post"]');
  await page.selectOption("#postVisitSelect", "2026-10-07-uwa");
  await page.click("#thanksBtn");
  await page.waitForFunction(() => document.getElementById("thanksBody").value.includes("what should we be doing better"));
  await page.waitForFunction(() => document.querySelectorAll("#recipients input").length === 2);
  check(true, "thanks letter drafted with the 請益 wording and 2 recipients");

  // ── 來賓端：首頁（沒有參訪代碼）一律從訪前開始 ──
  await page.goto(`${base}/`);
  await page.waitForSelector("#lab-303");
  check((await page.textContent("#labsTitle")).includes("will visit") && (await page.isHidden("#respond")) && (await page.isHidden("#emailSec")), "landing page without a visit starts in the pre-visit state");

  // ── 來賓端（日期在未來 → 訪前措辭） ──
  await page.goto(`${base}/2026-10-07-uwa`);
  await page.waitForSelector("#lab-303");
  check((await page.textContent("#labsTitle")).includes("will visit") && (await page.isHidden("#respond")) && (await page.isHidden("#emailSec")), "before the visit: future tense, no thank-you form, no on-site email box");
  await page.goto(`${base}/2026-10-07-uwa#email`);
  await page.waitForSelector("#emailSec:not([hidden])");
  check(await page.isHidden("#respond"), "#email link opens the on-site email box on its own, even before the visit");
  check((await page.textContent("#lab-301")).includes("seven-workstation"), "301 describes a seven-workstation array");
  check((await page.locator("#labs article").count()) === 6, "guest page shows the briefing step plus five lab cards");
  check((await page.textContent("#labs article:first-child")).includes("Center overview"), "briefing card comes first");
  check((await page.textContent("#lab-303")).includes("陳惠美") && !(await page.textContent("#lab-303")).includes("鄭佳昆"), "303 lists only 陳惠美");
  check((await page.textContent("#lab-305")).includes("IVR Research Lab") && !(await page.textContent("#lab-305")).includes("outside"), "305 is the IVR Research Lab");
  check((await page.textContent("#briefing-card")).includes("302"), "guest page shows the briefing in 302");
  check((await page.textContent("#lab-303")).includes("Landscape Simulation Lab") && (await page.textContent("#lab-303")).includes("景觀環境模擬室"), "English visit is still bilingual: English first, Chinese second");
  check((await page.textContent("#programme li:first-child")).includes("總體介紹"), "programme block gets the Chinese label when the plan left title_2nd empty");
  check((await page.locator("#programme li").count()) > 0, "programme rendered");
  await page.waitForSelector("#materialsSec:not([hidden])");
  check((await page.locator("#photoGrid img").count()) === 1 && (await page.textContent("#linkList")).includes("Lab 303 papers"), "visit page shows the uploaded photo and the link");
  check((await page.getAttribute("#photoGrid img", "src")).startsWith("/api/media?key=materials%2F"), "photo comes from the public media endpoint");
  await page.locator("#lab-303").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#lab-303").classList.contains("in"));
  check(await page.isVisible("#lab-303"), "reveal animation runs when a card scrolls into view and leaves it visible");

  // 當天：留信箱與備援按鍵出現
  await page.goto(`${base}/2026-10-07-uwa?phase=today`);
  // #emailSec 在 HTML 裡本來就沒有 hidden，要等腳本把標題填好才算渲染完
  await page.waitForFunction(() => document.getElementById("labsTitle").textContent.length > 0);
  check((await page.textContent("#labsTitle")).includes("Today") && (await page.isVisible("#emailSec")), "on the day: today's laboratories, on-site email box shown");
  await page.fill("#emailEmail", "walkin@example.org");
  await page.click("#emailSend");
  await page.waitForSelector("#emailDone:not([hidden])");
  check(true, "onsite email captured");

  // 訪後（感謝信的 #respond 連結）：過去式，三個回應項目
  await page.goto(`${base}/2026-10-07-uwa#respond`);
  await page.waitForFunction(() => document.getElementById("labsTitle").textContent.length > 0);
  check((await page.textContent("#labsTitle")).includes("visited") && (await page.textContent("#welcome")).includes("Thank you") && (await page.isHidden("#emailSec")), "after the visit: past tense, thank-you heading, no on-site email box");
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
