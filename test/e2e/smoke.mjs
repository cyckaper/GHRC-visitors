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

  await page.click("#planBtn");
  // 排行程也跑在背景（提示詞帶整份頁次索引，10 秒同樣不夠）
  await page.waitForFunction(() => /排行程中/.test(document.getElementById("planInfo").textContent));
  check(true, "排行程 runs in the background too");
  // 排完的判斷要看 AI 回來了沒（表上本來就有一份預設流程，不能用「有沒有列」判斷）
  await page.waitForFunction(() => /也挑了/.test(document.getElementById("planInfo").textContent), null, { timeout: 90000 });
  check((await page.locator("#programmeTable tbody tr select").evaluateAll((els) => els.map((e) => e.options[e.selectedIndex].text))).includes("綜合討論"), "programme table shows a 綜合討論 block");
  check((await page.locator("#tab-pre #slideGrid").count()) === 0, "the pre-visit tab no longer carries the slide picker");
  // 行程只有一張表：每一間幾分鐘就長在「研究室參訪」那一列底下，總體介紹的地點在 briefing 那一列
  check((await page.locator("#programmeTable tr[data-rooms-row]").count()) === 1, "the lab minutes live inside the one schedule table");
  check((await page.inputValue("#programmeTable [data-briefing-location]")) === "302", "briefing room defaults to 302, on the briefing row itself");
  check((await page.locator("#itinerary input[data-room]").count()) === 5, "one minutes box per lab");
  check(/五間合計 \d+ 分/.test(await page.textContent("#roomsTotal")), "it adds the lab minutes up");
  {
    // 分鐘一改，後面各段的時間就跟著往後推——**時間是算出來的，不是第二個要填的欄位**
    const before = await page.inputValue("#programmeTable tbody tr:last-child input[type=time]");
    const box = page.locator('#itinerary input[data-room="301"]');
    await box.fill(String((Number(await box.inputValue()) || 0) + 30));
    await page.waitForFunction((was) => document.querySelector("#programmeTable tbody tr:last-child input[type=time]").value !== was, before, { timeout: 15000 });
    check(/流程排了 \d+ 分/.test(await page.textContent("#programmeTotal")), "and says how long the whole thing runs");
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
  check((await page.locator("#slideGrid input[data-block]:checked").count()) >= 2, "the plan's blocks are waiting in the deck tab");
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
  await page.click('[data-tab="data"]');
  await page.waitForFunction(() => document.querySelectorAll("#worldMap [data-country]").length > 0, null, { timeout: 30000 });
  check(/1 個國家/.test(await page.textContent("#mapSummary")), "the data tab maps which countries visitors came from");
  check((await page.textContent("#mapNote")) === "", "…with nothing quietly dropped for want of a country name");
  await page.click('#worldMap [data-country="Australia"]');
  await page.waitForFunction(() => document.querySelectorAll("#mapVisits [data-visit]").length === 1);
  check(true, "clicking a country lists that country's visits");
  await page.click('#mapVisits [data-visit="2026-10-07-uwa"]');
  await page.waitForFunction(() => !document.getElementById("visitDetail").hidden && /Western Australia/.test(document.getElementById("detailTitle").textContent));
  check(true, "…and each one opens that visit's record");

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

    // **後台開著舊資料改一個字自動存檔，不會蓋掉老師剛填的**（後台是把手上那一份整個送回去的）
    const before = (await visitOf(id)).updated_at;
    await host.focus("#purpose");
    await host.keyboard.press("End");
    await host.keyboard.type(" ");
    await until(async () => (await visitOf(id)).updated_at !== before, "the admin tab to autosave");
    const again = await visitOf(id);
    check(again.presenters[room] === "王小明" && again.lab_minutes[room] === 25, "…and an autosave from an admin tab holding older data does not wipe it");
    // 通告卡片那幾格：打字時不會被自動存檔重畫掉，離開格子才存
    const cell = `#presenters input[data-presenter="${room}"][data-field="minutes"]`;
    await host.waitForFunction((sel) => document.querySelector(sel)?.value === "25", cell, { timeout: 30000 });
    await host.fill(cell, "30");
    await host.waitForTimeout(2000); // 比自動存檔的 1.2 秒久
    check((await host.inputValue(cell)) === "30", "typing in the notice card is not wiped by an autosave redrawing it");
    await host.press(cell, "Tab");
    await until(async () => (await visitOf(id)).lab_minutes?.[room] === 30, "the notice card to save the minutes");
    check(true, "…and leaving the cell saves it to the same table");
    await hostCtx.close();

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

    // 後台「設定」分頁：**直接顯示那一張表**（明確指示：不用再複製連結），也改得了
    await page.goto(`${base}/admin.html`);
    await page.waitForSelector("#authOk:not([hidden])");
    await page.click('[data-tab="settings"]');
    await page.waitForFunction(() => document.querySelectorAll("#rotaTable section").length > 0, null, { timeout: 30000 });
    check((await page.locator("#rotaLink, #rotaCopy").count()) === 0, "the settings tab shows the table itself, with no link to copy");
    check((await page.locator("#rotaCard details:not([open]) #rotaNew").count()) === 1, "…and making a new link (if one gets out) is folded away under the table");
    check((await page.locator("#labEmails, #videoLinks").count()) === 0, "the lab email and video link cards are gone from settings");
    const mine = page.locator(`#rotaTable [data-rota-visit="${id}"] input[data-room="${room}"][data-field="name"]`);
    check((await mine.inputValue()) === "王小明", "the same table the leads fill in is right there in settings");
    await mine.fill("李大華（群組裡回的）");
    await until(async () => (await visitOf(id)).presenters?.[room] === "李大華（群組裡回的）", "the settings table to save");
    check((await visitOf(id)).lab_minutes[room] === 30, "…and the host can correct it there, one cell at a time");
    const pastLocked = await page.locator("#rotaTable section.rota-past input:not([disabled])").count();
    check(pastLocked === 0, "…while visits that are over stay locked there too");
  }

  // ── 通告卡片：換一場之後，不能拿上一場的房號與時段來畫 ──
  // （實際發生過：西澳大學那一場的卡片上列著惇陽工程那一場的 301／304／303 與時段）
  {
    const auth = { authorization: "Bearer e2e-token", "content-type": "application/json" };
    const mk = async (code, date, room) => (await (await fetch(`${base}/api/visits`, { method: "POST", headers: auth, body: JSON.stringify({ org: { name: `Presenters ${code}` }, date, code, start_time: "10:00", end_time: "11:30", programme: [{ kind: "briefing", start: "10:00", end: "10:20" }, { kind: "tour", start: "10:20", end: "11:00" }, { kind: "discussion", start: "11:00", end: "11:30" }], itinerary: [{ room: "briefing", minutes: 20 }, { room, minutes: 20 }] }) })).json()).visit.visit_id;
    const a = await mk("presa", "2099-11-01", "301");
    const b = await mk("presb", "2099-11-02", "305");
    await page.goto(`${base}/admin.html`);
    await page.waitForSelector("#authOk:not([hidden])");
    await page.click('[data-tab="pre"]');
    // 等到畫面上是「那一場自己的」房號（最多 15 秒），再看最後停在什麼
    const roomsFor = async (id, want) => {
      await page.selectOption("#visitSelect", id);
      await page.waitForFunction((v) => document.getElementById("preStatus").textContent === v, id, { timeout: 30000 });
      await page.waitForFunction((w) => [...document.querySelectorAll('#presenters [data-presenter][data-field="name"]')].map((e) => e.dataset.presenter).join() === w, want, { timeout: 15000 }).catch(() => {});
      return (await page.$$eval('#presenters [data-presenter][data-field="name"]', (els) => els.map((e) => e.dataset.presenter))).join();
    };
    const gotA = await roomsFor(a, "301");
    check(gotA === "301", `the notice card lists this visit's labs (got ${gotA || "nothing"})`);
    const gotB = await roomsFor(b, "305");
    check(gotB === "305", `switching visits redraws the notice card with that visit's labs, not the previous one's (got ${gotB || "nothing"})`);
    for (const id of [a, b]) await fetch(`${base}/api/visits?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth });
  }

  // ── 來賓端：首頁（沒有參訪代碼）一律從訪前開始 ──
  await page.goto(`${base}/`);
  await page.waitForSelector("#lab-303");
  check((await page.textContent("#labsTitle")) === "The five laboratories" && (await page.isHidden("#respond")) && (await page.isHidden("#emailSec")), "landing page without a visit starts in the pre-visit state and does not claim a visit is happening today");
  check(!(await page.textContent("#labsTitle2")).includes("今天"), "…and the Chinese heading does not say 今天 either");

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
  check((await page.textContent("#programme li:first-child")).includes("Center overview") && !(await page.textContent("#programme li:first-child")).includes("總體介紹"), "programme block falls back to the English label when the plan left title_en empty, and does not print the Chinese one");
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
