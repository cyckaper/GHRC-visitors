# 部署與設定

## 1. Netlify

1. Netlify → Add new project → Import from GitHub → `cyckaper/GHRC-visitors`。Build command 留空，Publish directory `public`（`netlify.toml` 已設定，Functions 在 `netlify/functions`）。
2. Domain：加上 `visit.healsdesign.org`（healsdesign.org 的 DNS 加一筆 CNAME 指到 Netlify 給的 `xxx.netlify.app`）。
3. Environment variables（Site configuration → Environment variables）：

| 變數 | 必要 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✔ | Claude API。讀信、排程、草擬信件、簽名簿讀字、口述抽取、摘要、翻譯 |
| `ADMIN_TOKEN` | ✔ | 主辦端登入用的長隨機字串（`openssl rand -hex 24`）。只給承辦與主持人 |
| `SITE_URL` | 建議 | `https://visit.healsdesign.org`；專屬網址與信裡的連結用它組 |
| `OPENAI_API_KEY` | 選 | Whisper，只用於主持人的三十秒口述；沒有就在後台打字輸入逐字稿 |
| `CLAUDE_MODEL` | 選 | 預設 `claude-opus-5` |
| `STORE_BACKEND` | 選 | `blobs`（預設，零設定）或 `sheets`（見 §2） |
| `GOOGLE_SHEET_ID`、`GOOGLE_SERVICE_ACCOUNT_JSON` | sheets 時必要 | 見 §2 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 選 | Google 的 OAuth 用戶端（§6.5）：Drive 備份、參訪名單的 Google 試算表、從後台寄信共用。**授權本身不放環境變數**：後台「設定」按「連上 Google」 |
| `GMAIL_SENDER` | 選 | 寄出的信上「寄件人」那一行（§3）；要跟連上 Google 的那個帳號一樣 |
| `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`、`GOOGLE_REFRESH_TOKEN` | 舊的 | 以前用 OAuth Playground 拿 refresh token 的設定方式，仍然認得；後台連上的那一份優先，**新站台不必設** |
| `DICTATION_LANGUAGE` | 選 | Whisper 的語言提示，預設 `zh` |
| `REMINDER_TO` | 選 | 後續提醒寄到哪個信箱（參訪結束時自動寄）。**通常不必設**：後台「設定」分頁可以直接填，都沒填就寄給 `GMAIL_SENDER` |

4. Deploy。部署後：`https://visit.healsdesign.org/admin.html` 用 `ADMIN_TOKEN` 登入。
   「訪前」的 **AI 查訪客背景** 會用 Claude 的伺服器端網路搜尋（每次查幾個網頁，另外計費）；帳號沒開網路搜尋也不會壞，只會退回「只讀來信」的研判並在畫面上標明。**一台裝置只要登入一次**：伺服器會發一個 HttpOnly cookie（180 天，每次打開後台自動續期），換手機或換瀏覽器才要再貼一次；按「登出」就清掉。

**資料在哪**：預設在 Netlify Blobs（store `ghrc-visit`：`visits/`、`responses/`、`slideperf/`、`media/`）。後台「資料」分頁可匯出三張表的 CSV。Deploy Preview 與分支部署用 deploy-scoped store，不會混進正式資料。

**排程（Netlify Scheduled Functions，`export const config = { schedule }`）**：`summary-cron`（台北一點：過完又有回饋的參訪自己產一頁摘要）、
`drive-cron`（兩點：備份補漏）、`reminder-cron`（台北 08:00–21:59 每十五分鐘：參訪結束時寄後續提醒）、
`visit-list-cron`（每十五分鐘：參訪名單的 Google 試算表有人加了列就讀進來）。
四支都只接受 Netlify 排程器送來的 `POST {next_run}`，或帶 `ADMIN_TOKEN` 的手動觸發；被擋下來時函式紀錄會寫明原因。

**金鑰安全**：所有金鑰只在 Netlify Functions 裡使用，前端只拿 `ADMIN_TOKEN`（登入後換成 HttpOnly cookie）。

## 2. Google Sheet 當資料庫（選用，工作包第 6 章）

1. Google Cloud Console → 建專案 → 啟用 **Google Sheets API** → IAM → 服務帳戶 → 建立金鑰（JSON）。
2. 建一份 Google Sheet，分享給服務帳戶的 email（編輯者）。網址裡 `/d/<這一段>/edit` 就是 `GOOGLE_SHEET_ID`。
3. Netlify 環境變數：`STORE_BACKEND=sheets`、`GOOGLE_SHEET_ID`、`GOOGLE_SERVICE_ACCOUNT_JSON`（整個 JSON 檔內容貼成一行）。
4. 第一次呼叫時系統會自動建立 `visits`、`responses`、`slide_performance` 三個工作表並寫入中文表頭。JSON 欄位（名單、議程…）以字串存在儲存格；`visits` 最後一欄是完整 JSON。
5. 照片與音檔仍存 Netlify Blobs（Sheet 只存 key）。

不具名的回覆：`姓名`、`email` 欄位一律空白，`填答時間` 只有日期。後端不會補回，請不要在 Sheet 上手動比對。

## 3. 訪後信一鍵寄出（Gmail API，選用）

寄信與 Drive 備份**共用一組 Google 授權**，設定一次就好——照 §6.5 的「連上 Google」做，同一個專案也啟用 **Gmail API**，
允許時「寄信」那一格要勾。另外在 Netlify 環境變數設 `GMAIL_SENDER`（寄件人那一行，填連上的那個帳號）。

寄出時每人一封（不是 BCC）。寄件帳號固定是授權的那一個；「寄件者」下拉只決定署名（中心主任或對口老師）。
以前的設定方式（OAuth Playground 拿 refresh token，填 `GMAIL_CLIENT_ID`／`GMAIL_CLIENT_SECRET`／`GMAIL_REFRESH_TOKEN`）仍然認得，
但**後台連上的那一份優先**；那一組是在同意畫面「測試」狀態拿的話，七天就失效（2026 年 9 月就是這樣停的）。

沒設定時，後台會明確顯示「尚未寄出」，並提供 mailto（BCC 全員）與複製信件。

**後續提醒**用的是同一組 Gmail 授權：參訪的結束時間一到（依今日流程），系統寄一封信到中心信箱，
列出簽名簿、名片、口述、當天資料還缺哪幾件，附一個直接打開後台「後續」分頁的連結。一場只寄一次，
四件事都做完了就不寄。收件信箱在後台「設定」分頁填（留空就用 `GMAIL_SENDER`）。


## 4. 現場硬體　⛔ 已移除

現場動線訊號（NFC 貼紙、研究室電腦的簡報捷徑、`SIGNAL_KEY`、`timeline` 表）在 2026-09-13 整套拿掉了
（明確指示：暫時都不用）。這一節留著只是為了讓後面的編號不變；要找回來翻 git（移除前的最後一版 `191ee60`）。

## 5. 後續提醒

後台儲存參訪後「下載後續提醒 .ics」→ 加進主持人的行事曆。預定結束時間鬧鈴，點開直達 `admin.html#wrapup=<visit_id>`。
（要改成推播的話：Netlify Scheduled Function 每 5 分鐘掃當天 visits 的結束時間，用 Web Push 送。v1 先用行事曆，零基礎設施。）

## 6. 母簡報：slim master

母簡報 396 MB 不能進 repo（GitHub 單檔 100 MB）。在本機：

```bash
pip install python-pptx Pillow
python3 scripts/slim-master.py "GHRC 介紹簡報2026-9.pptx" --out public/assets/master/slim-master.pptx \
    --video-link 19=<影片連結> --video-link 35=… --video-link 37=… --video-link 38=… --video-link 52=…
```

- 影片改成「海報影格 ＋ ▶ Video 連結」（影片放 Drive／YouTube 不公開）；超過 3 MB 或長邊超過 2000px 的圖縮到 2000px、轉 JPEG；清掉沒被引用的媒體；目標 < 30 MB（超過會提示 `--all-images`、`--max-edge 1600`）。
- 把 slim master 放上站台有兩種方式：**後台「上傳母簡報 .pptx」一次**（切成 4 MB 分塊存進 Netlify Blobs，`/api/master`，要 ADMIN_TOKEN，不公開；之後「產生簡報」直接抓），或 commit 到 `public/assets/master/slim-master.pptx`（Netlify 公開發佈，知道網址的人都能下載）。兩者都沒有時，按「產生簡報」會當場請你從電腦選檔，產完可一鍵存到站台。**可以直接選 396 MB 的原始母簡報**：當場選的那一份**原封不動拿去產檔**（影片留在產出的簡報裡，現場播得動），按「把這份母簡報存到站台」時才瘦身（抽影片留海報、大圖縮到 2000px，大約一兩分鐘）。原始母檔留在 Drive 當備份。

> **影片**：站台上的母簡報不含影片，用它產出來的簡報那幾頁只有海報影格。把影片放到 Drive 或 YouTube 不公開連結，網址填進後台「設定 → 影片連結」（第 19、35、37、38、52 頁），**再重新上傳一次母簡報**，海報那一頁就會有點得開的連結。現場要真的播影片，產簡報時當場選原始的母簡報。
- 產出後：`npm run deck -- --inspect` 看頁次是否與 `public/data/slides.json` 的索引一致（章節編號與實體頁序不一致是已知現象，索引以頁序為準）；`npm run deck -- --dump` 寫 `data/master-text.json` 並 commit，之後 `/api/plan` 就能產生第 1–3 頁（封面、流程、架構）逐字替換的 `text_edits`。

## 6.5 另存 Google Drive（長期檔案）

**設定好之後是全自動的**：每次存檔、後續那幾件事、放上當天資料、寄出訪後信、產一頁摘要，以及來賓送出回覆，
都會自動把那一場同步到中心 Drive 的 `GHRC 參訪/<日期> <單位>/`，裡面放參訪資料.json、回覆.csv、動線.csv、
一頁摘要.md、簽名簿照片、主持人口述音檔、當天簡報.pdf、現場合照。同名覆蓋，不會愈備份愈多份。
即時同步若因為網路或部署漏掉，每晚台北時間兩點的 `drive-cron` 會補上。後台「資料」分頁的「立即備份到 Drive」只是手動補救。

**連上 Google（只做一次；授權過期了再按一次）**——Drive 備份、參訪名單的 Google 試算表、從後台寄信共用這一組：

1. [Google Cloud Console](https://console.cloud.google.com/) 建一個專案 → 「API 和服務」→ 啟用 **Google Drive API** 與 **Gmail API**
2. 「OAuth 同意畫面」→ External → 填名稱與聯絡信箱 → **發布狀態設為「正式版」**。
   **測試模式的 refresh token 七天就失效**（2026 年 9 月就是這樣：Drive 備份默默停了兩週）。
   寄信的 `gmail.send` 屬於敏感範圍：不送審也能用，只是允許時 Google 會先說「這個應用程式未經 Google 驗證」，按「進階」→「前往…（不安全）」繼續——只有中心自己的帳號會用到
3. 「憑證」→ 建立 OAuth 用戶端 ID → **網頁應用程式** → 已授權的重新導向 URI 加上
   `https://visit.healsdesign.org/api/google-auth` → 用戶端 ID 與密鑰填進 Netlify 環境變數 `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET`，重新部署。
   已經有一個用戶端的（以前用 OAuth Playground 拿 token 的那一個）不必再建：在那一個加上這條重新導向 URI 就好。
   系統用的是 `GOOGLE_CLIENT_ID`，沒有才用 `GMAIL_CLIENT_ID`——重新導向 URI 要加在用的那一個上
4. 後台「設定」分頁 →「連上 Google」→ 選中心要用的那個 Google 帳號 → 「Drive」「寄信」兩格都勾 → 允許。
   回到後台會寫「已連上 xxx@gmail.com」。授權存在站台上（Blobs），不在環境變數裡，**之後不必再動 Netlify**

- **過期了**：每一頁上面會掛一條「Google 的授權過期了」，按「重新連上 Google」再允許一次就好。
- **Google 說 `redirect_uri_mismatch`**：第 3 步的重新導向 URI 沒加，或加在另一個用戶端上。
- **說「還沒啟用 Gmail API」（或 Drive API）**：第 1 步那個專案少啟用一支，啟用後過幾分鐘再試。

| 變數 | 說明 |
|---|---|
| `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET` | OAuth 用戶端；沒設就用 `GMAIL_CLIENT_ID`／`GMAIL_CLIENT_SECRET` |
| `GOOGLE_REFRESH_TOKEN` | 舊的設定方式（OAuth Playground 拿的），仍然認得；**後台連上的那一份優先**，新站台不必設 |
| `GOOGLE_DRIVE_FOLDER_ID` | **通常不要設**。不設時系統會在你的雲端硬碟自己建一個「GHRC 參訪」資料夾 |

**為什麼不要設 `GOOGLE_DRIVE_FOLDER_ID`**：`drive.file` 只讓程式看得到「它自己建立的檔案」，指定一個別人建的資料夾會存取不到。
真的要指定既有資料夾，refresh token 得改用全權限的 `https://www.googleapis.com/auth/drive`——那是受限範圍，發布前要送 Google 審查，不建議。

用中心自己的 Google 帳號授權，不要用服務帳戶——服務帳戶沒有 Drive 儲存配額，上傳會被拒。
**帳號選定後就不要換**：`drive.file` 只看得到自己建立的檔案，換一個帳號授權等於從空的開始，先前那個「GHRC 參訪」資料夾不會再被認出來。

## 7. 產出當次簡報

平常在後台「訪前」存好這一場，再到「簡報」分頁選頁、按 **產生簡報 .pptx**（不用簡報的場次勾「這場不用簡報，只口頭介紹」就好）：瀏覽器抓 slim master（後台上傳的、站台靜態檔、或當場選檔）、依選頁與流程子集化、韓／日文版呼叫 `/api/translate` 翻譯中文段落、直接下載 `GHRC_<visit_id>.pptx`。PDF 請用 PowerPoint 另存，再到「後續」放上專屬頁面。本機 CLI 是備援（多出 LibreOffice 轉 PDF）：

```bash
npm run deck -- --visit=2026-10-07-uwa          # 需要 data/visits/2026-10-07-uwa.json（/api/visits?id=… 的 visit 物件）與 public/assets/master/slim-master.pptx
npm run deck -- --spec=path/to.json --lang=ko    # 韓文版：中文段落翻成韓文（需 ANTHROPIC_API_KEY；翻譯快取在 data/translations/ko.json）
npm run deck -- --spec=path/to.json --no-pdf     # 不裝 LibreOffice 時
```

輸出 `dist/<visit_id>.pptx`、`.pdf`（有 LibreOffice 時）、`.txt`（全文，QA 用）、`.report.json`（取代了幾處、哪幾處沒找到、驗證結果）。
產檔規則：選頁依 spec；第 2 頁流程表若是表格會自動填（時間／英文／第二語言／頁碼）；`text_edits` 逐字取代；`language=en` 刪掉中文段落、`ko`／`ja` 翻譯並換東亞字型；最後加「您最想看哪一部分」頁（從組織架構頁複製，五位老師照片並列）與 QR 頁（從謝謝頁複製）。

## 8. 第一次試跑

- **Bill Sullivan（2026/9/15–22）**：時間太近，先手動試「後續」那幾件事——擺一本簽名簿、結束後用手機錄三十秒。後台「後續」分頁就能把這兩份素材存進系統（先在訪前建一筆參訪即可）。
- **Simon Kilbane（10 月初）**：完整跑一次。訪前貼信、確認名單 email、排行程、產簡報、寄確認信；後續五件事；訪後信寄全名單，看開放建議欄位收不收得到東西。
