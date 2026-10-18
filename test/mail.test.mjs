import test from "node:test";
import assert from "node:assert/strict";
import { buildMime } from "../netlify/lib/mail.mts";

test("感謝信的照片直接附在信裡：multipart/mixed，內文一段、照片一張一段（base64 每 76 個字換行）", () => {
  const jpg = new Uint8Array(300).map((_, i) => i % 256);
  const mime = buildMime({
    from: "ghrc@example.test",
    to: "simon@uwa.edu.au",
    subject: "感謝蒞臨綠色健康研究中心",
    text: "Dear Simon,\n謝謝您的來訪。",
    attachments: [
      { filename: "IMG_8466.jpeg", contentType: "image/jpeg", bytes: jpg },
      { filename: "合照.jpg", contentType: "image/jpeg", bytes: jpg },
    ],
    boundary: "B",
  });
  assert.match(mime, /^From: ghrc@example\.test\r\nTo: simon@uwa\.edu\.au\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nMIME-Version: 1\.0\r\n/);
  assert.match(mime, /\r\nContent-Type: multipart\/mixed; boundary="B"\r\n/);
  assert.equal(mime.split("\r\n--B\r\n").length - 1, 3, "內文一段、兩張照片各一段");
  assert.ok(mime.trimEnd().endsWith("\r\n--B--"), "最後收尾");
  assert.match(mime, /Content-Type: image\/jpeg; name="IMG_8466\.jpeg"\r\nContent-Disposition: attachment; filename="IMG_8466\.jpeg"\r\n/);
  assert.match(mime, /filename="photo-2\.jpg"; filename\*=UTF-8''%E5%90%88%E7%85%A7\.jpg/, "中文檔名：RFC 2231 寫一份，舊的收信程式看英數字那一個");
  assert.ok(mime.split("\r\n").every((line) => line.length <= 76 || !/^[A-Za-z0-9+/=]+$/.test(line)), "base64 每 76 個字換行");
  assert.ok(mime.split("\r\n").every((line) => line.length <= 998), "沒有超過 998 字的長行（RFC 5322）");
  // 解得回原本的內文與照片
  const parts = mime.split("\r\n--B");
  const decode = (part) => Buffer.from(part.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64");
  assert.equal(decode(parts[1]).toString("utf8"), "Dear Simon,\n謝謝您的來訪。");
  assert.deepEqual(new Uint8Array(decode(parts[2])), jpg);
  assert.deepEqual(new Uint8Array(decode(parts[3])), jpg);
});

test("沒有附件的信跟以前一樣：一段 text/plain；不知道寄件人就不寫 From", () => {
  const plain = buildMime({ to: "a@example.test", subject: "Hello", text: "x" });
  assert.equal(plain, ["To: a@example.test", "Subject: Hello", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", "eA=="].join("\r\n"));
});
