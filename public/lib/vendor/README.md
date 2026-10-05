# 第三方程式（照原樣放在站台上，不從 CDN 載）

| 檔案 | 來源 | 授權 | 用途 |
|---|---|---|---|
| `heic2any.min.js` | [heic2any 0.0.4](https://www.npmjs.com/package/heic2any)（`dist/heic2any.min.js`，未修改） | MIT © Alex Corvi；內含編譯過的 [libheif](https://github.com/strukturag/libheif)（LGPL-3.0，原始碼見連結） | 後台：瀏覽器解不開的 HEIC 照片（iPhone／iPad 拍的）先轉成 JPEG 再上傳。第一次遇到 HEIC 才載（約 1.3 MB）。 |

放在站台上而不是 CDN：測試（沒有對外網路）也跑得到，也不多一個外部網域。
要換版本就換檔、改這張表；不要手改檔案內容。
