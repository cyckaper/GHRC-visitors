# GHRC 參訪系統 · ghrc-visit

臺大生農學院綠色健康研究中心（GHRC）的參訪閉環：**訪前準備 → 客製簡報 → 訪後回饋 → 長期檔案 → 回饋下一次簡報**。
構想與否決清單見 `docs/工作包.md`；開發規範見 `CLAUDE.md`；部署與設定見 `docs/DEPLOY.md`。

## 一次參訪怎麼跑

| 階段 | 誰 | 做什麼 | 在哪 |
|---|---|---|---|
| 訪前 | 承辦 | 貼上 email 往來、或上傳名單檔（Word／Excel／CSV／PDF／照片）→ AI 抽出單位、名單（含隨行者 email）、目的、興趣 → 確認 → AI 排行程、選頁 → 儲存 → 拿到專屬網址與 QR、確認信草稿、收工提醒 .ics | `admin.html`「訪前」 |
| 訪前 | 承辦 | 產出當次簡報：`npm run deck -- --visit=<visit_id>` | 本機 CLI |
| 現場 | 老師／主持人 | 開簡報的桌面捷徑、門口 NFC 貼紙自動送動線訊號；總體簡報最後一頁問「您最想看哪一部分」 | `scripts/make-shortcuts.mjs` |
| 收工 | 主持人 | 拍一張簽名簿（AI 讀字）＋ 三十秒口述（轉文字、抽取），一分鐘 | `admin.html`「收工」（.ics 提醒直達） |
| 訪後 | 承辦 | AI 草擬感謝信 → 寄給**名單上每一個人**；信裡三個回應項目（含請益語氣的開放建議欄位，可**真匿名**） | `admin.html`「訪後信」→ 來賓端 `#respond` |
| 長期 | 中心 | 一頁摘要、跨場次建議彙整、CSV 匯出、slide_performance | `admin.html`「資料」 |

## 目錄

```
public/            單檔 HTML（Tailwind CDN，無建置）：index.html 來賓端、admin.html 主辦端、data/*.json
netlify/functions/ API（.mts）：visits extract plan letter respond timeline signbook transcribe summary media
netlify/lib/       函式共用：store（file／blobs／sheets）、ai（Claude、Whisper、mock）、http、data、types
lib/               純 JS 共用：visit（id、匿名化、寄送清單、ICS）、timeline（動線推補）
cli/               npm run deck：母簡報子集化 → pptx（＋PDF）
scripts/           slim-master.py（母簡報瘦身）、make-shortcuts.mjs（現場捷徑）、make-fixture.py（測試用合成簡報）、dev-server.mjs
data/visits/       產檔用 spec（後台「下載 spec JSON」放這裡）；data/master-text.json 由 --dump 產生
assets/master/     slim-master.pptx（< 30 MB；不進 git，見 CLAUDE.md）
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
python3 scripts/slim-master.py "GHRC 介紹簡報2026-9.pptx" --out assets/master/slim-master.pptx \
    --video-link 19=https://… --video-link 35=https://… --video-link 37=https://… --video-link 38=https://… --video-link 52=https://…
npm run deck -- --inspect       # 看每一頁的標題與媒體
npm run deck -- --dump          # 寫 data/master-text.json（讓 /api/plan 產生第 1–3 頁的替換文字）→ commit
npm run deck -- --visit=2026-10-07-uwa      # dist/2026-10-07-uwa.pptx ＋ .pdf ＋ .txt ＋ .report.json
```

## 不做的事

見 `CLAUDE.md`「不要做的事」：不從零生成簡報、不錄來賓的音、不分級、不放滿意度按鍵、不用傳統問卷、不用顧客語氣。
