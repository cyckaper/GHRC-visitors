# CLAUDE.md — ghrc-visit

GHRC 參訪系統。臺大生農學院綠色健康研究中心（GHRC）每年接待大量國內外參訪，
從高中生到諾貝爾獎得主、各校校長院長、部長級官員。本專案把「訪前準備 → 客製簡報 →
訪後回饋 → 長期檔案 → 回饋下一次簡報」串成一個閉環。

配套文件：`docs/工作包.md`（完整的構想脈絡與否決清單，動工前先讀）。

---

## 五項功能（專案範圍）

1. **查來信或相關資料，了解訪客背景** — 讀 email 往來與附件，抽出單位、名單、職稱、來訪目的、興趣、可用時間
2. **製作客製化雙語簡報** — 依對象與議程時間，從母簡報挑選與重排，產出「英文為主 ＋ 對方語言為輔」的 pptx
3. **收集訪客回饋及後續資料** — 訪後信、開放建議欄位、簽名簿、主持人口述、動線訊號
4. **建構長期訪客資料檔案，並回饋下一次簡報** — 歷次參訪累積成檔案，讓下一份簡報的挑選有依據
5. **建到 GitHub，由 Netlify 發佈**

---

## ⚠️ 動工前必讀：母簡報 396 MB

`GHRC_介紹簡報2026-9.pptx` 是 **395.9 MB / 72 頁**。這件事會擋住第 5 項功能，必須先處理。

| 事實 | 後果 |
|---|---|
| GitHub 單一檔案上限 100 MB（硬性） | **母簡報不能進 repo**，Git LFS 也只是繞路 |
| 5 支內嵌 mp4 佔約 302 MB | 在 slide 19、35、37、38、52 |
| 4 張圖片超過 3 MB（image3.png 就有 14.6 MB） | 未壓縮 |
| Netlify Function 請求上限 6 MB、預設逾時 10 秒 | 不可能在一般 function 裡處理 396 MB |

**第一步（在寫任何功能之前做）：產出 slim master。**

1. 抽掉 5 支 mp4，改成「海報影格 ＋ 影片連結／QR」的版面（影片放 Drive 或 YouTube 不公開連結）
2. image3.png、image43.png、image31.png、image44.png 降階為長邊 2000px 的 JPEG
3. 目標 **< 30 MB**。放上站台的方式二選一：後台「上傳母簡報」一次（分塊存進 Netlify Blobs，`/api/master`，要 token，不公開）；
   或 commit 到 `public/assets/master/slim-master.pptx`（Netlify 公開發佈）。都沒有時，按「產生簡報」會當場請你選檔

這一步不只是為了讓 repo 塞得下。396 MB 的簡報寄不出去、開得很慢、現場容易當機，
slim master 本身就是對日常簡報的改善，客製化產出的檔案也才寄得出去。
**原始 396 MB 母檔留在 Drive 當備份，repo 只放 slim master。**

---

## 架構決定

### 不要從零生成簡報

母簡報是設計過的 72 頁成品。**不要用 pptxgenjs 重新生成** —— 那會丟掉全部設計。
做法是**子集化母簡報**：解壓 → 選頁 → 改議程頁 → 換第二語言 → 重壓。

```
unzip slim-master.pptx → 編輯 ppt/presentation.xml 的 <p:sldIdLst> 決定留哪些頁
                       → 改 ppt/slides/slideN.xml 的文字
                       → 清掉沒被引用的 media
                       → 重新 zip
```

用 `defusedxml.minidom` 或 JS 的 XML 解析器處理，**不要用 ElementTree round-trip**（會改寫
namespace prefix 而毀檔）。刪頁後務必清理孤兒 media，否則檔案大小不會降。

### v1 切法：規格與產檔都在瀏覽器，CLI 備援

```
admin.html（Netlify 靜態頁）   排好行程、選頁、語言 → 按「產生簡報 .pptx」
        ↓  瀏覽器裡執行 public/lib/pptx.mjs（JSZip ＋ 原生 DOMParser）
slim master（後台「上傳母簡報」一次 → Blobs 分塊；或 public/assets/master/ 靜態檔；都沒有就當場選檔）
        → 子集化 → 直接下載 GHRC_<visit_id>.pptx
```

理由：pptx 子集化要解壓幾十 MB、改檔、重壓，塞進 Netlify Function 會撞 6 MB 請求上限、逾時與記憶體；
放在瀏覽器裡跑就沒有這些限制，主辦端也不必開終端機。同一份核心給本機 CLI 用（多出 PDF 轉檔）：

```bash
npm run deck -- --visit=2026-10-07-uwa      # 讀 data/visits/*.json ＋ public/assets/master/slim-master.pptx，輸出 dist/（＋PDF）
```

第二語言（ko／ja）的翻譯走 `/api/translate`（Claude；伺服器端快取），瀏覽器一次送 25 段避開 function 逾時。

### 前端沿用既有慣例

單檔 HTML、Tailwind CDN、無建置步驟，與 healsdesign.org 系列一致。兩個頁面：

- `admin.html` — 主辦端：貼 email、確認抽取結果、排議程、選頁、直接產 .pptx、放當天資料、寄訪後信
- `index.html` — 來賓端：當次專頁（流程、五間老師卡片、留信箱）

API 金鑰一律走 Netlify Function，**絕不出現在前端**。

---

## 母簡報結構（slim master 沿用同一份索引）

⚠️ **章節編號與實體頁序不一致**，不能靠掃描章節標題來選頁，必須用底下這張表。
例如第 39–42 頁屬於章節 04，卻排在章節 03 的第 43–48 頁之前；第 54 頁是章節 05 的分隔頁，
卻排在章節 04 的第 55 頁之前。

| 頁次 | 內容 | 章節 | 備註 |
|---|---|---|---|
| 1 | 封面「歡迎蒞臨」 | — | 每次要改單位名稱 |
| 2 | **今日流程 Programme** | — | **每次必改**：時間區塊、長度、頁碼範圍 |
| 3 | 簡報架構 Contents | — | 選頁後要跟著改 |
| 4 | 核心宣稱 The Claim | — | 建議永遠保留 |
| 5 | 組織架構 Organisation | 誤標 08 | 實驗室負責人一覽 |
| 6–11 | 為什麼是現在 Why Now | 01 | 6 分隔頁；7 政策線；8 沿革；9 開幕；10–11 設置辦法任務 |
| 12–14 | 核心主張 Core Proposition | 02 | 13 閉環證據鏈；14 空間與經費來源 |
| 15–20 | Lab 301 智能室（張俊彥） | 03 量測 | 15 分隔頁；18 HealthCloud；19 **影片**；20 七站工具鏈 |
| 21–28 | Lab 302 規劃室（林寶秀） | 03 設計 | ENVI-met 微氣候模擬全套 |
| 29–38 | Lab 303 模擬室（陳惠美） | 03 驗證 | VR 設備、360VR 教材、傷口疼痛；35/37/38 **影片** |
| 39–42 | 研究成果：病患照護、高齡與學童、北區農村綠色照顧 | 04 | 夾在 03 中間 |
| 43–48 | Lab 305 IVR 研究選輯（鄭佳昆） | 03 驗證 | 43 總覽；44–48 五個研究 |
| 49–50 | Lab 304 全景影院（張伯茹） | 03 處方 | CAVE VR |
| 51–53 | 旗艦案例：CAVE 超慢跑與慢性下背痛 | 04 | 52 **影片**；53 依介入對象分群 |
| 54 | 人才與教育 分隔頁 | 05 | 位置在 55 之前 |
| 55 | 委託研究計畫 | 04 | |
| 56–60 | 課程、學生創業、展覽與科普 | 05 | |
| 61–66 | 國際平台 八校、已簽合作、UIUC 三度接觸、NTU–UIUC 聯合中心 | 06 | |
| 67–69 | 2026 遠見 USR 首獎 | 07 | |
| 70–71 | 未來三年 三項承諾 | 08 | |
| 72 | 謝謝 Thank you | — | 建議永遠保留 |

**實驗室負責人（第 5 頁與各實驗室首頁一致，已由母簡報確認）**

| 空間 | 名稱 | 負責人 |
|---|---|---|
| 301 | Health Landscape Intelligence Lab 健康景觀智能室 | 張俊彥 Chun-Yen Chang |
| 302 | Healing Environment Planning Lab 療癒環境規劃室 | 林寶秀 Bau-Show Lin |
| 303 | Landscape Simulation Lab 景觀環境模擬室 | 陳惠美 Hui-Mei Chen |
| 304 | Panoramic Cinema Lab 全景影院體驗室 | 張伯茹 Po-Ju Chang |
| 305 | IVR Research Lab IVR 研究室（沉浸式虛擬實境） | 鄭佳昆 Chia-Kuen Cheng |

> 本系統所有標示（老師卡片、選頁區塊標題、負責人索引、提示詞）**303 只列陳惠美**、**305 就叫 IVR Research Lab**（不寫「304 外部空間」）（明確指示）。母簡報投影片裡的文字本系統不改寫。
>
> **中心只有這五間。** 來信裡出現的其他單位（例如智慧溫室）不是中心的，所有文字都不能寫成「我們的」；全程在造園館三樓室內，不給步行、鞋履之類的提醒；信件不感謝中心自己的老師。這些寫在 `netlify/lib/ai.mts` 的 `CENTER_FACTS`，每一個提示詞都帶。

---

## 雙語機制

母簡報是**英文為主標、中文為輔**，成對文字放在同一個 text frame，用 `|` 或全形間隔號分隔：

```
Lab 301 — Health Landscape Intelligence Lab
301 健康景觀智能室　·　負責人　張俊彥　Lead: Chun-Yen Chang
```

換第二語言（例如韓國團要 EN|KO）＝ **只改中文那一段的 run**，英文段落不動。

- 中文段落靠 CJK 字元偵測，但要小心英文段落裡也有人名的中文
- 換成韓文／日文要一併換字型，否則會掉成方框
- **不要做成全篇平行對照** —— 英文是主標，第二語言是輔助，這是既有標準

### 簡報的既有標準（不可違反）

- **字級要大**。寧可拆頁或精簡，也不要為了塞字而縮小字級
- **雙語以英文為主、第二語言為輔**
- **照片維持真實比例**，不變形、不裁切、不旋轉
- **HEALS Design 是 Lab 301 專屬方法論，不是中心層級的方法論**
- **不放中心總預算數字**。各實驗室設備來自各老師個別計畫，加總會失真
- 涉及台灣療癒產業時，要主動指出台灣休閒農業與農業／園藝／森林療癒其實發展成熟
  （勞動部已有森林療癒與園藝療癒認證及課程、全台百餘處休閒農業區），不要只談制度缺口

---

## 資料模型

Google Sheet 一份四個工作表（或等價的 JSON 檔），靠 `visit_id` 串接。
`visit_id` 格式：`YYYY-MM-DD-代碼`，例如 `2026-10-07-uwa`。

**visits** — `visit_id`、日期、單位、單位類型、國家、人數、主要來賓姓名職稱、
隨行名單（JSON：姓名/職稱/email）、對口老師、來訪目的、興趣關鍵字、議程（JSON）、
選用頁次（JSON）、語言、專頁網址、簡報檔連結、簽名簿照片、口述音檔、口述逐字稿、
訪後信寄送清單與時間、一頁摘要

**responses** — `visit_id`、姓名（若具名）、email（若具名）、最想看的研究室、
想合作的研究室（複選）、希望我們做什麼、自填內容、簽名簿留言、**開放建議內容**、
**是否具名**、填答時間、來源（口述抽取／簽名簿／訪後信／現場自填）

> 開放建議欄位若選擇不具名，**姓名與 email 必須留空，後端不得補回**。
> 這不是介面裝飾，是這條管道能不能收到真話的前提。

**timeline** — `visit_id`、空間代號、進入時間、離開時間、停留分鐘、
訊號來源（簡報捷徑／NFC／排程推補／學生代按／來賓自按）

**slide_performance**（功能 4 的核心）— `visit_id`、單位類型、頁次、是否選用、
該次是否被提問、回饋中是否被提及。這張表是「回饋下一次簡報」的資料來源。

---

## 五項功能的實作

### 1. 查來信、了解訪客背景

輸入兩種都要做，共用同一套抽取邏輯：貼上 email 內容（v1，零權限）；接 Gmail API（v2）。

Claude API 抽出：單位、單位類型、國家、人名職稱、**隨行名單與聯絡方式**、日期時間、
可用時長、來訪目的、興趣關鍵字、對口老師。抽取結果一律在 admin.html 上顯示給人確認後才寫入 —— 不要自動落庫。

> 隨行名單的 email 是功能 3 取得代表性的關鍵，抽取時要特別留住，不要只留主要窗口一人。

> **跑得久的 AI 一律走背景函式。** Netlify 一般函式只有 10 秒，Claude 讀一封長信、排一整份行程、
> 寫一封雙語信都不只（實際踩過：畫面回 504 Inactivity Timeout）。所以一般函式那一支只做「檢查、
> 把大檔先存下來、開一個工作、觸發背景函式」，回 202 `{job_id}`；前端每 3 秒問一次
> `GET /api/<name>?job=<id>`（`running`／`done`／`error`，`done` 才把結果填進畫面）。
>
> 共用的東西在 `netlify/lib/jobs.mts`：`startBackground(kind, input, req)`（開工作＋觸發）、
> `pollJob(req, label)`（查進度）、`backgroundHandler(label, fn)`（背景函式的外殼）。
> `jobs/<id>.json` 存狀態**與輸入**，背景函式自己去讀、觸發只帶 `job_id`——所以抽取不必先存檔，
> 輪詢也不會把幾 MB 的東西再送回前端一次；做完就把輸入丟掉。**照片、音檔這種大東西不進工作**：
> 一般函式先存進媒體庫，工作裡只帶 key。後台的共用輪詢是 `admin.html` 的
> `runJob(path, body, note, working)` ／ `waitForJob(path, jobId, note)`，`note` 那一行就寫在按鈕旁邊。
>
> 目前走這一套的：`extract`（讀信）、`plan`（排行程與選頁）、`research`（訪前功課，狀態另外記在
> `visit.background`）、`letter`（草擬**與寄出**）、`summary`（一頁摘要與跨場次彙整）、`signbook`（讀手寫字）、
> `transcribe`（Whisper ＋抽取）、`cards`（讀名片）、`translate`（第二語言）。再有跑得久的 AI 就照這個模式加，
> 不要直接在一般函式裡等。
>
> **兩條給畫面的規矩**（主辦端是老師，不是工程師）：
> 1. **進度那一行只講在做什麼、大概多久**——「AI 排行程中……大約一兩分鐘。」
>    不要出現「背景函式」「跑在背景」「輪詢」「job」這類字眼：那是我們怎麼實作的，與他無關。
> 2. **等就等到底**，輪詢等滿 15 分鐘（背景函式的上限）才放棄，中途不要叫人「再按一次看看」——
>    以前 4 分鐘就放棄，AI 慢一點就變成「等很久沒反應、再按一次才有結果」，看起來像壞掉。
>
> 兩個刻意的例外：`translate` **整批命中快取就當場回**（產簡報時一批一批來，不能每批都空等三秒）；
> `letter` 的 `action:"recipients"` 與「沒設定 Gmail」也當場回，因為根本沒有等待可言。

**訪前功課（`/api/research`）**：抽取之後再查一次**公開的專業資料**（單位的性質與業務、來賓的職稱與領域、近期公開計畫或報導），整理成一頁研判：單位側寫、名單上的人、**可能的參訪目的**（最可能的放前面，附依據）、可能最想看哪幾間（301–305）、可以先準備什麼、還要確認什麼、讀過的網址。用 Claude 的伺服器端網路搜尋工具；帳號沒開搜尋時退回「只讀來信」並在畫面上標明。只查公開的專業資訊，不查私人生活；查不到就說查不到，不編。結果只給主辦端看，不進來賓專頁、不進信件。

> **查網路要一到三分鐘，一般函式只有 10 秒**（實際踩過：畫面回 504 Inactivity Timeout），所以走背景工作
> （`research-background`，15 分鐘上限）。**還沒存檔也查得了**：要查的那一筆跟著工作走，結果從 `GET /api/research?job=` 拿；
> 存過檔的另外把 `status` 與結果寫回 `visit.background`，重新整理或換台機器再打開，`GET /api/research?id=` 接得回進度。
> 沒存檔的結果先留在畫面上，`readForm()` 會把它一起帶進「儲存」。

### 2. 客製化雙語簡報

輸入 = 訪客背景 ＋ 可用分鐘數 ＋ 對方語言。輸出 = pptx（後台直接下載；規格就是 visits 表那一筆）。

- 依單位類型與興趣挑頁（政府偏政策與場域落地、大學偏研究與學生交流、企業偏應用與委託研究、
  學生團偏影片與體驗），並參考 `slide_performance` 的歷史
- 依分鐘數控制總頁數（抓每頁 40–60 秒，含影片另計）
- **第 2 頁議程必改**：重算時間區塊與頁碼範圍
- 第 3 頁 Contents 跟著選頁改
- 第二語言依對方語言替換
- 最後加一頁「您最想看哪一部分」（五位老師照片並列）與當次 QR 頁
- 同時輸出 PDF 供訪後信附件

產出後跑 QA：`markitdown` 檢查內容、`validate.py --original` 檢查檔案結構、
轉圖檢查有沒有溢出或錯位。

### 3. 收集回饋

- **訪後信**：寄給**名單上每一個人**，不只主要窗口。三個回應項目 ——
  想合作哪幾間（301–305 複選）、希望我們做什麼、**開放建議欄位**。
  草擬與**寄出**都在 `letter-background`：一封一封打 Gmail API，十幾個人就超過一般函式的 10 秒，
  寄到一半被砍掉最糟——有些人收到了、紀錄卻沒寫回去，再按一次就重寄。
- **開放建議欄位的措辭必須是請益語氣，不是滿意度語氣**：
  「以您的專業，中心哪一部分還可以做得更好？」／
  "From your perspective, what should we be doing better?"
  並加一句「一句話就好」，且**可不具名送出**
- **訪客名片**：現場拿到名片就拍一張（後台**「收工」分頁的動作二**——拍名片是現場的事，跟簽名簿、口述放在一起，
  不在翻舊帳的「資料」分頁；手機直接開相機，可連拍）。AI 讀出姓名、職稱、單位、email、電話，**人逐欄確認後**才併進這場的名單（`/api/cards`）——訪後信就會寄給他。併入規則 `lib/visit.mjs mergeGuests`：email 相同（不分大小寫）或「姓名＋單位」相同視為同一人，**只補空欄位、不覆寫已確認的資料**，也不會把主賓降級；同一張再存一次是 no-op。看不清楚的字一律留空不猜（email 猜錯比留空更糟）。原圖存 `cards/<visit_id>/<ts>.jpg`（**有個資，`/api/media` 只給 admin**），Drive 備份用名片主人的名字當檔名。
- **簽名簿**：實體本子，主持人拍照上傳，AI 讀手寫字歸檔（原圖保留）
- **主持人三十秒口述**：參訪結束後由主持人口述，Whisper 轉文字後抽取
  （誰來、最想看哪一間、問了什麼、有無合作意願）。依議程結束時間推播提醒
- **動線訊號**：老師開簡報的捷徑、門口 NFC 貼紙、排程推補三者擇有

### 4. 長期檔案與回饋下一次簡報

- **每場自動備份到 Google Drive**：中心 Drive 的 `GHRC 參訪/<日期> <單位>/` 一場一個資料夾，
  放參訪資料.json、回覆.csv、動線.csv、一頁摘要.md、簽名簿照片、主持人口述音檔、當天簡報.pdf、現場合照（**用原始檔名**，例如 IMG_0696.jpg；同名的加序號。不用流水號，否則刪掉中間一張時編號往前遞補會蓋掉別張的內容）。
  **不必手動按**：資料寫進去的端點（`visits` 存檔、`signbook`、`transcribe`、`materials`、`letter` 寄出、`summary`、
  來賓的 `respond`）都會呼叫 `lib/drive.mts triggerDriveSync()`，觸發背景函式 `drive-sync-background`
  （Netlify 背景函式，15 分鐘上限，一次把整場搬完；一般函式 10 秒不夠）。`drive-cron` 每晚台北時間兩點掃一次補漏。
  `needsSync()` 比對 `visit.drive.backed_up_at` 與參訪／回覆的時間，沒有新東西就跳過；同步只寫 `visit.drive`，
  **不動 `updated_at`**，否則下一次會永遠認為有變動。後台「資料」分頁的「立即備份到 Drive」是手動補救用的（一次一個檔，顯示進度）。
  授權沿用寄信那組 Google OAuth（`GOOGLE_*` 優先，沒有就用 `GMAIL_*`），refresh token 要含 `drive.file`；
  用中心自己的帳號而不是服務帳戶（服務帳戶沒有 Drive 配額）。站台的 Blobs 仍是主要資料層，Drive 是另存的檔案庫。
  **`GOOGLE_DRIVE_FOLDER_ID` 通常留空**：`drive.file` 只看得到程式自己建立的檔案，指定別人建的資料夾會存取不到，
  留空時 `ensureFolder("GHRC 參訪", "root")` 會自己在雲端硬碟根目錄建一個並沿用（設定步驟見 `docs/DEPLOY.md` 6.5）。
- 每場產出一頁摘要
- `slide_performance` 累積後，功能 2 的挑頁改為「同類單位過去選過什麼、哪幾頁引發提問、
  哪幾頁在回饋中被提到」
- 跨場次彙整開放建議欄位，找出重複出現的問題（例如某一間反覆被說聽不懂），
  定期送回各研究室老師手上
- 年報與諮詢委員會統計：人次、身分、國家、最受關注的研究室、合作意向趨勢

### 5. 部署

GitHub repo → Netlify，站台 `visit.healsdesign.org`（掛在既有 healsdesign.org 下）。
Netlify Functions 放 Claude API 與 Whisper 的呼叫，金鑰用 Netlify 環境變數。
**repo 內不得出現超過 100 MB 的檔案**（見上文 slim master）。

---

## 不要做的事（已否決，勿重提）

| 不要做 | 理由 |
|---|---|
| 用 pptxgenjs 從零生成中心簡報 | 母簡報是設計過的成品，重生成會丟掉全部設計 |
| 把 396 MB 母簡報放進 repo | GitHub 單檔上限 100 MB |
| 在一般 Netlify Function 裡做 pptx 子集化 | 6 MB 請求上限、10 秒逾時 |
| 現場錄音來賓 | 對部長級不禮貌；且被告知錄音後只會講官話，資料更差 |
| 依來賓身分分級走不同流程 | 一律同一套。只要有一種來賓不適合，那個做法就不該存在 |
| 研究室出口放滿意度評分按鍵 | **研究室會像廁所，而且中心不是服務單位**。任何星等、NPS、滿意度按鍵都不採用 |
| 集章、電子證書等紀念品誘因 | 年長重量級來賓不在乎，對主要客群無效 |
| 要求來賓每進一間掃一次 QR | 要來賓動手五次，只能當備援 |
| 傳統問卷 | 沒有人會填 |
| 把來賓框成顧客的任何用語 | 這是同行的學術交流。問法用請益語氣 |

---

## 待確認

1. 各老師的「一句話研究主題」、專長、學經歷（來賓端老師卡片用）與照片
2. 開放建議欄位的中英文措辭定稿
3. 簽名簿的形式與擺放位置
4. ~~隨行名單聯絡方式拿不到時的備案~~ → 現場拍名片（功能 3 的「訪客名片」）
5. 訪後信預設寄件者（中心主任或對口老師，兩案都做，需一個預設值）
6. 主持人口述音檔的保存期限

---

## 背景

- GHRC＝綠色健康研究中心，臺大生農學院，造園館三樓 301–304 室，ntughrc@gmail.com
- 張俊彥（Chun-Yen Chang）2026/8/1 接任中心主任；前任陳惠美（現任系主任兼梅峰農場場長）續任 Co-PI
- 中心參訪制度仍在非正式試辦，本系統同時補上這個治理缺口
- 國際夥伴：UIUC（William Sullivan、Brian Deal）、韓國建國大學、UT Arlington、UWA（洽談中）；
  Landscape and Human Health 八校平台
- 第一次正式試跑對象：Simon Kilbane（UWA），2026/9/28–10/16 訪台，10 月初到中心

---

## Repo 現況（2026-09-10 首次建置）

上面各節是規格；這一節記錄實作到哪裡、怎麼跑、還沒驗證什麼。改了架構請同步更新這裡。

**已完成（P1–P4 最小可用系統 ＋ P5 捷徑 ＋ P6 產檔 ＋ P7 摘要／彙整）**

- `public/admin.html`：最上面一個共用的「這一場」（全站同一個選擇）；訪前（貼信或上傳名單檔抽取 → 確認 → **AI 查訪客背景（可能的參訪目的）** → 排行程 → 自動存 → QR／.ics／確認信）、**簡報（獨立分頁：選用頁次、產生 .pptx、母簡報；「這場不用簡報，只口頭介紹」可整頁關掉）**、收工（動作一 簽名簿讀字、**動作二 拍名片讀成名單**、動作三 三十秒口述、動作四 當天資料放上專頁）、訪後信（草擬、全名單收件人、寄出或 mailto）、資料（歷次參訪、回覆、動線、摘要、跨場次彙整、CSV、Drive）。登入 token 存瀏覽器，登入後收起只留「已登入／登出」。
- `public/index.html`：專屬網址 `/<visit_id>`；全頁英文為主、第二語言為輔（預設中文，ko／ja 來賓用韓／日文）；流程（參訪當天標出「現在」）、當天資料（PDF／合照／連結，有才顯示）、五間老師卡片（303 只列陳惠美；有 email 才顯示聯絡方式）、留信箱、備援按鍵，最後是三個回應項目（請益措辭、一句話就好、真匿名）。進場動畫與 hover 尊重 `prefers-reduced-motion`。
- `netlify/functions/*.mts`：`visits` `extract` `research`（訪前功課） `plan` `letter` `respond` `timeline` `signbook` `cards`（訪客名片） `transcribe` `summary` `media` `materials` `translate` `master` `session`（登入） `extract-background`／`plan-background`／`research-background`／`letter-background`／`summary-background`／`signbook-background`／`transcribe-background`／`cards-background`／`translate-background`（**跑得久的 AI 一律走背景函式**，見 `netlify/lib/jobs.mts`）`drive` `drive-sync-background`（自動備份）`drive-cron`（每晚補漏，`export const config = { schedule }`）；`media` 對 `materials/` 開頭的 key 公開（來賓端直接連），其餘要 token；共用在 `netlify/lib/`（store／ai／http／data／types／files／jobs）。`extract` 接受上傳檔：.docx／.xlsx／.pptx／.csv／.txt 在 `files.mts` 轉純文字（UTF-8 失敗退 Big5），PDF 與照片以 document／image block 直接交給 Claude；.doc／.xls 不支援。
- 資料層 `netlify/lib/store.mts`：`file`（本機）、`blobs`（Netlify 預設）、`sheets`（Google Sheet，服務帳戶）。真匿名在 `lib/visit.mjs sanitizeResponse`：不具名時姓名、email 清空、時間只留日期，後端不補回。
- `public/lib/pptx.mjs`：母簡報子集化核心（選頁重排、複製頁、逐字取代、流程表填值、第二語言換字、QR 頁、清孤兒、驗證），零 Node 相依，瀏覽器與 CLI 共用；`cli/lib/pptx.mjs` 只是注入 jszip／xmldom 的 Node 入口；`cli/deck.mjs` 加上 QR（qrcode 套件）與 PDF（LibreOffice）。`--inspect`、`--dump`、`--validate`。
- `scripts/slim-master.py`：抽影片成海報＋連結、縮圖、清媒體。`scripts/make-shortcuts.mjs`：研究室電腦捷徑與 NFC 網址。
- 測試：`npm test`（單元、API 走本機 dev server、產檔與瘦身走合成簡報）、`npm run test:e2e`（Chromium）。`AI_MOCK=1` 讓所有 AI 呼叫回固定範例。CI：`.github/workflows/ci.yml` 在每個 PR 與 main 的 push 跑同一套（typecheck → npm test → e2e）。

**尚未在真實環境驗證（首次建置時沒有金鑰與母簡報）**

- Claude API 的真實輸出（抽取、排程、信件、簽名簿讀字、摘要）——結構化輸出用 zod schema 綁住，但提示詞品質要用真信件調。
- Whisper、Gmail API、Google Sheets 後端、Netlify Blobs——都照官方 API 寫，沒有實際呼叫過。
- 真母簡報：`slim-master.py` 與產檔核心只在 `scripts/make-fixture.py` 的合成簡報上測過（Node 與 Chromium 兩邊都測，含分塊上傳／下載）。真檔的第 2 頁若不是表格，流程要靠 `text_edits`；先 `--dump` 再 commit `data/master-text.json`。slim master 尚未上傳到站台。
- PDF 輸出：沙箱裡 LibreOffice 不完整，沒跑到；本機有 LibreOffice 即可。

**約定**

- API 路徑 `/api/<name>` 由 `netlify.toml` 轉到 `/.netlify/functions/<name>`；函式不設 `config.path`。
- 主辦端 API 用 `Authorization: Bearer ADMIN_TOKEN`、`?token=`，或**登入後的 session cookie**；現場訊號用 `SIGNAL_KEY`；`respond` 與 `visits?public=1` 公開。
- **登入一次就好**：後台貼一次 ADMIN_TOKEN → `/api/session` 發一個 HttpOnly、SameSite=Strict 的 cookie（值是用 ADMIN_TOKEN 簽的 `v1.<到期>.<HMAC>`，**不是 token 本身**），180 天，每次打開後台自動續期。token 不再存 localStorage（iPad Safari 七天沒互動就清掉，所以以前每次都要重登；舊的會在開場自動換成 cookie）。登出走 `DELETE /api/session`。
- 老師卡片內容 `public/data/labs.json` 的 `confirmed=false` 表示尚待老師確認；照片 `photo` 為 null 時顯示縮寫。
- **全站一個「這一場」**：後台最上面一個下拉（`#visitSelect`）＋「已存 14:32」＋「刪掉這一場」，
  五個分頁都在同一場上做事，切分頁時 `reloadTab()` 重載那一頁要的東西。打開後台就停在今天
  （沒有就最近）那一場，不必自己先選；「＋ 新的一場」是明確的選擇。**不要再讓任何分頁自己長一個參訪下拉。**
- **沒有「存檔」這個動作**：訪前分頁任何欄位改動都會在 1.2 秒後自己存（`scheduleSave`／`saveVisit`），
  AI 抽取、排行程、查背景做完也各存一次。畫面上只有一行「已存 14:32」與「刪掉這一場」。
  建錯的那一場就刪掉：`DELETE /api/visits?id=`，順手清掉這一場自己的檔案（簽名簿、口述、名片、當天資料）；
  **已經有來賓回覆、或感謝信已經寄出去的不給刪**（那不是我們的東西），Drive 上的備份也不動。
- **網址（`visit_id` ＝ 日期 ＋ 代碼）在用出去之前跟著欄位走**：日期或網址代碼改了就換一個 visit_id，
  舊的那一筆刪掉（`POST /api/visits` 回 `renamed_from`）。一旦「用出去了」就固定，不再跟著改（回 `url_fixed`）——
  判斷標準 `isUnused()`：有人回覆、感謝信寄出、放了當天資料、有簽名簿／口述／名片、已備份到 Drive，其中之一就算用出去了。
  這樣先打錯日期再改也不會留下怪網址，而印出去的 QR 不會突然失效。
- 「產生簡報」直接用畫面上現在勾的頁，產完一起存回去——不必先按「儲存選頁」。
- **現場動線第一站固定是總體介紹，地點預設 302**：`itinerary[0].room === "briefing"`，`location` 空白就是 302（`lib/visit.mjs DEFAULT_BRIEFING_LOCATION`），之後才是 301–305；`ensureBriefingFirst` 在存檔與排程時強制，AI 排程不決定地點。現場訊號 `room=briefing` 代表簡報室（開總體簡報＝整場起點）。
- **當天資料** `visit.materials = { deck_pdf, photos[], links[] }`：值是媒體庫 key（`materials/<visit_id>/<file>`）或 https 連結，`sanitizeMaterials` 只留這兩種。上傳走 `/api/materials`（單檔 4.5 MB 以內；更大的 PDF 貼雲端連結）。合照先在瀏覽器縮到長邊 1600px，**縮不動就原檔上傳**（HEIC、壞檔、記憶體不夠都算），進度與錯誤顯示在「動作三」那張卡片上（`#materialsStatus`），不是只在頁面最上方 —— 上傳失敗時人在頁面中段，看不到頂端的提示。**訪後信只能承諾頁面上真的有的東西**：`lib/visit.mjs pageContents()` 算出清單交給提示詞（mock 信也照同一份清單）。PDF 由 PowerPoint 另存，再到「收工」放上去。
- 產檔在瀏覽器：`admin.html` 先問 `/api/master`（後台上傳的母簡報，4 MB 分塊存在媒體庫 `master/<upload_id>/part-i` ＋ `master/manifest.json`），再 HEAD `/assets/master/slim-master.pptx`（站台對不存在的路徑會回 index.html，所以看 content-type 不看狀態碼）；兩者都沒有時，「產生簡報」在同一個點擊裡同步開檔案選擇視窗，選完立刻產，並提供「把這份母簡報存到站台」。選檔或上傳時若檔案含影片或超過 60 MB，先在瀏覽器裡瘦身（`public/lib/pptx.mjs slimDeck`：抽影片留海報＋「▶ Video」、超過 3 MB 的圖用 canvas 縮到 2000px、清孤兒；規則同 `scripts/slim-master.py`），所以可以直接選 396 MB 的原始母簡報。JSZip 由 cdnjs 載入、QR 用頁面已有的 qrcodejs 畫 canvas（沒有就只放網址文字）。存檔後區塊不放操作說明，只有一行進度與必要時的警告。
- **來賓端雙語**：英文永遠是主語，第二語言預設中文（中英對照）；`visit.language` 是 ko／ja 時改英韓、英日。流程區塊的 `title_2nd` 空白時用 `i18n.json` 的 `kind_*` 補第二語言。
- **來賓端依階段換措辭**：訪前（日期在未來，或沒有參訪代碼的首頁）用「將參訪」、不放留信箱與感謝表單；當天才有留信箱與備援按鍵；訪後（日期已過或從感謝信的 `#respond` 進來）用過去式、標題改「感謝蒞臨」。`?phase=before|today|after` 可強制預覽。兩個互動層各有自己的連結，帶連結進來一定看得到（也支援中途換 hash）：`/<visit_id>#email`（留信箱）、`/<visit_id>#respond`（三個回應項目）。**這兩個連結在行程走完後才產出**，列在後台「收工」分頁，不在訪前。
- 今日流程固定含三個區塊：總體簡報（briefing）→ 研究室參訪（tour）→ **綜合討論（discussion）**，合照可省略；`plan.mts` 在 AI 漏掉綜合討論時自動補上並回傳 `warnings`。**時間分配預設**（`lib/visit.mjs allocateProgramme`）：總體介紹 20 分、每間研究室 20 分、合照 5 分，剩下的時間全部給綜合討論；總時間不夠時先縮研究室（每間至少 5）、再縮總體介紹（至少 10），綜合討論至少 10。預設總長 150 分。**分鐘數不歸 AI 決定**：AI 只決定哪幾間、順序與重點，`plan.mts` 回傳前一律用 `applyProgrammeTimes()` 重算動線分鐘與流程時間（改過就回 `warnings` 說一聲）；主辦端在表單上手改的分鐘數則照他的意思存，不會被重算。
- **選頁與產檔自成一個分頁**（`admin.html`「簡報」）：訪前只排行程，**有些參訪不用簡報，只口頭介紹**——在簡報分頁勾「這場不用簡報」即可，狀態存成 `visit.deck.skip`，訪前分頁只顯示一行結果。選頁存在 `visit.slides`（「儲存選頁」仍在，但**「產生簡報」會直接用畫面上現在勾的那幾頁並在產完一起存回去**，所以不必先按）；參訪則跟全站共用的「這一場」走。
- 後台「選用頁次」依 `public/data/slides.json` 的 `groups` 分區塊（章節／研究室）：區塊方框整區選、「只選這區」、全選／全不選；必選頁永遠保留。每一頁必須恰好屬於一個區塊。
- 開放建議欄位措辭在 `public/data/i18n.json`（`ask_better`、`one_sentence`、`anonymous`），ko／ja 譯文請母語者校閱。
