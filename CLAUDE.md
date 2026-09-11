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
3. 目標 **< 30 MB**，放進 `assets/master/`

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

### 建議的 v1 切法：web 出規格，CLI 出檔案

```
Web app（Netlify）           產出 visit spec（JSON）：選哪些頁、議程時間、語言、標題
        ↓
CLI（同 repo，本機 node）     讀 spec ＋ slim master → 產出 pptx
```

理由：pptx 子集化要解壓幾十 MB、改檔、重壓，塞進 Netlify Function 會撞逾時與記憶體。
v1 先讓網頁決定「要什麼」，本機一行指令產檔，穩定且零限制。
v2 若要全自動，改用 **Netlify Background Function**（15 分鐘上限）或外部小服務，不要用一般 function。

```bash
npm run deck -- --visit=2026-10-07-uwa      # 讀 data/visits/*.json，輸出 dist/
```

### 前端沿用既有慣例

單檔 HTML、Tailwind CDN、無建置步驟，與 healsdesign.org 系列一致。兩個頁面：

- `admin.html` — 主辦端：貼 email、確認抽取結果、排議程、選頁、產 spec、寄訪後信
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
| 305 | 304 外部空間，IVR 研究 | 鄭佳昆 Chia-Kuen Cheng |

> 本系統所有標示（老師卡片、選頁區塊標題、負責人索引、提示詞）**303 只列陳惠美**（明確指示）。母簡報投影片裡的文字本系統不改寫。

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

### 2. 客製化雙語簡報

輸入 = 訪客背景 ＋ 可用分鐘數 ＋ 對方語言。輸出 = spec JSON ＋ pptx。

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
  想合作哪幾間（301–305 複選）、希望我們做什麼、**開放建議欄位**
- **開放建議欄位的措辭必須是請益語氣，不是滿意度語氣**：
  「以您的專業，中心哪一部分還可以做得更好？」／
  "From your perspective, what should we be doing better?"
  並加一句「一句話就好」，且**可不具名送出**
- **簽名簿**：實體本子，主持人拍照上傳，AI 讀手寫字歸檔（原圖保留）
- **主持人三十秒口述**：參訪結束後由主持人口述，Whisper 轉文字後抽取
  （誰來、最想看哪一間、問了什麼、有無合作意願）。依議程結束時間推播提醒
- **動線訊號**：老師開簡報的捷徑、門口 NFC 貼紙、排程推補三者擇有

### 4. 長期檔案與回饋下一次簡報

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
4. 隨行名單聯絡方式拿不到時的備案
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

- `public/admin.html`：訪前（貼信或上傳名單檔抽取 → 確認 → 排行程選頁 → 儲存 → QR／spec／.ics／確認信）、收工（簽名簿照片讀字、三十秒口述錄音轉文字抽取、或打字）、訪後信（草擬、全名單收件人、寄出或 mailto）、資料（列表、回覆、動線、摘要、跨場次彙整、CSV）。
- `public/index.html`：專屬網址 `/<visit_id>`；流程、五間老師卡片（303 只列陳惠美）、留信箱、備援按鍵，最後是三個回應項目（請益措辭、一句話就好、真匿名）。
- `netlify/functions/*.mts`：`visits` `extract` `plan` `letter` `respond` `timeline` `signbook` `transcribe` `summary` `media`；共用在 `netlify/lib/`（store／ai／http／data／types／files）。`extract` 接受上傳檔：.docx／.xlsx／.pptx／.csv／.txt 在 `files.mts` 轉純文字（UTF-8 失敗退 Big5），PDF 與照片以 document／image block 直接交給 Claude；.doc／.xls 不支援。
- 資料層 `netlify/lib/store.mts`：`file`（本機）、`blobs`（Netlify 預設）、`sheets`（Google Sheet，服務帳戶）。真匿名在 `lib/visit.mjs sanitizeResponse`：不具名時姓名、email 清空、時間只留日期，後端不補回。
- `cli/deck.mjs` ＋ `cli/lib/pptx.mjs`：母簡報子集化（選頁重排、複製頁、逐字取代、流程表填值、第二語言換字、QR 頁、清孤兒、驗證、PDF）。`--inspect`、`--dump`、`--validate`。
- `scripts/slim-master.py`：抽影片成海報＋連結、縮圖、清媒體。`scripts/make-shortcuts.mjs`：研究室電腦捷徑與 NFC 網址。
- 測試：`npm test`（單元、API 走本機 dev server、產檔與瘦身走合成簡報）、`npm run test:e2e`（Chromium）。`AI_MOCK=1` 讓所有 AI 呼叫回固定範例。CI：`.github/workflows/ci.yml` 在每個 PR 與 main 的 push 跑同一套（typecheck → npm test → e2e）。

**尚未在真實環境驗證（首次建置時沒有金鑰與母簡報）**

- Claude API 的真實輸出（抽取、排程、信件、簽名簿讀字、摘要）——結構化輸出用 zod schema 綁住，但提示詞品質要用真信件調。
- Whisper、Gmail API、Google Sheets 後端、Netlify Blobs——都照官方 API 寫，沒有實際呼叫過。
- 真母簡報：`slim-master.py` 與 `deck` 只在 `scripts/make-fixture.py` 的合成簡報上測過。真檔的第 2 頁若不是表格，流程要靠 `text_edits`；先 `--dump` 再 commit `data/master-text.json`。
- PDF 輸出：沙箱裡 LibreOffice 不完整，沒跑到；本機有 LibreOffice 即可。

**約定**

- API 路徑 `/api/<name>` 由 `netlify.toml` 轉到 `/.netlify/functions/<name>`；函式不設 `config.path`。
- 主辦端 API 用 `Authorization: Bearer ADMIN_TOKEN`；現場訊號用 `SIGNAL_KEY`；`respond` 與 `visits?public=1` 公開。
- 老師卡片內容 `public/data/labs.json` 的 `confirmed=false` 表示尚待老師確認；照片 `photo` 為 null 時顯示縮寫。
- **現場動線第一站固定是總體介紹**：`itinerary[0].room === "briefing"`（可填 `location`，例如 304），之後才是 301–305；`lib/visit.mjs ensureBriefingFirst` 在存檔與排程時強制。現場訊號 `room=briefing` 代表簡報室（開總體簡報＝整場起點）。
- 今日流程固定含三個區塊：總體簡報（briefing）→ 研究室參訪（tour）→ **綜合討論（discussion，至少 10 分鐘）**，合照可省略；`plan.mts` 在 AI 漏掉綜合討論時自動補上並回傳 `warnings`。
- 後台「選用頁次」依 `public/data/slides.json` 的 `groups` 分區塊（章節／研究室）：區塊方框整區選、「只選這區」、全選／全不選；必選頁永遠保留。每一頁必須恰好屬於一個區塊。
- 開放建議欄位措辭在 `public/data/i18n.json`（`ask_better`、`one_sentence`、`anonymous`），ko／ja 譯文請母語者校閱。
