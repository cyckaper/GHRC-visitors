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
  // 還沒登入就先點「簡報」：要說是沒登入，不要怪到「還沒有參訪」頭上（登入是綁裝置的，換手機就會遇到）
  await page.click('[data-tab="deck"]');
  await page.waitForFunction(() => /登入/.test(document.getElementById("deckStatus").textContent));
  check(!(await page.textContent("#deckStatus")).includes("還沒有任何參訪"), "not signed in: the deck tab says so instead of blaming missing visits");
  await page.click('[data-tab="pre"]');
  await page.fill("#token", "e2e-token");
  await page.click("#tokenSave");
  await page.waitForFunction(() => /場參訪/.test(document.getElementById("backendInfo").textContent));
  check(await page.isHidden("#token") && await page.isVisible("#authOk"), "token field is put away after login");
  check(await page.evaluate(() => { try { return !localStorage.getItem("ghrc-admin-token"); } catch (e) { return true; } }), "the admin token is not left sitting in localStorage");
  // 登入一次就好：重新整理不必再貼一次 token（伺服器發的 cookie 記住了）
  await page.reload();
  await page.waitForFunction(() => /場參訪/.test(document.getElementById("backendInfo").textContent));
  check(await page.isHidden("#token") && await page.isVisible("#authOk"), "still signed in after a reload — nothing to paste again");

  // 一場參訪都還沒有的時候，簡報分頁仍要列出母簡報的頁次（只是不能存、不能產檔）
  await page.click('[data-tab="deck"]');
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-block]").length > 0);
  // 15 個區塊：研究成果 39–42 併進了 Lab 303（明確指示），所以比以前少一個
  check((await page.locator("#slideGrid input[data-block]").count()) === 15, "the master deck's blocks are listed even with no visit yet");
  check((await page.locator("#slideGrid input[data-slide]").count()) === 0, "…and there is no per-page checkbox to wade through");
  check((await page.$("#slidesSave")) === null, "there is no save-slides button — picking pages saves itself");
  check(await page.isDisabled("#deckBtn") && (await page.isVisible("#deckNeedsVisit")), "…but building is held back until a visit exists, and it says why");
  await page.click('[data-tab="pre"]');
  await page.fill("#emailText", `Dear Prof. Chang,\n\nWe would like to visit on 2026-10-07 at 10:00. My colleague Jane Doe <jane@uwa.edu.au> joins me.\n\nSimon Kilbane, University of Western Australia\nsimon@uwa.edu.au`);
  await page.click("#extractBtn");
  // 讀信也跑在背景（一封長信＋附件常常超過一般函式的 10 秒，會變成 504）：按下去先說在讀，輪詢到結果才填表
  await page.waitForFunction(() => /讀信中/.test(document.getElementById("extractInfo").textContent));
  check(true, "AI 抽取 runs in the background instead of holding the request open");
  await page.waitForFunction(() => document.getElementById("orgName").value.length > 0, null, { timeout: 90000 });
  check((await page.textContent("#extractInfo")) === "", "…and the progress line clears once the form is filled");
  check((await page.inputValue("#date")) === "2026-10-07", "extract fills the date");
  // 主辦端填的是幾點開始、幾點結束（不是「總分鐘」）；長度由這兩個算出來
  check((await page.$("#duration")) === null, "the form no longer asks for a total in minutes");
  await page.fill("#startTime", "10:00");
  await page.fill("#endTime", "12:30");
  await page.waitForFunction(() => /150/.test(document.getElementById("durationInfo").textContent));
  check(true, "the form works out the length from the two times");
  await page.fill("#endTime", "09:00");
  await page.waitForFunction(() => /晚於|later/.test(document.getElementById("durationInfo").textContent));
  check(true, "…and says so when the end is before the start");
  await page.fill("#endTime", "12:30");
  check((await page.locator("#guestTable tbody tr").count()) === 2, "extract lists both guests");
  // 存檔不是一個動作：抽取完就自己建好一場，改網址代碼就跟著改網址（還沒用出去之前）
  await page.waitForSelector("#afterSave:not([hidden])", { timeout: 30000 });
  check((await page.$("#saveBtn")) === null, "no save button — the extracted visit is created by itself");
  await page.fill("#orgCountry", "Australia"); // 英文來信抽不出國家；地圖靠這一欄
  await page.fill("#code", "uwa");
  await page.waitForFunction(() => /2026-10-07-uwa$/.test(document.getElementById("pageLink").textContent), null, { timeout: 30000 });
  check(/已存/.test(await page.textContent("#saveInfo")), "it says when it last saved");
  check((await page.locator("#visitSelect option").count()) === 2, "changing the code renames the visit instead of leaving a stray one behind");

  // 名單刪掉一列也要自己存：以前刪一列不會冒 input 事件，畫面刪了、伺服器沒刪，
  // 重新整理或下一次「AI 查訪客背景」那個人又回來（畫面上的「名單 N 人」來自伺服器存完回傳的那一筆）
  await page.click("#addGuest");
  await page.fill("#guestTable tbody tr:last-child td:nth-child(1) input", "Temp Person");
  await page.waitForFunction(() => /名單 3 人/.test(document.getElementById("progress").textContent), null, { timeout: 30000 });
  await page.click("#guestTable tbody tr:last-child [data-del-row]");
  await page.waitForFunction(() => /名單 2 人/.test(document.getElementById("progress").textContent), null, { timeout: 30000 });
  check(true, "deleting someone from the guest list saves by itself — they do not come back");

  // 今日流程是自動排的（各研究室在支援人力表上填的分鐘會自己排進來）：訪前不再有「AI 排行程」，
  // 平常只看一份排好的流程；可以改的那張表收在「要改再點開」裡
  check((await page.$("#planBtn")) === null, "the pre-visit tab has no AI scheduling button any more — the labs' own minutes fill the schedule");
  check((await page.locator("#tab-pre #slideGrid").count()) === 0, "the pre-visit tab no longer carries the slide picker");
  check(/綜合討論/.test(await page.textContent("#programmeView")) && (await page.locator("#programmeView .room").count()) === 5, "the schedule is already laid out to look at: 綜合討論 included, a line per lab under the tour");
  check(!(await page.$eval("#programmeEdit", (d) => d.open)) && !(await page.isVisible("#programmeTable")), "the editable table stays folded away until it is needed");
  await page.click("#programmeEdit summary");
  // 行程只有一張表：每一間幾分鐘就長在「研究室參訪」那一列底下，總體介紹的地點在 briefing 那一列
  check((await page.locator("#programmeTable tr[data-rooms-row]").count()) === 1, "the lab minutes live inside the one schedule table");
  check((await page.inputValue("#programmeTable [data-briefing-location]")) === "302", "briefing room defaults to 302, on the briefing row itself");
  check((await page.locator("#itinerary input[data-room]").count()) === 5, "one minutes box per lab");
  check(/五間合計 \d+ 分/.test(await page.textContent("#roomsTotal")), "it adds the lab minutes up");
  check((await page.locator("#programmeTable thead th").allTextContents()).every((t) => t !== "頁碼"), "nobody is asked to type slide numbers — the deck works them out");
  {
    // 分鐘一改，後面各段的時間就跟著往後推——**時間是算出來的，不是第二個要填的欄位**
    const before = await page.inputValue("#programmeTable tbody tr:last-child input[type=time]");
    const box = page.locator('#itinerary input[data-room="301"]');
    const minutes = (Number(await box.inputValue()) || 0) + 30;
    await box.fill(String(minutes));
    await page.waitForFunction((was) => document.querySelector("#programmeTable tbody tr:last-child input[type=time]").value !== was, before, { timeout: 15000 });
    check(/流程排了 \d+ 分/.test(await page.textContent("#programmeTotal")), "and says how long the whole thing runs");
    check(await page.evaluate((m) => [...document.querySelectorAll("#programmeView .room")].some((el) => el.textContent === "301" && el.parentElement.textContent.includes(`${m} 分`)), minutes), "the schedule you look at follows the table");
    // 開始時間一改，整排跟著往後推（以前流程停在舊的時間，要一列一列自己改）
    const start = await page.inputValue("#startTime");
    await page.fill("#startTime", "10:30");
    await page.waitForFunction(() => /^10:30–/.test(document.querySelector("#programmeView span").textContent), null, { timeout: 15000 });
    check((await page.inputValue("#programmeTable tbody tr:first-child input[type=time]")) === "10:30", "moving the start time moves the whole programme with it");
    await page.fill("#startTime", start);
    await page.waitForFunction((s) => document.querySelector("#programmeView span").textContent.startsWith(`${s}–`), start, { timeout: 15000 });
  }
  // 進度線：這一場到哪一步了，點一格跳到該做那件事的分頁
  check(/名單 2 人/.test(await page.textContent("#progress")), "the progress line counts the guest list");
  check(/·\s*感謝信/.test(await page.textContent("#progress")), "…and shows what has not been done yet");
  await page.click('#progress [data-go="wrapup"]');
  check(!(await page.isHidden("#tab-wrapup")), "clicking a step jumps to the tab where that step happens");
  await page.click('[data-tab="pre"]');

  const link = await page.textContent("#pageLink");
  check(link === `${base}/2026-10-07-uwa`, `saved visit has page url ${link}`);
  check((await page.$("#deckState")) === null && /選了 \d+ 頁/.test(await page.textContent("#progress")), "the pre-visit tab does not repeat the deck state — the progress line already has it");

  // 訪前功課：查網路跑在背景（一般函式 10 秒不夠），觸發後輪詢，查完自己出現，不必再按一次
  await page.click("#researchBtn");
  await page.waitForFunction(() => /查資料中/.test(document.getElementById("background").textContent));
  check(true, "researching the visitors runs in the background instead of holding the request open");
  await page.waitForFunction(() => document.querySelectorAll("#background li").length > 0, null, { timeout: 90000 });
  check((await page.textContent("#background")).includes("可能的參訪目的"), "the background card lists the likely purposes of the visit once it finishes");
  check(!/跑在背景|背景函式/.test(await page.textContent("#tab-pre")), "the pre-visit tab explains waits in plain words, not in terms of how the server is built");

  // ── 簡報分頁：選頁、不用簡報、產檔（從進度線那一格跳過去——訪前不再放跳分頁的按鈕）──
  await page.click('#progress [data-go="deck"]');
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-block]").length > 0);
  check((await page.inputValue("#visitSelect")) === "2026-10-07-uwa", "the progress line's 簡報 cell opens the deck tab on this visit");
  // 挑頁搬來這裡（以前是訪前「AI 排行程」順便挑）：跑在背景，挑完勾好區塊、寫一句為什麼、自己存——行程不動
  const routeBefore = JSON.stringify((await (await fetch(`${base}/api/visits?id=2026-10-07-uwa`, { headers: { authorization: "Bearer e2e-token" } })).json()).visit.itinerary);
  await page.click("#pickBtn");
  await page.waitForFunction(() => /AI 挑頁中/.test(document.getElementById("pickInfo").textContent));
  await page.waitForFunction(() => /挑了 \d+ 頁/.test(document.getElementById("pickInfo").textContent), null, { timeout: 90000 });
  check((await page.locator("#slideGrid input[data-block]:checked").count()) > 2 && (await page.textContent("#pickRationale")).trim().length > 0, "AI 挑頁 ticks blocks beyond the mandatory two, and says why");
  await page.waitForFunction(() => /已存 \d+ 頁/.test(document.getElementById("slidesInfo").textContent), null, { timeout: 30000 });
  const picked = (await (await fetch(`${base}/api/visits?id=2026-10-07-uwa`, { headers: { authorization: "Bearer e2e-token" } })).json()).visit;
  check(picked.slides.length > 5 && !!picked.plan_rationale && JSON.stringify(picked.itinerary) === routeBefore, "…saves the pick by itself, and leaves the schedule the labs filled in alone");
  // 顏色：研究室的區塊用那一間的顏色，值來自 public/data/labs.json（不是抄在頁面裡的第二份）
  const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
  const labColor = Object.fromEntries(JSON.parse(await readFile("public/data/labs.json", "utf8")).labs.map((l) => [l.room, hexToRgb(l.color)]));
  const leftEdge = (sel) => page.$eval(sel, (el) => getComputedStyle(el).borderLeftColor);
  // 選頁是「一個區塊一個勾」：必選的兩區鎖住，其他的整區進出
  const slideCount = async () => Number(/、(\d+) 頁/.exec(await page.textContent("#slideCount"))[1]);
  check((await page.locator("#slideGrid input[data-block][disabled]").count()) === 2, "the two mandatory blocks are locked on");
  await page.click("#slidesNone");
  check((await slideCount()) === 5, "全不選 keeps only the five always-slides");
  await page.click('#slideGrid [data-group-only="lab302"]');
  check((await page.isChecked('#slideGrid [data-block="lab302"]')) && (await slideCount()) === 13, "只選這區 takes the whole block plus the always-slides");
  check((await leftEdge('#slideGrid [data-group="lab302"]')) === labColor["302"], "a ticked lab block wears that lab's colour, straight from labs.json");
  await page.check('#slideGrid [data-block="ch06"]');
  check((await slideCount()) === 19, "ticking a block adds all of its pages at once");
  await page.click("#slidesAll");
  check((await slideCount()) === 72, "全選 selects every block");
  await page.click("#slidesNone");
  await page.click('#slideGrid [data-group-only="lab303"]');
  await page.waitForFunction(() => /已存 \d+ 頁/.test(document.getElementById("slidesInfo").textContent), null, { timeout: 30000 });
  check(true, "picking pages saves itself, no button to press");

  // 有些參訪只口頭介紹：勾「這場不用簡報」就收起選頁與產檔，而且存得住
  await page.check("#noDeck");
  await page.waitForFunction(() => document.getElementById("deckWork").hidden);
  await page.waitForFunction(() => /只口頭介紹/.test(document.getElementById("flash").textContent));
  await page.click('[data-tab="pre"]');
  check(/不用簡報/.test(await page.textContent("#progress")), "the progress line says this visit has no deck");
  await page.click('[data-tab="deck"]');
  await page.waitForFunction(() => document.getElementById("deckStatus").textContent.includes("2026-10-07") || document.getElementById("deckStatus").textContent.includes("Western"));
  check(await page.isChecked("#noDeck"), "「不用簡報」survives a reload of the tab (stored on the visit)");
  await page.uncheck("#noDeck");
  await page.waitForSelector("#deckWork:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-block]:checked").length > 0);

  // 一載入就直接點「簡報」分頁（boot 可能還沒跑完）也要看得到選項，不能一片空白
  await page.reload();
  await page.click('[data-tab="deck"]');
  await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-block]").length > 0, null, { timeout: 20000 });
  check(true, "the slide options are there even when the deck tab is opened before the page finished booting");

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
    // 瘦身改成「存到站台時才做」：產出來的那一份影片還在（現場播得動），站台上那一份才抽掉
    await page.waitForFunction(() => /瘦身：抽掉 1 個影片/.test(document.getElementById("deckInfo").textContent), null, { timeout: 30000 });
    check(true, "the copy saved to the site is slimmed: 1 video stripped");
    check((await built.files()).some((f) => /\.mp4$/i.test(f)) === false, "…while this visit's deck has no video because no video slide was picked");
    check((await page.locator("#subLinks").count()) === 0, "the pre-visit block does not carry the two interaction links");
    await page.reload();
    await page.waitForFunction(() => /場參訪/.test(document.getElementById("backendInfo").textContent));
    await page.click('[data-tab="deck"]');
    await page.selectOption("#visitSelect", "2026-10-07-uwa");
    await page.waitForFunction(() => document.querySelectorAll("#slideGrid input[data-block]").length > 0);
    await page.waitForFunction(() => /移除/.test(document.getElementById("masterRow").textContent));
    const [download2] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#deckBtn")]);
    const pptxPath2 = path.join(tmp, "browser2.pptx");
    await download2.saveAs(pptxPath2);
    const v2 = await (await Deck.load(await readFile(pptxPath2))).validate();
    check(v2.errors.length === 0 && v2.slideCount === 6, "deck built from the master stored on the site (chunked download, no file picker)");
  } else console.log("skip - browser deck build (python-pptx fixture unavailable)");
  await page.click('[data-tab="pre"]');
  await page.selectOption("#visitSelect", "2026-10-07-uwa");
  await page.waitForSelector("#afterSave:not([hidden])");
  check(/簡報已產|選了 \d+ 頁/.test(await page.textContent("#progress")), "the progress line reports the deck state after a reload");
  // 確認信在「訪前」（寄出去的那封信裡就有來賓專頁網址），感謝信在「後續」；沒有單獨的「信件」分頁
  check((await page.locator("#tab-pre #confirmLetterBtn").count()) === 1, "the confirmation letter lives on the pre-visit tab");
  check((await page.locator("#tab-wrapup #thanksBtn").count()) === 1, "the thank-you letter lives on the wrap-up tab");
  check((await page.locator('[data-tab="post"]').count()) === 0, "there is no separate letters tab any more");
  await page.click('#progress [data-go="pre"]');
  check(!(await page.isHidden("#tab-pre")), "the progress line's 確認信 cell stays on the pre-visit tab");
  await page.click("#confirmLetterBtn");
  // 草擬信件也跑在背景（Claude 寫一整封雙語信同樣超過 10 秒）
  await page.waitForFunction(() => /草擬中/.test(document.getElementById("confirmLetterInfo").textContent));
  await page.waitForFunction(() => document.getElementById("confirmBody").value.length > 0, null, { timeout: 60000 });
  check(true, "confirmation letter drafted in the background");
  check(await page.isVisible("#confirmDue"), "before the visit, the confirmation letter is the one flagged as due");
  check((await page.locator("#confirmRecipients input").count()) === 2, "the confirmation letter has the list in front of it");

  // 暫存：手改過還沒寄出的信、貼進來的那封 email，關掉網頁再打開都還在（以前一關就沒了）
  const draftSaved = page.waitForResponse((r) => r.url().includes("/api/draft") && r.request().method() === "POST", { timeout: 20000 });
  await page.fill("#confirmBody", (await page.inputValue("#confirmBody")) + "\n\nP.S. 停車請走側門。");
  await draftSaved;
  await page.reload();
  await page.waitForFunction(() => document.getElementById("emailText").value.includes("Simon Kilbane"), null, { timeout: 30000 });
  check(true, "the pasted email is still there after closing the page — and it followed the visit when the url was renamed");
  check(await page.isVisible("#emailDraftNote"), "…and it says why that text is sitting there");
  await page.waitForFunction(() => document.querySelectorAll("#confirmRecipients input").length === 2);
  await page.waitForFunction(() => /停車請走側門/.test(document.getElementById("confirmBody").value), null, { timeout: 30000 });
  check(true, "a hand-edited letter that was never sent comes back instead of being lost");
  check(await page.isVisible("#confirmDraftNote"), "…and it says so next to the letter");

  // 後續分頁：用打字的逐字稿
  await page.click('[data-tab="wrapup"]');
  await page.selectOption("#visitSelect", "2026-10-07-uwa");
  await page.waitForFunction(() => /名單目前/.test(document.getElementById("cardStatus").textContent)); // 等這一頁載完再打字
  await page.fill("#transcript", "今天校長來，最想看 303 的模擬，問了能不能合作。");
  await page.click("#extractDictationBtn");
  await page.waitForSelector("#dictationFields:not([hidden])", { timeout: 60000 });
  check((await page.inputValue("#dRooms")) === "303", "dictation extraction finds room 303");
  await page.click("#dictationSave");
  await page.waitForFunction(() => document.getElementById("dictationInfo").textContent.includes("已存入"));
  const wrapLinks = await page.textContent("#wrapLinks");
  check(/結束時間一到.*寄一封提醒/s.test(await page.textContent("#tab-wrapup")), "the wrap-up tab promises the reminder arrives by itself at the end of the programme");
  check(wrapLinks.includes("#email") && wrapLinks.includes("#respond"), "after the visit, the wrap-up tab produces the on-site email and response links");
  check((await page.locator("#wrapLinks [data-copy]").count()) === 3, "all three links to the guest page are listed in one place");
  check(/參訪當天用/.test(wrapLinks) && /訪後用/.test(wrapLinks), "…each saying when to use it");

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

  // 後續分頁的動作五：感謝信
  await page.click('[data-tab="wrapup"]');
  await page.selectOption("#visitSelect", "2026-10-07-uwa");
  await page.click("#thanksBtn");
  await page.waitForFunction(() => document.getElementById("thanksBody").value.includes("what should we be doing better"), null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll("#thanksRecipients input").length === 2);
  check(true, "thanks letter drafted with the 請益 wording and 2 recipients");
  // 「寄出」兩個字看不出寄給誰：按鈕上直接寫人數，旁邊列出名字
  check(/寄出感謝信（2 位）/.test(await page.textContent("#sendBtn")), "the send button says how many people it is about to write to");
  check(/會寄給：/.test(await page.textContent("#thanksWho")), "…and names them");
  await page.uncheck("#thanksRecipients input:first-child");
  await page.waitForFunction(() => /1 位/.test(document.getElementById("sendBtn").textContent));
  check(true, "unticking someone changes the count before anything is sent");
  await page.check("#thanksRecipients input:first-child");

  // 沒有簽名簿、沒交換名片的場次一樣走完了：標「本次沒有」就不算未完成，提醒也不再催
  await page.check('[data-na="signbook"]');
  await page.waitForFunction(() => /不會再提醒/.test(document.getElementById("flash").textContent));
  await page.click('[data-tab="pre"]');
  check(/簽名簿 本次沒有/.test(await page.textContent("#progress")), "a step marked “not this time” reads that way in the progress line");
  await page.click('[data-tab="wrapup"]');
  await page.waitForFunction(() => document.querySelector('[data-na="signbook"]').checked, null, { timeout: 20000 });
  check(true, "…and it survives leaving the tab");
  await page.uncheck('[data-na="signbook"]');
  await page.waitForFunction(() => /還要做/.test(document.getElementById("flash").textContent));

  // ── 後續分頁的動作二：拍名片 → AI 讀 → 確認後併進這場的名單（拍名片是現場的事，跟簽名簿放一起）──
  await page.click('[data-tab="wrapup"]');
  // 已經轉好、存過的口述要載回來：以前重新整理就一片空白，看起來像東西掉了
  await page.waitForFunction(() => document.getElementById("transcript").value.length > 0, null, { timeout: 20000 });
  check((await page.inputValue("#transcript")).includes("校長") && (await page.inputValue("#dRooms")) === "303", "the dictation already saved for this visit is shown again, not blank");
  check((await page.locator('#tab-data #cardFiles').count()) === 0 && (await page.locator('#tab-wrapup #cardFiles').count()) === 1, "photographing cards sits with the visit-day steps, not in the archive tab");
  await page.waitForFunction(() => document.getElementById("cardStatus").textContent.includes("名單目前"));
  const guestsBefore = Number(/名單目前 (\d+) 人/.exec(await page.textContent("#cardStatus"))[1]);
  await page.setInputFiles("#cardFiles", pngPath);
  await page.waitForSelector("#cardTable:not([hidden]) tbody tr", { timeout: 60000 });
  check((await page.locator("#cardTable tbody tr").count()) >= 1, "a photographed card is read into an editable row");
  await page.click("#cardSave");
  await page.waitForFunction(() => /加了 \d+ 人/.test(document.getElementById("cardSaveInfo").textContent));
  await page.waitForFunction((n) => new RegExp(`名單目前 ${n + 1} 人`).test(document.getElementById("cardStatus").textContent), guestsBefore);
  check((await page.locator("#cardList img").count()) === 1, "the card photo is kept with the visit and the person is on the guest list");

  // ── 資料分頁：訪客來自哪裡（世界地圖）──
  // 一個單位一個點，落在那個學校或公司所在的地方（明確指示：「點要能縮小到學校或公司，不要佔了整個國家」）。
  // 位置是打開這一頁時自己去查的（AI_MOCK 把西澳大學放在伯斯），查好地圖自己更新
  await page.click('[data-tab="data"]');
  await page.waitForFunction(() => document.querySelectorAll("#worldMap [data-cluster]").length > 0, null, { timeout: 30000 });
  check(/1 個國家 · 1 個單位/.test(await page.textContent("#mapSummary")), `the data tab maps where visitors came from, one dot per institution (${await page.textContent("#mapSummary")})`);
  check((await page.textContent("#mapNote")) === "", "…with nothing quietly dropped for want of a country name");
  await page.waitForFunction(() => /伯斯/.test(document.querySelector("#worldMap [data-cluster]")?.getAttribute("aria-label") || ""), null, { timeout: 30000 });
  const perth = await page.evaluate(() => { const c = document.querySelector("#worldMap circle.dot"); return { x: Number(c.getAttribute("cx")), y: Number(c.getAttribute("cy")) }; });
  check(Math.abs(perth.x - (115.82 + 180) * 2) < 0.5 && Math.abs(perth.y - (90 + 31.98) * 2) < 0.5, `…and the institution's dot sits on its city (Perth), not on the middle of the country (${perth.x.toFixed(1)}, ${perth.y.toFixed(1)})`);
  check(/^University of Western…?$/.test((await page.textContent("#worldMap text.lbl")).trim()), `…labelled with the institution's name, cut between words when too long (${await page.textContent("#worldMap text.lbl")})`);
  await page.click("#worldMap [data-cluster] circle.hit");
  await page.waitForFunction(() => document.querySelectorAll("#mapVisits [data-visit]").length === 1);
  check(/伯斯/.test(await page.textContent("#mapVisits")), "clicking the dot lists that institution's visits and where it is");
  await page.click('#mapVisits [data-visit="2026-10-07-uwa"]');
  await page.waitForFunction(() => !document.getElementById("visitDetail").hidden && /Western Australia/.test(document.getElementById("detailTitle").textContent));
  check(true, "…and each one opens that visit's record");

  // 放大縮小：＋ 放大一倍、全圖回到整張世界地圖；放大之後換細的海岸線
  const viewW = () => page.evaluate(() => Number(document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ")[2]));
  check((await page.isDisabled("#mapReset")) && (await viewW()) === 720, "the map starts on the whole world");
  await page.click("#mapIn");
  await page.click("#mapIn");
  await page.waitForFunction(() => Number(document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ")[2]) === 180);
  check(true, "＋ zooms in");
  await page.waitForFunction(() => (document.querySelector("#worldMap .wm-land-detail").getAttribute("d") || "").length > 100000 && document.querySelector("#worldMap .wm-land-detail").getAttribute("display") === "inline", null, { timeout: 30000 });
  check((await page.getAttribute("#worldMap .wm-land:not(.wm-land-detail)", "display")) === "none", "…and once zoomed in, the finer coastline takes over");
  const viewBox = () => page.evaluate(() => document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ").map(Number));
  const mapBox = await page.locator("#worldMap svg").boundingBox();
  const beforeDrag = await viewBox();
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + mapBox.width / 2 + 120, mapBox.y + mapBox.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await viewBox();
  check(afterDrag[0] < beforeDrag[0] && afterDrag[2] === beforeDrag[2], `once zoomed in, dragging moves the map (x ${beforeDrag[0].toFixed(1)} → ${afterDrag[0].toFixed(1)})`);
  await page.keyboard.down("Control"); // 觸控板雙指撐開，瀏覽器送的就是 ctrl＋滾輪
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForFunction((w) => Number(document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ")[2]) < w, afterDrag[2]);
  check(true, "…and a trackpad pinch zooms further in");
  await page.click("#mapReset");
  await page.waitForFunction(() => Number(document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ")[2]) === 720);
  check((await page.getAttribute("#worldMap .wm-land:not(.wm-land-detail)", "display")) === "inline", "全圖 goes back to the whole world");
  // 還在整張世界地圖時，一般滾輪是捲頁面，不會被地圖吃掉
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForFunction((y) => window.scrollY > y, scrolled, { timeout: 5000 }).catch(() => {});
  check((await viewW()) === 720 && (await page.evaluate(() => window.scrollY)) > scrolled, "on the whole-world map, the scroll wheel scrolls the page instead of zooming");

  // 靠得太近的點合成一顆帶數字的：點下去放大；同一個城市、放到最大還是疊在一起的，點下去就列出那幾個單位
  {
    const auth = { authorization: "Bearer e2e-token", "content-type": "application/json" };
    const mk = async (name, date, code) => (await (await fetch(`${base}/api/visits`, { method: "POST", headers: auth, body: JSON.stringify({ org: { name, country: "Taiwan", type: "university" }, date, code, start_time: "10:00", end_time: "11:30" }) })).json()).visit.visit_id;
    const ids = [await mk("National Taiwan University", "2025-03-01", "ntu"), await mk("惇陽工程顧問有限公司", "2025-04-01", "dunyang")];
    await page.click('[data-tab="pre"]');
    await page.click('[data-tab="data"]');
    const twGroup = () => page.evaluate(() => [...document.querySelectorAll("#worldMap [data-cluster]")].findIndex((g) => /National Taiwan University/.test(g.getAttribute("aria-label")) && /惇陽/.test(g.getAttribute("aria-label"))));
    // 等位置查好（AI_MOCK 兩個都在臺北）：查好之前兩個都放在臺灣的國家位置，那時候點下去是直接列出來，不是放大
    const taipeiX = (121.54 + 180) * 2;
    await page.waitForFunction((x) => [...document.querySelectorAll("#worldMap [data-cluster]")].some((g) => /National Taiwan University/.test(g.getAttribute("aria-label")) && /惇陽/.test(g.getAttribute("aria-label")) && g.querySelector("text.count")?.textContent === "2" && Math.abs(Number(g.querySelector("circle.dot").getAttribute("cx")) - x) < 0.1), taipeiX, { timeout: 60000 });
    check(true, "two institutions in the same city show as one dot with a 2 on the whole-world map, sitting on that city");
    await page.click(`#worldMap [data-cluster="${await twGroup()}"] circle.hit`);
    await page.waitForFunction(() => Number(document.querySelector("#worldMap svg").getAttribute("viewBox").split(" ")[2]) < 100);
    check(!/National Taiwan University/.test(await page.textContent("#mapVisits")), "clicking the numbered dot zooms in to it (instead of listing them right away)");
    await page.click(`#worldMap [data-cluster="${await twGroup()}"] circle.hit`);
    await page.waitForFunction(() => document.querySelectorAll("#mapVisits [data-place]").length === 2);
    check(/National Taiwan University/.test(await page.textContent("#mapVisits")) && /惇陽工程顧問有限公司/.test(await page.textContent("#mapVisits")), "…and when they are still on top of each other, clicking again lists both institutions");
    await page.click("#mapReset");
    for (const id of ids) await fetch(`${base}/api/visits?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth });
    await page.click('[data-tab="pre"]');
    await page.click('[data-tab="data"]');
    await page.waitForFunction(() => /1 個單位/.test(document.getElementById("mapSummary").textContent), null, { timeout: 30000 });
  }

  // 圓點是「螢幕上幾個像素」，不是地圖座標：地圖畫得越大，點在地圖上越小，
  // 不然把地圖拉大之後整個韓國還是被一個點蓋住
  const dot = () => page.evaluate(() => {
    const c = document.querySelector("#worldMap circle.dot");
    const svg = document.querySelector("#worldMap svg");
    const [, , w] = svg.getAttribute("viewBox").split(" ").map(Number);
    const r = Number(c.getAttribute("r"));
    return { r, px: (r * svg.getBoundingClientRect().width) / w };
  });
  const narrow = await dot();
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForFunction((r) => Number(document.querySelector("#worldMap circle.dot").getAttribute("r")) < r, narrow.r, { timeout: 15000 });
  const wide = await dot();
  check(wide.r < narrow.r && Math.abs(wide.px - narrow.px) < 1, `dots shrink on the map as the map grows, staying the same size on screen (${narrow.px.toFixed(1)}px → ${wide.px.toFixed(1)}px)`);
  await page.setViewportSize({ width: 1100, height: 900 });

  // 一次性設定都收在「設定」分頁
  await page.click('[data-tab="settings"]');
  await page.waitForFunction(() => document.querySelectorAll("#statusList li").length > 0, null, { timeout: 30000 });
  check((await page.locator("#statusList li").count()) >= 6, "the settings tab says which external services are wired up");
  check(/後續提醒/.test(await page.textContent("#statusList")), "…including whether the wrap-up reminder can be sent");
  check(/不會寄|現在寄到/.test(await page.textContent("#reminderInfo")), "the settings tab says where the wrap-up reminder would go");
  await page.fill("#reminderTo", "wrapup@ntu.edu.tw");
  await page.locator("#senderDefault").focus(); // blur → change
  await page.waitForFunction(() => /已存/.test(document.getElementById("reminderInfo").textContent), null, { timeout: 15000 });
  check(true, "…and the address saves itself like every other setting");
  check(!(await page.textContent("#statusList")).includes("e2e-signal"), "…without ever showing the keys themselves");
  check(await page.isVisible("#masterRow"), "the master deck lives in settings now, not at the bottom of the deck tab");

  // 建錯的那一場：直接刪掉（不必先想「要不要存」）
  await page.click('[data-tab="pre"]');
  await page.selectOption("#visitSelect", "");
  await page.waitForFunction(() => document.getElementById("preStatus").textContent === "" && document.getElementById("orgName").value === ""); // 表單真的空了才打字
  const beforeDelete = await page.locator("#visitSelect option").count();
  await page.fill("#orgName", "Typo Institute");
  await page.waitForFunction((n) => document.querySelectorAll("#visitSelect option").length === n + 1, beforeDelete, { timeout: 30000 });
  check(true, "typing an organisation name is enough to create the visit");
  await page.fill("#date", "2026-08-01"); // 一場已經過去的參訪（網址還沒用出去，日期改了就換一個 visit_id）
  await page.waitForFunction(() => /^2026-08-01/.test(document.getElementById("preStatus").textContent), null, { timeout: 30000 });
  const typoId = await page.inputValue("#visitSelect");

  // 「以前做過的參訪」：列在訪前分頁底下，點一列就把全站的「這一場」切過去
  await page.waitForFunction(() => document.querySelectorAll('#pastVisits [data-past]').length > 0);
  check((await page.locator('#pastVisits [data-past="2026-10-07-uwa"]').count()) === 1, "past visits are listed at the bottom of the pre-visit tab");
  check(/選了 \d+ 頁/.test(await page.textContent("#pastVisits")), "…saying what that visit picked, so the next deck has something to go on");
  check(/同類/.test(await page.textContent("#pastVisits")), "…and marking the ones of the same organisation type");
  // 等的是「畫面真的換過去了」（#preStatus 由 fillForm 寫），不是下拉的值——切換是非同步的
  await page.click('#pastVisits [data-past="2026-10-07-uwa"]');
  await page.waitForFunction(() => document.getElementById("preStatus").textContent === "2026-10-07-uwa", null, { timeout: 30000 });
  check((await page.inputValue("#visitSelect")) === "2026-10-07-uwa", "clicking one pulls it up as the current visit");

  // 跑得久的 AI 做完時，人可能已經切去看別場了——那一份結果不屬於畫面上這一場，要丟掉。
  // （實際發生過：西澳大學那一場上面掛著另一個單位的背景研判，而且 saveVisit() 直接存了進去。）
  {
    await page.click("#researchBtn");
    await page.waitForFunction(() => /查資料中/.test(document.getElementById("background").textContent));
    // selectVisit.seq 是在 change 當下就加一的，所以這裡只要「按得到」就夠，不必等載入跑完
    await page.selectOption("#visitSelect", typoId);
    await page.waitForFunction(() => /換了一場/.test(document.getElementById("flash").textContent), null, { timeout: 60000 });
    check(true, "a background lookup that finishes after you switch visits says so instead of landing on the wrong one");
    await page.waitForFunction((id) => document.getElementById("preStatus").textContent === id, typoId, { timeout: 30000 });
    check((await page.locator("#background li").count()) === 0, "…and the visit you switched to is not left showing someone else's research");
    const moved = await (await fetch(`${base}/api/visits?id=${encodeURIComponent(typoId)}`, { headers: { authorization: "Bearer e2e-token" } })).json();
    check(!moved.visit?.background?.org_profile, "…and nothing was written to it on the server either");
    await page.click(`#pastVisits [data-past="2026-10-07-uwa"]`);
    await page.waitForFunction(() => document.getElementById("preStatus").textContent === "2026-10-07-uwa", null, { timeout: 30000 });
  }

  // 一打開後台不該看到上一次那一場的資料：停在今天或接下來最近的一場，過去的不自己跳出來
  await page.reload();
  await page.waitForFunction(() => document.getElementById("preStatus").textContent === "2026-10-07-uwa", null, { timeout: 30000 });
  check(true, "opening the admin lands on the next visit, not on the one that already happened");
  await page.click(`#pastVisits [data-past="${typoId}"]`); // 過去那一場要自己點才會出現
  await page.waitForFunction((id) => document.getElementById("preStatus").textContent === id, typoId, { timeout: 30000 });
  page.once("dialog", (d) => d.accept());
  await page.click("#deleteBtn");
  await page.waitForFunction((n) => document.querySelectorAll("#visitSelect option").length === n, beforeDelete, { timeout: 30000 });
  check(await page.isHidden("#afterSave"), "and deleting it clears the form");

  // ── 支援人力表：各研究室自己填「那一場誰接待、共需幾分鐘」──
  {
    const auth = { authorization: "Bearer e2e-token" };
    const visitOf = async (id) => (await (await fetch(`${base}/api/visits?id=${encodeURIComponent(id)}`, { headers: auth })).json()).visit;
    const until = async (fn, what) => {
      for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 300)); }
      throw new Error(`FAIL: timed out waiting for ${what}`);
    };
    // 連結**自動產生**：打開設定就有，不必先按什麼
    const key = (await (await fetch(`${base}/api/settings`, { headers: auth })).json()).settings.rota_key;
    check(/^[a-z0-9]{24}$/.test(key), "the rota link exists without anyone having to make it");
    const rota = await (await fetch(`${base}/api/rota?key=${key}`)).json();
    const target = rota.visits.find((v) => !v.past && v.stops.length);
    const id = target.visit_id;
    const room = target.stops[0].room;

    // 後台另一個分頁先開著這一場——手上的資料是老師填之前的樣子（等一下在這裡改一個字觸發自動存檔）
    const hostCtx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await hostCtx.addCookies(await page.context().cookies()); // 同一個登入（另一台機器上開著的後台也一樣）
    const host = await hostCtx.newPage();
    await host.goto(`${base}/admin.html`);
    await host.waitForSelector("#authOk:not([hidden])");
    await host.selectOption("#visitSelect", id);
    await host.waitForFunction((v) => document.getElementById("preStatus").textContent === v, id, { timeout: 30000 });

    await page.goto(`${base}/rota?key=${key}`);
    await page.waitForFunction(() => document.querySelectorAll("#rows section").length > 0, null, { timeout: 30000 });
    // 簡單明瞭（明確指示）：每一間只有兩格——接待人員、共需幾分鐘；不再問「方便的時段」
    const row = page.locator(`#rows section[data-rota-visit="${id}"]`);
    check((await row.locator(".rota-cell").first().locator("input").count()) === 2 && (await page.locator('[data-field="hours"]').count()) === 0, "each lab fills in just two things: who will host, and how many minutes");
    check(/接待人員/.test(await page.textContent("header")) && /共需幾分鐘/.test(await page.textContent("header")), "…and the one line on top says exactly that");
    await row.locator(`input[data-room="${room}"][data-field="name"]`).fill("王小明");
    await row.locator(`input[data-room="${room}"][data-field="minutes"]`).fill("２５分");
    check((await row.locator(`input[data-room="${room}"][data-field="minutes"]`).inputValue()) === "25", "typing 「２５分」 leaves just the number");
    await until(async () => { const v = await visitOf(id); return v.presenters?.[room] === "王小明" && v.lab_minutes?.[room] === 25; }, "the rota to save the name and the minutes");
    check(true, "…and what a lab types is kept on that visit, the name and the minutes");
    {
      // **別台電腦剛填的，回到這個視窗就看得到**：另一台（這裡用 API 代替）在同一場填了另一間，
      // 這一頁不必重新整理——視窗重新拿到焦點時自己重讀。資料本來就只有一份，存在站台上
      const other = target.stops.map((s) => s.room).find((r) => r !== room) || room;
      const r = await fetch(`${base}/api/rota?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: id, room: other, name: "另一台電腦" }) });
      check(r.ok, "another computer saves a cell on the same visit");
      // 游標還停在剛剛填的那一格（老師常常這樣切去 LINE 再切回來）：照樣更新，游標放回那一格
      await row.locator(`input[data-room="${room}"][data-field="name"]`).focus();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(([vid, rm]) => document.querySelector(`input[data-visit="${vid}"][data-room="${rm}"][data-field="name"]`)?.value === "另一台電腦", [id, other], { timeout: 15000 });
      check((await row.locator(`input[data-room="${room}"][data-field="name"]`).inputValue()) === "王小明", "…and coming back to this window shows it, next to what was typed here — no reload needed");
      check(await page.evaluate(([vid, rm]) => { const a = document.activeElement; return a?.dataset.visit === vid && a?.dataset.room === rm && a?.dataset.field === "name"; }, [id, room]), "…with the cursor back in the cell it was in");
      if (other !== room) await fetch(`${base}/api/rota?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visit_id: id, room: other, name: "" }) });
    }

    // **後台開著舊資料改一個字自動存檔，不會蓋掉老師剛填的**（後台是把手上那一份整個送回去的）
    const before = (await visitOf(id)).updated_at;
    await host.focus("#purpose");
    await host.keyboard.press("End");
    await host.keyboard.type(" ");
    await until(async () => (await visitOf(id)).updated_at !== before, "the admin tab to autosave");
    const again = await visitOf(id);
    check(again.presenters[room] === "王小明" && again.lab_minutes[room] === 25, "…and an autosave from an admin tab holding older data does not wipe it");
    // **研究室填的分鐘自動排進行程**（明確指示）：伺服器已經把 25 排進動線，後台那個舊分頁存完檔
    // 畫面就換成伺服器那一份——行程表上那一間是 25、標著「研究室填」
    const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    check((again.itinerary.find((s) => String(s.room) === room) || {}).minutes === 25, "the minutes a lab fills in go straight into the visit's route");
    const chip = `#itinerary input[data-room="${room}"]`;
    await host.waitForFunction((sel) => document.querySelector(sel)?.value === "25", chip, { timeout: 30000 });
    check((await host.locator(`#itinerary label:has(input[data-room="${room}"]) [data-from-lab]`).count()) === 1, "…and show up in the schedule on the admin page, marked as filled in by the lab");
    // 通告接在訪客背景研判之後、行程之前；卡片裡不再有另一份「各室的接待人員與共需幾分鐘」
    check(await host.evaluate(() => {
      const [bg, notice, table] = ["background", "noticeCard", "programmeTable"].map((x) => document.getElementById(x));
      const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return after(bg, notice) && after(notice, table);
    }), "the notice card comes right after the background check, before the schedule");
    check((await host.textContent("#noticeCard .num")).trim() === "4" && (await host.locator("#presenters").count()) === 0, "…as step 4, without its own list of hosts and minutes");
    await hostCtx.close();

    // 來賓專頁的參訪流程也是這一份：研究室參訪底下一間一行，那一間的時段就是研究室填的分鐘
    await page.goto(`${base}/${encodeURIComponent(id)}`);
    await page.waitForSelector(`[data-lab-slot="${room}"]`, { timeout: 30000 });
    const slot = (await page.textContent(`[data-lab-slot="${room}"]`)).match(/(\d\d:\d\d)–(\d\d:\d\d)/);
    check(!!slot && toMin(slot[2]) - toMin(slot[1]) === 25, `the guest page lists that lab's own time slot, as long as the lab said it needs (got ${slot && slot[0]})`);

    // 通告裡的連結帶著 #<visit_id>：點進來直接跳到那一場、那一張亮起來
    await page.goto(`${base}/rota?key=${key}#${encodeURIComponent(id)}`);
    await page.waitForFunction((v) => document.querySelector(`[data-rota-visit="${v}"]`)?.classList.contains("rota-focus"), id, { timeout: 30000 });
    check(true, "the link in the notice lands on that visit and lights it up");

    // 連結不對就打不開。要用乾淨的 context 測——這個分頁有後台的 session cookie，
    // admin 本來就一直開得了（那是刻意的），用它測等於沒測。
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    await gp.goto(`${base}/rota?key=nope`);
    await gp.waitForFunction(() => document.getElementById("status").textContent.length > 0, null, { timeout: 30000 });
    check(/連結/.test(await gp.textContent("#status")) && (await gp.locator("#rows section").count()) === 0, "a wrong link says so instead of showing the visits");
    await guest.close();

    // 後台「設定」分頁：**一張總表**——一場一列、一間一欄，還沒填的寫「未填」（明確指示：
    // 要更簡單，還沒填的也要顯示出來才知道有填沒填）。不用再複製連結，也改得了
    const json = { ...auth, "content-type": "application/json" };
    const make = async (body) => (await (await fetch(`${base}/api/visits`, { method: "POST", headers: json, body: JSON.stringify(body) })).json()).visit.visit_id;
    const bare = await make({ org: { name: "Unplanned Rota University" }, date: "2099-10-09", code: "unplanned", start_time: "10:00", end_time: "12:00" });
    const only301 = await make({ org: { name: "Only 301 University" }, date: "2099-10-10", code: "only301", start_time: "10:00", end_time: "11:30", programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "10:40" }, { kind: "discussion", start: "10:40", end: "11:30" }], itinerary: [{ room: "briefing", minutes: 20 }, { room: "301", minutes: 20 }] });
    await page.goto(`${base}/admin.html`);
    await page.waitForSelector("#authOk:not([hidden])");
    await page.click('[data-tab="settings"]');
    await page.waitForFunction((v) => !!document.querySelector(`#rotaTable tr[data-rota-visit="${v}"]`), bare, { timeout: 30000 });
    check((await page.locator("#rotaLink, #rotaCopy").count()) === 0, "the settings tab shows the table itself, with no link to copy");
    check((await page.locator("#rotaCard details:not([open]) #rotaNew").count()) === 1, "…and making a new link (if one gets out) is folded away under the table");
    check((await page.locator("#labEmails, #videoLinks").count()) === 0, "the lab email and video link cards are gone from settings");
    check((await page.locator("#rotaTable .rota-table").first().locator("thead th").count()) === 6, "one row per visit, one column per lab");
    const bareRow = page.locator(`#rotaTable tr[data-rota-visit="${bare}"]`);
    check((await bareRow.locator("td.rota-todo").count()) === 5 && (await bareRow.locator('input[data-field="name"]').first().getAttribute("placeholder")) === "未填", "a visit whose route is not planned yet lists all five labs, each marked 未填 until someone answers");
    const oneRow = page.locator(`#rotaTable tr[data-rota-visit="${only301}"]`);
    check((await oneRow.locator("td.rota-todo").count()) === 1 && (await oneRow.locator("td.rota-na").count()) === 4 && (await oneRow.locator("td.rota-na").first().textContent()).trim() === "免填", "once the route is planned, the labs it skips say 免填");
    // 星期幾照日期算（明確回報：11/2 是週一，表上寫成週日——以前每一天都早一天）
    check((await oneRow.locator("th").textContent()).includes("10/10（六）"), `the table shows the right weekday (2099-10-10 is a Saturday): ${(await oneRow.locator("th").textContent()).trim()}`);
    const mine = page.locator(`#rotaTable tr[data-rota-visit="${id}"] input[data-room="${room}"][data-field="name"]`);
    check((await mine.inputValue()) === "王小明" && !(await mine.evaluate((el) => el.closest("td").classList.contains("rota-todo"))), "what a lab filled in shows in its cell, not marked 未填");
    await mine.fill("李大華（群組裡回的）");
    await until(async () => (await visitOf(id)).presenters?.[room] === "李大華（群組裡回的）", "the settings table to save");
    check((await visitOf(id)).lab_minutes[room] === 25, "…and the host can correct it there, one cell at a time");
    const firstBare = bareRow.locator('input[data-field="name"]').first();
    await firstBare.fill("陳小華");
    check(!(await firstBare.evaluate((el) => el.closest("td").classList.contains("rota-todo"))), "typing a name into a 未填 cell clears the mark");
    await until(async () => Object.values((await visitOf(bare)).presenters || {}).includes("陳小華"), "the new name to save");
    const pastLocked = await page.locator("#rotaTable .rota-past input").count();
    check(pastLocked === 0, "…while visits that are over are folded away at the bottom, shown but not editable");
    for (const v of [bare, only301]) await fetch(`${base}/api/visits?id=${encodeURIComponent(v)}`, { method: "DELETE", headers: auth });
  }

  // ── 通告卡片：換一場之後，不能拿上一場的收件人來畫 ──
  // （實際發生過：西澳大學那一場的卡片上列著惇陽工程那一場的 301／304／303 與時段）
  {
    const auth = { authorization: "Bearer e2e-token", "content-type": "application/json" };
    const mk = async (code, date, room) => (await (await fetch(`${base}/api/visits`, { method: "POST", headers: auth, body: JSON.stringify({ org: { name: `Notice ${code}` }, date, code, start_time: "10:00", end_time: "11:30", programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "11:00" }, { kind: "discussion", start: "11:00", end: "11:30" }], itinerary: [{ room: "briefing", minutes: 20 }, { room, minutes: 20 }] }) })).json()).visit.visit_id;
    const a = await mk("noticea", "2099-11-01", "301"); // 301 沒有信箱
    const b = await mk("noticeb", "2099-11-02", "305"); // 305 有（老師自己 CV 上印的那一個）
    await page.goto(`${base}/admin.html`);
    await page.waitForSelector("#authOk:not([hidden])");
    await page.click('[data-tab="pre"]');
    // 等到收件人是「那一場自己的」（最多 15 秒），再看最後停在什麼
    const recipientsFor = async (id, has305) => {
      await page.selectOption("#visitSelect", id);
      await page.waitForFunction((v) => document.getElementById("preStatus").textContent === v, id, { timeout: 30000 });
      await page.waitForFunction((want) => /305/.test(document.getElementById("noticeRecipients").textContent) === want && /沒有信箱|305/.test(document.getElementById("noticeRecipients").textContent), has305, { timeout: 15000 }).catch(() => {});
      return (await page.textContent("#noticeRecipients")).trim();
    };
    const gotA = await recipientsFor(a, false);
    check(!/305/.test(gotA) && /沒有信箱/.test(gotA), `the notice card lists this visit's labs (got ${gotA || "nothing"})`);
    const gotB = await recipientsFor(b, true);
    check(/305/.test(gotB), `switching visits redraws the notice card with that visit's labs (got ${gotB || "nothing"})`);
    const backA = await recipientsFor(a, false);
    check(!/305/.test(backA), `…and switching back does not keep the previous visit's labs (got ${backA || "nothing"})`);
    for (const id of [a, b]) await fetch(`${base}/api/visits?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth });
  }

  // ── 中心首頁（/）：介紹中心，五間研究室各連到自己的介紹頁 ──
  // 首頁的世界地圖只標**已經來過**的單位：建一場過去的（只填了國家、還沒查位置——放在國家的位置）
  const pastVisit = await (await fetch(`${base}/api/visits`, { method: "POST", headers: { authorization: "Bearer e2e-token", "content-type": "application/json" }, body: JSON.stringify({ org: { name: "Konkuk University", name_local: "건국대학교", country: "South Korea" }, date: "2025-04-21", code: "konkuk", start_time: "10:00", end_time: "11:30" }) })).json();
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.querySelectorAll("#labs .lab-card").length === 5, null, { timeout: 15000 });
  check((await page.textContent("h1")) === "Green Health Research Center", "/ is the centre's homepage, not an empty visit page");
  const homeLinks = await page.$$eval("#labs .lab-card", (els) => els.map((a) => a.getAttribute("href")));
  check(homeLinks.join(" ") === "/lab/301 /lab/302 /lab/303 /lab/304 /lab/305", `…with the five laboratories, each linking to its own page (${homeLinks.join(" ")})`);
  check((await page.textContent("#lab-303")).includes("陳惠美") && !(await page.textContent("#lab-303")).includes("鄭佳昆") && (await page.textContent("#lab-305")).includes("IVR Research Lab"), "…303 lists only 陳惠美 and 305 is the IVR Research Lab");
  // 明確指示：「構成一條閉環證據鏈」那一段不要；五間研究室的卡片放在「組織架構」與「參訪與聯絡」之間
  check(await page.evaluate(() => {
    const ids = [...document.querySelectorAll("main > section:not([hidden])")].map((s) => s.id);
    return !document.getElementById("loop") && ids.indexOf("orgSec") + 1 === ids.indexOf("labsSec") && ids.indexOf("labsSec") + 1 === ids.indexOf("contactSec");
  }), "…no evidence-loop block, and the five laboratory cards sit between the organisation and the contact section");
  check((await page.textContent("#labsTitle")) === "The five laboratories", "…under a plain heading");
  check(!/Cornell/.test(await page.textContent("#members")) && (await page.locator("#members li").count()) === 7, "…and the international platform does not list Cornell");
  // 來訪單位：跟後台「資料」分頁同一張世界地圖（明確要求），只標已經來過的
  await page.waitForSelector("#visitorsSec:not([hidden]) #visitorMap [data-cluster]", { timeout: 15000 });
  const visitorLabels = await page.$$eval("#visitorMap [data-cluster]", (els) => els.map((g) => g.getAttribute("aria-label")));
  check(visitorLabels.some((l) => /Konkuk University/.test(l)) && !visitorLabels.some((l) => /Western Australia/.test(l)), `the homepage marks the institutions that have visited on the world map, not the ones still to come (${visitorLabels.join(" | ")})`);
  await page.click("#visitorMap [data-cluster] circle.hit");
  await page.waitForFunction(() => document.querySelectorAll("#visitorPick [data-place]").length === 1);
  check(/South Korea · 1 visit/.test(await page.textContent("#visitorPick")) && !/2025-04-21/.test(await page.textContent("#visitorsSec")), "…tapping a dot says who it is, where, and how many times — no dates");
  await fetch(`${base}/api/visits?id=${encodeURIComponent(pastVisit.visit.visit_id)}`, { method: "DELETE", headers: { authorization: "Bearer e2e-token" } });
  check(!/301\s*[-–]\s*304|four lab/i.test(await page.textContent("main")), "…and nowhere says four laboratories or 301–304");
  await page.click("#langToggle");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "綠色健康研究中心" && document.querySelectorAll("#labs .lab-card").length === 5, null, { timeout: 15000 });
  check((await page.getAttribute("#lab-303", "href")) === "/lab/303?ui=zh", "the Chinese homepage sends you to the Chinese lab page");
  await page.click("#lab-303");
  await page.waitForFunction(() => document.getElementById("labName")?.textContent === "景觀環境模擬室", null, { timeout: 15000 });
  check((await page.getAttribute("#homeLink", "href")) === "/?ui=zh" && (await page.textContent("#homeLink")).includes("綠色健康研究中心"), "…and the lab page links back to the homepage in the same language");
  await page.click("#homeLink");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "綠色健康研究中心", null, { timeout: 15000 });
  // 換回英文：這台裝置記得選了哪一個語言，後面的介紹頁測試要的是英文
  await page.click("#langToggle");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Green Health Research Center", null, { timeout: 15000 });

  // ── 來賓端：沒有參訪代碼（/index.html、打錯的網址）一律從訪前開始 ──
  await page.goto(`${base}/index.html`);
  await page.waitForSelector("#lab-303");
  check((await page.textContent("#labsTitle")) === "The five laboratories" && (await page.isHidden("#respond")) && (await page.isHidden("#emailSec")), "guest page without a visit starts in the pre-visit state and does not claim a visit is happening today");
  check(!(await page.textContent("#labsTitle2")).includes("今天"), "…and the Chinese heading does not say 今天 either");
  check((await page.getAttribute("#aboutCenter", "href")) === "/", "…and links to the centre's homepage");

  // ── 來賓端（日期在未來 → 訪前措辭） ──
  await page.goto(`${base}/2026-10-07-uwa`);
  await page.waitForSelector("#lab-303");
  // 留信箱訪前就要在：專頁網址是寫在訪前的確認信裡寄出去的，對方點進來時參訪還沒發生
  check((await page.textContent("#labsTitle")).includes("will visit") && (await page.isHidden("#respond")) && (await page.isVisible("#emailSec")), "before the visit: future tense, no thank-you form, but the email box is already there");
  check((await page.textContent("#emailTitle")).includes("afterwards"), "…and it says the slides come after the visit, not “today's”");
  await page.goto(`${base}/2026-10-07-uwa#email`);
  await page.waitForSelector("#emailSec:not([hidden])");
  check(await page.isHidden("#respond"), "#email link opens the on-site email box on its own, even before the visit");
  check((await page.textContent("#lab-301")).includes("seven-workstation"), "301 describes a seven-workstation array");

  // 老師介紹頁：卡片點過去就是那一間的整頁介紹（內容在後台「設定」改，改完這裡立刻跟著變）
  await page.click('#lab-303 a[href^="/lab/"]');
  await page.waitForFunction(() => document.getElementById("labName")?.textContent?.length > 0, null, { timeout: 15000 });
  check((await page.textContent("#labName")) === "Landscape Simulation Lab", "the card links to that laboratory's own page");
  check((await page.textContent("#leadName")).includes("陳惠美"), "…with its lead");
  check((await page.locator("#others a").count()) === 4, "…and the other four labs to jump to");
  check(!(await page.isHidden("#draftNote")), "…and it admits the text is still a draft until the lead confirms it");
  {
    // 後台改一句 → 這一頁立刻不一樣（repo 那一份是底稿，改過的疊上去）
    const r = await fetch(`${base}/api/labs`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token" }, body: JSON.stringify({ room: "303", fields: { one_line_en: "Changed from the admin page.", confirmed: true } }) });
    check(r.ok, "the admin can edit a lab card without touching the repo");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("oneLine")?.textContent?.includes("Changed from the admin"), null, { timeout: 15000 });
    check(await page.isHidden("#draftNote"), "…and ticking “confirmed” drops the draft note");
    await fetch(`${base}/api/labs`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token" }, body: JSON.stringify({ room: "303", reset: true }) });
  }
  {
    // 老師簡報上的照片：302 有一整面照片牆，圖說是簡報上原本的標法
    await page.goto(`${base}/lab/302`);
    await page.waitForFunction(() => document.getElementById("labName")?.textContent?.length > 0, null, { timeout: 15000 });
    check((await page.getAttribute(".avatar", "src")) === "/assets/labs/302/lead.jpg", "the lead photo from the lab's own slides shows up instead of the initials");
    check((await page.locator("#photos figure").count()) === 6, "…and so do the six pictures from those slides");
    check((await page.textContent("#photos")).includes("Environment prediction"), "…with the captions the slides gave them");
    // 站台上真的有那幾個檔（路徑打錯的話這裡就會抓到；圖片是 lazy 的，不能只看 naturalWidth）
    await page.waitForFunction(() => document.querySelector(".avatar")?.naturalWidth > 0, null, { timeout: 15000 });
    const srcs = await page.$$eval("#photos img", (els) => els.map((e) => e.getAttribute("src")));
    const codes = await Promise.all(srcs.map(async (u) => (await fetch(base + u)).status));
    check(codes.every((c) => c === 200), `every one of them is actually served (${codes.join(",")})`);
    // 照片牆也走後台：加一張、給圖說、再拿掉
    const put = async (body) => (await fetch(`${base}/api/labs`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token" }, body: JSON.stringify(body) })).json();
    const dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const added = await put({ room: "302", photo: { data: dot, gallery: true } });
    const shots = added.labs.find((l) => l.room === "302").photos;
    check(shots.length === 7 && /^labs\/302\//.test(shots[6].src), "the admin can add a picture to that wall");
    const captioned = await put({ room: "302", fields: { photos: shots.map((x, i) => (i === 6 ? { ...x, caption_en: "Added from the admin page" } : x)) } });
    check(captioned.labs.find((l) => l.room === "302").photos[6].caption_en === "Added from the admin page", "…and caption it");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#photos figure").length === 7, null, { timeout: 15000 });
    check((await page.textContent("#photos")).includes("Added from the admin page"), "…and the introduction page shows it");
    const dropped = await put({ room: "302", fields: { photos: shots.slice(0, 6) } });
    check(dropped.labs.find((l) => l.room === "302").photos.length === 6, "…and take it off again");
    await fetch(`${base}/api/labs`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token" }, body: JSON.stringify({ room: "302", reset: true }) });
  }
  // 流程區塊的英文標題空白時，來賓專頁用 i18n 的 kind_* 補、不印中文那一行。以前這個情形是「AI 排行程」
  // 留下來的；那顆鍵拿掉之後今日流程照預設排（標題都有），所以這裡自己把第一段的英文標題清掉再看
  {
    const cur = (await (await fetch(`${base}/api/visits?id=2026-10-07-uwa`, { headers: { authorization: "Bearer e2e-token" } })).json()).visit;
    cur.programme[0] = { ...cur.programme[0], title_en: "" };
    await fetch(`${base}/api/visits`, { method: "POST", headers: { authorization: "Bearer e2e-token", "content-type": "application/json" }, body: JSON.stringify(cur) });
  }
  // 回到來賓專頁（上面跑過幾個 /lab/… 的分頁，所以直接指定網址，不靠上一頁）
  await page.goto(`${base}/2026-10-07-uwa#email`);
  await page.waitForSelector("#emailSec:not([hidden])");
  await page.waitForFunction(() => document.getElementById("labsTitle")?.textContent?.length > 0, null, { timeout: 15000 });
  check((await page.locator("#labs article").count()) === 6, "guest page shows the briefing step plus five lab cards");
  check((await page.locator("#labs img.avatar").count()) === 5, "all five leads have a photo now, so no card falls back to initials");
  check((await page.textContent("#labs article:first-child")).includes("Center overview"), "briefing card comes first");
  check((await page.textContent("#lab-303")).includes("陳惠美") && !(await page.textContent("#lab-303")).includes("鄭佳昆"), "303 lists only 陳惠美");
  check((await page.textContent("#lab-305")).includes("IVR Research Lab") && !(await page.textContent("#lab-305")).includes("outside"), "305 is the IVR Research Lab");
  check((await leftEdge("#lab-303")) === labColor["303"] && (await leftEdge("#lab-305")) === labColor["305"] && labColor["303"] !== labColor["305"], "every lab card wears its own colour: 303 and 305 are both 驗證 but two different rooms");
  check((await page.textContent("#briefing-card")).includes("302"), "guest page shows the briefing in 302");
  check((await page.textContent("#lab-303")).includes("Landscape Simulation Lab") && (await page.textContent("#lab-303")).includes("景觀環境模擬室"), "the lab NAME keeps both scripts (a name is an identifier, not a translation)");
  check(!/[一-鿿]/.test(await page.textContent("#lab-303 p")), "…but the prose on the English page is English only: 中英文不在同一頁印兩份");
  check((await page.textContent("#programme li:first-child")).includes("Center overview") && !(await page.textContent("#programme li:first-child")).includes("總體介紹"), "programme block falls back to the English label when its English title is empty, and does not print the Chinese one");
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

  // ── 來賓端：中文為主（右上角那顆鍵，或網址帶 ?ui=zh）──
  await page.goto(`${base}/2026-10-07-uwa?phase=today&ui=zh`);
  await page.waitForSelector("#lab-303");
  check((await page.textContent("#welcome")).includes("歡迎"), "?ui=zh makes the guest page a Chinese page");
  check(!(await page.textContent("#welcome")).includes("Welcome"), "…and the English is gone: the two languages are one switch, not two lines");
  check((await page.textContent("#programme li:first-child")).includes("總體介紹"), "the Chinese page gets the Chinese programme labels");
  check((await page.$eval("#langToggle .on", (e) => e.textContent)) === "中文", "the toggle shows which language is on, not just the other one");
  check((await page.textContent("#lab-301")).includes("健康景觀智能室") && (await page.textContent("#lab-301")).includes("Health Landscape Intelligence Lab"), "the lab name still carries both scripts on the Chinese page");
  await page.fill("#suggestion", "半路換語言");
  await page.click("#langToggle");
  await page.waitForFunction(() => document.querySelector("#langToggle .on")?.textContent === "EN");
  check((await page.textContent("#welcome")).includes("Welcome to"), "the toggle switches back to an English page");
  check((await page.inputValue("#suggestion")) === "半路換語言", "…and what the guest had already typed survives the switch");

  // ── 主辦端：整個介面切成英文 ──
  await page.goto(`${base}/admin.html`);
  await page.waitForSelector("#authOk:not([hidden])");
  await page.click("#langToggle");
  await page.waitForFunction(() => document.querySelector('[data-tab="pre"]')?.textContent === "Before", null, { timeout: 20000 });
  check((await page.textContent('[data-tab="wrapup"]')) === "Follow-up", "every tab is in English");
  check(/Check the visitor details/.test(await page.textContent("#tab-pre")), "…and so are the headings inside the tab");
  await page.click('[data-tab="deck"]');
  await page.waitForTimeout(500);
  check(/Slides to use/.test(await page.textContent("#tab-deck")), "the deck tab too");
  check(/Lab 301 Health Landscape Intelligence Lab/.test(await page.textContent("#slideGrid")), "the master deck's block names come from slides.json in English");
  const cjkLeft = await page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"].includes(n.parentNode?.nodeName)) continue;
      if (!n.parentElement?.offsetParent) continue;
      if (n.parentElement.closest("[data-ai-text]")) continue; // AI 寫的內容是資料，不是介面：不翻（AI 挑頁旁邊那一句為什麼）
      const t = n.nodeValue.trim();
      if (t && /[一-鿿]/.test(t) && !["中", "中文", "日本語"].includes(t)) out.push(t);
    }
    return out;
  });
  check(cjkLeft.length === 0, `nothing is left in Chinese on the English deck tab (${cjkLeft.slice(0, 3).join(" | ")})`);
  await page.click("#langToggle");
  await page.waitForFunction(() => document.querySelector('[data-tab="pre"]')?.textContent === "訪前", null, { timeout: 20000 });
  check(true, "and back to Chinese");

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
