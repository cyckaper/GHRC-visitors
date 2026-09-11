# slim master（選用的靜態放法）

母簡報放上站台有兩種方式：

1. **後台「上傳母簡報 .pptx」**（建議）：存檔後的區塊裡按一次即可，可以直接選 396 MB 的原始母簡報——瀏覽器會先瘦身（抽影片留海報、大圖縮到 2000px），再切成 4 MB 分塊存進 Netlify Blobs（`/api/master`，要 ADMIN_TOKEN，不公開），之後「產生簡報」直接抓。不必進 git。
2. 把瘦身後的檔 commit 到這裡：`public/assets/master/slim-master.pptx`（目標 < 30 MB）。這個目錄由 Netlify 公開發佈，知道網址的人都能下載。

瘦身：`python3 scripts/slim-master.py <396MB母檔.pptx>`（抽影片成海報＋連結、縮圖、清媒體），或直接在 PowerPoint 刪掉五支影片、「壓縮圖片」後另存。
換新版母簡報時同步更新 `public/data/slides.json` 的頁次索引，並執行 `npm run deck -- --dump` 更新 `data/master-text.json`。
