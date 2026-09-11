# slim master

把瘦身後的母簡報放在這裡：`public/assets/master/slim-master.pptx`（目標 < 30 MB，由 `python3 scripts/slim-master.py <396MB母檔.pptx>` 產出）。

- 後台「產生簡報 .pptx」會直接從這個網址抓母簡報，在瀏覽器裡子集化後下載；沒有這個檔時，後台會請你從電腦選一份 slim master。
- 這個目錄由 Netlify 公開發佈：知道網址的人都能下載母簡報（內容與現場給來賓看的相同）。原始 396 MB 母檔仍留在 Drive，不進 repo。
- 換新版母簡報時同步更新 `public/data/slides.json` 的頁次索引，並執行 `npm run deck -- --dump` 更新 `data/master-text.json`。
