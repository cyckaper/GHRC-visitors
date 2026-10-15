# 第三方程式（照原樣放在站台上，不從 CDN 載）

| 檔案 | 來源 | 授權 | 用途 |
|---|---|---|---|
| `heic-to.js` | [heic-to 1.6.5](https://www.npmjs.com/package/heic-to)（`dist/csp/heic-to.js`，未修改；sha256 `7b5a085d33318ab708c7d70f753b1aec9068004c77b2c3f360b426bfb793b8b6`） | LGPL-3.0（[hoppergee/heic-to](https://github.com/hoppergee/heic-to)）；內含編譯成 JavaScript 的 [libheif](https://github.com/strukturag/libheif) 1.23.5 與 [libde265](https://github.com/strukturag/libde265)（皆 LGPL-3.0，原始碼見連結） | 後台：瀏覽器看不懂的 HEIC 照片（iPhone／iPad 拍的）先轉成 JPEG 再上傳。ES module（`import("/lib/vendor/heic-to.js")`），第一次遇到 HEIC 才載（約 3 MB，傳輸壓縮後約 0.8 MB）。沒有 .wasm 檔、不用 eval。 |

| `qrcode-generator.js` | [qrcode-generator 2.0.4](https://www.npmjs.com/package/qrcode-generator)（`dist/qrcode.js`，未修改；sha256 `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c`） | MIT（Kazuhiko Arase，[kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)） | 歡迎海報（`poster.html`）上的 QR：畫成 SVG，A1 印出來也是向量。一般 `<script>`，全域 `qrcode(type, level)`。 |

放在站台上而不是 CDN：測試（沒有對外網路）也跑得到，也不多一個外部網域。
要換版本就換檔、改這張表（版本、sha256、內含的 libheif 版本）；不要手改檔案內容。

以前放的是 heic2any 0.0.4（2023 年最後一版，內含 2020 年的 libheif 1.10.0）。2026-10 換掉，因為實際拿各代 iPhone 的照片測過：
iOS 18 之後的照片轉不了（ERR_LIBHEIF format not supported），10-bit 的轉出來是一片雜訊、不報錯，之後同一頁再轉別張也會壞掉。
