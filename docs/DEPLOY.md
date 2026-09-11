# 部署與設定

## 1. Netlify

1. Netlify → Add new project → Import from GitHub → `cyckaper/GHRC-visitors`。Build command 留空，Publish directory `public`（`netlify.toml` 已設定，Functions 在 `netlify/functions`）。
2. Domain：加上 `visit.healsdesign.org`（healsdesign.org 的 DNS 加一筆 CNAME 指到 Netlify 給的 `xxx.netlify.app`）。
3. Environment variables（Site configuration → Environment variables）：

| 變數 | 必要 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✔ | Claude API。讀信、排程、草擬信件、簽名簿讀字、口述抽取、摘要、翻譯 |
| `ADMIN_TOKEN` | ✔ | 主辦端登入用的長隨機字串（`openssl rand -hex 24`）。只給承辦與主持人 |
| `SIGNAL_KEY` | ✔ | 現場訊號（NFC 捷徑、簡報捷徑）的共用金鑰 |
| `SITE_URL` | 建議 | `https://visit.healsdesign.org`；專屬網址與信裡的連結用它組 |
| `OPENAI_API_KEY` | 選 | Whisper，只用於主持人的三十秒口述；沒有就在後台打字輸入逐字稿 |
| `CLAUDE_MODEL` | 選 | 預設 `claude-opus-5` |
| `STORE_BACKEND` | 選 | `blobs`（預設，零設定）或 `sheets`（見 §2） |
| `GOOGLE_SHEET_ID`、`GOOGLE_SERVICE_ACCOUNT_JSON` | sheets 時必要 | 見 §2 |
| `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`、`GMAIL_SENDER` | 選 | 訪後信一鍵寄出（§3）。沒設定時後台會給 mailto 與複製 |
| `DICTATION_LANGUAGE` | 選 | Whisper 的語言提示，預設 `zh` |

4. Deploy。部署後：`https://visit.healsdesign.org/admin.html` 用 `ADMIN_TOKEN` 登入。

**資料在哪**：預設在 Netlify Blobs（store `ghrc-visit`：`visits/`、`responses/`、`timeline/`、`slideperf/`、`media/`）。後台「資料」分頁可匯出四張表的 CSV。Deploy Preview 與分支部署用 deploy-scoped store，不會混進正式資料。

**金鑰安全**：所有金鑰只在 Netlify Functions 裡使用，前端只拿 `ADMIN_TOKEN`（存在瀏覽器 localStorage）。`SIGNAL_KEY` 會出現在 NFC 貼紙的網址裡，它只能寫動線時間、不能讀資料；外洩就換一個。

## 2. Google Sheet 當資料庫（選用，工作包第 6 章）

1. Google Cloud Console → 建專案 → 啟用 **Google Sheets API** → IAM → 服務帳戶 → 建立金鑰（JSON）。
2. 建一份 Google Sheet，分享給服務帳戶的 email（編輯者）。網址裡 `/d/<這一段>/edit` 就是 `GOOGLE_SHEET_ID`。
3. Netlify 環境變數：`STORE_BACKEND=sheets`、`GOOGLE_SHEET_ID`、`GOOGLE_SERVICE_ACCOUNT_JSON`（整個 JSON 檔內容貼成一行）。
4. 第一次呼叫時系統會自動建立 `visits`、`responses`、`timeline`、`slide_performance` 四個工作表並寫入中文表頭。JSON 欄位（名單、議程…）以字串存在儲存格；`visits` 最後一欄是完整 JSON。
5. 照片與音檔仍存 Netlify Blobs（Sheet 只存 key）。

不具名的回覆：`姓名`、`email` 欄位一律空白，`填答時間` 只有日期。後端不會補回，請不要在 Sheet 上手動比對。

## 3. 訪後信一鍵寄出（Gmail API，選用）

1. Google Cloud Console → 啟用 **Gmail API** → OAuth 同意畫面（內部或測試使用者加入 ntughrc@gmail.com）→ 憑證 → OAuth 用戶端 ID（桌面應用程式）。
2. 用 OAuth Playground（https://developers.google.com/oauthplayground，設定裡填自己的 client id／secret）授權 `https://www.googleapis.com/auth/gmail.send`，換得 **refresh token**。
3. Netlify 環境變數：`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`、`GMAIL_SENDER=ntughrc@gmail.com`。
4. 後台「訪後信」→ 勾收件人 → 寄出。每人一封（不是 BCC）。寄件帳號固定是授權的那一個；「寄件者」下拉只決定署名（中心主任或對口老師）。

沒設定時，後台會明確顯示「尚未寄出」，並提供 mailto（BCC 全員）與複製信件。

## 4. 現場硬體

```bash
node scripts/make-shortcuts.mjs --site=https://visit.healsdesign.org --key=<SIGNAL_KEY> --out=dist/shortcuts
```

- **訊號一 老師開簡報**：`dist/shortcuts/<房號>/今日參訪.bat`（Windows）或 `.command`（macOS）放到研究室電腦，桌面建捷徑；把裡面的簡報路徑改成當天檔案。點開＝送訊號＋開簡報。動線第一站是總體介紹，所以簡報室電腦放 `briefing/` 那一份：開總體簡報就是整場的起點訊號。
- **訊號二 NFC 貼紙**：六片 NTAG213 貼在門口（簡報室一片用 `briefing/signal.url`，五間研究室各一片）。iPhone「捷徑」→ 自動化 → NFC → 「取得 URL 內容」填 `dist/shortcuts/<房號>/signal.url` 裡的網址 → 關閉「執行前先詢問」。碰一下即送出。
- 訊號不帶 visit_id，伺服器對到「今天」排定的參訪；同一天多場時取時間窗涵蓋現在的那一場。
- 備援：研究生 `source=student`；來賓端頁面最下面「我現在在哪一間」。

## 5. 收工提醒

後台儲存參訪後「下載收工提醒 .ics」→ 加進主持人的行事曆。預定結束時間鬧鈴，點開直達 `admin.html#wrapup=<visit_id>`。
（要改成推播的話：Netlify Scheduled Function 每 5 分鐘掃當天 visits 的結束時間，用 Web Push 送。v1 先用行事曆，零基礎設施。）

## 6. 母簡報：slim master

母簡報 396 MB 不能進 repo（GitHub 單檔 100 MB）。在本機：

```bash
pip install python-pptx Pillow
python3 scripts/slim-master.py "GHRC 介紹簡報2026-9.pptx" --out public/assets/master/slim-master.pptx \
    --video-link 19=<影片連結> --video-link 35=… --video-link 37=… --video-link 38=… --video-link 52=…
```

- 影片改成「海報影格 ＋ ▶ Video 連結」（影片放 Drive／YouTube 不公開）；超過 3 MB 或長邊超過 2000px 的圖縮到 2000px、轉 JPEG；清掉沒被引用的媒體；目標 < 30 MB（超過會提示 `--all-images`、`--max-edge 1600`）。
- 把 slim master 放上站台有兩種方式：**後台「上傳母簡報 .pptx」一次**（切成 4 MB 分塊存進 Netlify Blobs，`/api/master`，要 ADMIN_TOKEN，不公開；之後「產生簡報」直接抓），或 commit 到 `public/assets/master/slim-master.pptx`（Netlify 公開發佈，知道網址的人都能下載）。兩者都沒有時，按「產生簡報」會當場請你從電腦選檔，產完可一鍵存到站台。**可以直接選 396 MB 的原始母簡報**：含影片或超過 60 MB 的檔會先在瀏覽器裡瘦身（抽影片留海報、大圖縮到 2000px），大約一兩分鐘，存到站台的是瘦身後的版本。原始母檔留在 Drive 當備份。
- 產出後：`npm run deck -- --inspect` 看頁次是否與 `public/data/slides.json` 的索引一致（章節編號與實體頁序不一致是已知現象，索引以頁序為準）；`npm run deck -- --dump` 寫 `data/master-text.json` 並 commit，之後 `/api/plan` 就能產生第 1–3 頁（封面、流程、架構）逐字替換的 `text_edits`。

## 6.5 另存 Google Drive（長期檔案）

後台「資料」分頁選一場參訪 → **備份到 Google Drive**：中心 Drive 的 `GHRC 參訪/<日期> <單位>/` 會多一個資料夾，
放參訪資料.json、回覆.csv、動線.csv、一頁摘要.md、簽名簿照片、主持人口述音檔、當天簡報.pdf、現場合照。同名覆蓋，可以重複按。

Netlify 環境變數（沿用寄信那組 Google OAuth 也可以，但 refresh token 必須含 `drive.file` 權限）：

| 變數 | 說明 |
|---|---|
| `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET` | OAuth 用戶端；沒設就用 `GMAIL_CLIENT_ID`／`GMAIL_CLIENT_SECRET` |
| `GOOGLE_REFRESH_TOKEN` | 中心 Google 帳號授權的 refresh token（scope `https://www.googleapis.com/auth/drive.file`，要寄信再加 `gmail.send`）；沒設就用 `GMAIL_REFRESH_TOKEN` |
| `GOOGLE_DRIVE_FOLDER_ID` | **通常不要設**。不設時系統會在你的雲端硬碟自己建一個「GHRC 參訪」資料夾 |

拿 refresh token（只做一次）：

1. [Google Cloud Console](https://console.cloud.google.com/) 建一個專案 → 「API 和服務」→ 啟用 **Google Drive API**
2. 「OAuth 同意畫面」→ External → 填名稱與聯絡信箱 → **發布狀態設為「正式版」**（測試模式的 refresh token 七天就失效；`drive.file` 屬於非敏感範圍，按發布即可，不必送審）
3. 「憑證」→ 建立 OAuth 用戶端 ID → **網頁應用程式** → 已授權的重新導向 URI 填 `https://developers.google.com/oauthplayground` → 記下用戶端 ID 與密鑰
4. 開 [OAuth Playground](https://developers.google.com/oauthplayground/) → 右上齒輪勾「Use your own OAuth credentials」填入剛才兩個值 → 左欄輸入 scope `https://www.googleapis.com/auth/drive.file` → Authorize（選中心要用的那個 Google 帳號）→ Exchange authorization code for tokens → 複製 **Refresh token**
5. 三個值填進 Netlify 環境變數（Site configuration → Environment variables）

**為什麼不要設 `GOOGLE_DRIVE_FOLDER_ID`**：`drive.file` 只讓程式看得到「它自己建立的檔案」，指定一個別人建的資料夾會存取不到。
真的要指定既有資料夾，refresh token 得改用全權限的 `https://www.googleapis.com/auth/drive`——那是受限範圍，發布前要送 Google 審查，不建議。

用中心自己的 Google 帳號授權，不要用服務帳戶——服務帳戶沒有 Drive 儲存配額，上傳會被拒。
**帳號選定後就不要換**：`drive.file` 只看得到自己建立的檔案，換一個帳號授權等於從空的開始，先前那個「GHRC 參訪」資料夾不會再被認出來。

## 7. 產出當次簡報

平常在後台「訪前」存檔後按 **產生簡報 .pptx**：瀏覽器抓 slim master（後台上傳的、站台靜態檔、或當場選檔）、依選頁與流程子集化、韓／日文版呼叫 `/api/translate` 翻譯中文段落、直接下載 `GHRC_<visit_id>.pptx`。PDF 請用 PowerPoint 另存，再到「收工」放上專屬頁面。本機 CLI 是備援（多出 LibreOffice 轉 PDF）：

```bash
npm run deck -- --visit=2026-10-07-uwa          # 需要 data/visits/2026-10-07-uwa.json（/api/visits?id=… 的 visit 物件）與 public/assets/master/slim-master.pptx
npm run deck -- --spec=path/to.json --lang=ko    # 韓文版：中文段落翻成韓文（需 ANTHROPIC_API_KEY；翻譯快取在 data/translations/ko.json）
npm run deck -- --spec=path/to.json --no-pdf     # 不裝 LibreOffice 時
```

輸出 `dist/<visit_id>.pptx`、`.pdf`（有 LibreOffice 時）、`.txt`（全文，QA 用）、`.report.json`（取代了幾處、哪幾處沒找到、驗證結果）。
產檔規則：選頁依 spec；第 2 頁流程表若是表格會自動填（時間／英文／第二語言／頁碼）；`text_edits` 逐字取代；`language=en` 刪掉中文段落、`ko`／`ja` 翻譯並換東亞字型；最後加「您最想看哪一部分」頁（從組織架構頁複製，五位老師照片並列）與 QR 頁（從謝謝頁複製）。

## 8. 第一次試跑

- **Bill Sullivan（2026/9/15–22）**：時間太近，先手動試「收工兩動作」——擺一本簽名簿、結束後用手機錄三十秒。後台「收工」分頁就能把這兩份素材存進系統（先在訪前建一筆參訪即可）。
- **Simon Kilbane（10 月初）**：完整跑一次。訪前貼信、確認名單 email、排行程、產簡報；現場捷徑與 NFC；收工兩動作；訪後信寄全名單，看開放建議欄位收不收得到東西。
