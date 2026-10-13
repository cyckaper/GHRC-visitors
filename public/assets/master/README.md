# 母簡報（網頁版簡報 `/deck` 從這裡建）

`master.pptx` 就是現行的母簡報。`scripts/web-deck/source.json` 的 `source: "repo"` 指到它，
GitHub Actions（`.github/workflows/web-deck.yml`）直接從 repo 讀，不必上傳 Drive、開分享、記得丟垃圾桶。

**換一版母簡報**：把 `master.pptx` 換掉、`scripts/web-deck/source.json` 的 `title` 改成新的檔名，
**兩個一起 commit** 推上去，Actions 會自己重建、自己把 `public/data/deck.json` 與每一頁的圖 commit 回來。
指紋把 `master.pptx` 的內容也算進去（`scripts/web-deck/needs-build.mjs`），所以 `run` 不必動——
`run` 只在「檔案沒變、但要原地重跑一次」時加一。

**放進來之前要先處理兩件事：**

1. **講稿拿掉。** 講稿裡有上一場來賓的名字與整份導覽腳本，而 `public/` 由 Netlify 公開發佈，
   等於知道網址的人都載得到。（`cli/lib/pptx.mjs` 的 `dropNotes` 只拿掉網頁版那一份，不動原檔。）
2. **影片抽掉、大圖縮一縮。** GitHub 一個檔超過 50 MB 會警告、100 MB 直接擋下；
   `python3 scripts/slim-master.py <原始母檔.pptx>` 會抽影片成海報＋連結、把超過 3 MB 的圖縮到 2000px。
   目標 **30 MB 上下**。

原始的、含講稿與影片的母簡報留在 Drive 當備份，**不要**開分享。

---

舊的做法留著備用：`source.json` 改成 `source: "drive"` ＋ `drive_id`（母簡報複本的 ID，
開成「知道連結的任何人都能檢視」，建好就把複本丟到垃圾桶）。2026-10 之前都是這樣跑的。

每場產 .pptx 的那一套（後台「上傳母簡報」存進 Netlify Blobs）已經停用，見 CLAUDE.md。
