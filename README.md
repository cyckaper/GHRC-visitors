# GHRC 參訪系統 · ghrc-visit

[![CI](https://github.com/cyckaper/GHRC-visitors/actions/workflows/ci.yml/badge.svg)](https://github.com/cyckaper/GHRC-visitors/actions/workflows/ci.yml)

臺大生農學院綠色健康研究中心（GHRC）的參訪閉環：**訪前準備 → 客製簡報 → 訪後回饋 → 長期檔案 → 回饋下一次簡報**。
構想與否決清單見 `docs/工作包.md`；開發規範見 `CLAUDE.md`；部署與設定見 `docs/DEPLOY.md`。

## 一次參訪怎麼跑

| 階段 | 誰 | 做什麼 | 在哪 |
|---|---|---|---|
| 訪前 | 承辦 | 貼上 email 往來、或上傳名單檔（Word／Excel／CSV／PDF／照片）→ AI 抽出單位、名單（含隨行者 email）、目的、興趣 → 確認 → **AI 查訪客背景**（網路上的公開資料 → 可能的參訪目的、可能最想看哪幾間、可以先準備什麼）→ AI 排行程（總體介紹在 302）→ 儲存 → 拿到專屬網址與 QR、確認信草稿、收工提醒 .ics | `admin.html`「訪前」 |
| 簡報 | 承辦 | 選用頁次 →「產生簡報 .pptx」直接下載當次簡報（瀏覽器裡子集化母簡報；韓／日文版自動翻譯）。**有些參訪不用簡報，只口頭介紹**：勾「這場不用簡報」就整個跳過。母簡報第一次用「上傳母簡報」放上站台即可。備援：`npm run deck -- --visit=<visit_id>`（可另出 PDF） | `admin.html`「簡報」／本機 CLI |
| 現場 | 老師／主持人 | 開簡報的桌面捷徑、門口 NFC 貼紙自動送動線訊號；總體簡報最後一頁問「您最想看哪一部分」 | `scripts/make-shortcuts.mjs` |
| 收工 | 主持人 | 拍一張簽名簿（AI 讀字）＋ 三十秒口述（轉文字、抽取），一分鐘；再把簡報 PDF、合照、相關連結放上專屬頁面 | `admin.html`「收工」（.ics 提醒直達） |
| 現場 | 承辦 | 拿到名片就拍一張 → AI 讀出姓名／職稱／單位／email／電話 → 確認後併進這場的名單（訪後信就寄得到他）；原圖留著可回頭核對 | `admin.html`「資料」 |
| 訪後 | 承辦 | AI 草擬感謝信 → 寄給**名單上每一個人**；信裡三個回應項目（含請益語氣的開放建議欄位，可**真匿名**） | `admin.html`「訪後信」→ 來賓端 `#respond` |
| 長期 | 中心 | 一頁摘要、跨場次建議彙整、CSV 匯出、slide_performance；**每場自動備份到中心的 Google Drive**（資料有變動就同步，另有每晚補漏） | `admin.html`「資料」 |

## 目錄

```
public/            單檔 HTML（Tailwind CDN，無建置）：index.html 來賓端、admin.html 主辦端、data/*.json
public/lib/        pptx.mjs：母簡報子集化核心（瀏覽器與 CLI 共用，零 Node 相依）
public/assets/master/  （選用）slim-master.pptx 靜態檔；平常改用後台「上傳母簡報」存進 Blobs，不必進 git
netlify/functions/ API（.mts）：visits extract plan letter respond timeline signbook cards transcribe summary media materials translate master session drive
                   跑得久的 AI 走背景函式（一般函式只有 10 秒）：extract-background research-background；另有 drive-sync-background drive-cron
netlify/lib/       函式共用：store（file／blobs／sheets）、ai（Claude、Whisper、mock）、http、data、types、jobs（背景工作）
lib/               純 JS 共用：visit（id、匿名化、寄送清單、ICS）、timeline（動線推補）
cli/               npm run deck：同一份核心的本機入口 → pptx（＋PDF）
scripts/           slim-master.py（母簡報瘦身）、make-shortcuts.mjs（現場捷徑）、make-fixture.py（測試用合成簡報）、dev-server.mjs
data/visits/       CLI 備援產檔用的參訪 JSON（`/api/visits?id=…` 的 visit 物件）；data/master-text.json 由 --dump 產生
test/              node:test 單元／API 測試、deck 與 slim 測試、Playwright 冒煙測試
```

## 本機開發

```bash
npm install
cp .env.example .env            # 填 ANTHROPIC_API_KEY、ADMIN_TOKEN、SIGNAL_KEY；沒有金鑰就設 AI_MOCK=1
set -a; . ./.env; set +a
npm run dev                     # http://localhost:8888  （admin.html 用 ADMIN_TOKEN 登入）
```

```bash
npm test                        # 單元 + API + 產檔／瘦身（後兩者需要 python3 + python-pptx + Pillow）
npm run test:e2e                # Chromium 冒煙測試（需要 playwright）
npm run typecheck
```

## 母簡報與產檔

```bash
pip install python-pptx Pillow
python3 scripts/slim-master.py "GHRC 介紹簡報2026-9.pptx" --out public/assets/master/slim-master.pptx \
    --video-link 19=https://… --video-link 35=https://… --video-link 37=https://… --video-link 38=https://… --video-link 52=https://…
npm run deck -- --inspect       # 看每一頁的標題與媒體
npm run deck -- --dump          # 寫 data/master-text.json（讓 /api/plan 產生第 1–3 頁的替換文字）→ commit
npm run deck -- --visit=2026-10-07-uwa      # 備援：dist/2026-10-07-uwa.pptx ＋ .pdf ＋ .txt ＋ .report.json（平常直接在後台按「產生簡報 .pptx」）
```

## 不做的事

見 `CLAUDE.md`「不要做的事」：不從零生成簡報、不錄來賓的音、不分級、不放滿意度按鍵、不用傳統問卷、不用顧客語氣。
