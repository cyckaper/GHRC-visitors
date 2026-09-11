#!/usr/bin/env node
/**
 * 產生現場訊號用的捷徑（工作包 4.2 訊號一「老師開簡報」、訊號二「主持人 NFC」）。
 *
 *   node scripts/make-shortcuts.mjs --site=https://visit.healsdesign.org --key=<SIGNAL_KEY> [--deck="C:\GHRC\today.pptx"] [--out=dist/shortcuts]
 *
 * 輸出：
 *   dist/shortcuts/<room>/今日參訪.bat        Windows：先送訊號再開簡報（桌面捷徑指到這個檔）
 *   dist/shortcuts/<room>/今日參訪.command    macOS：同上
 *   dist/shortcuts/<room>/signal.url         只送訊號的網址（NFC 貼紙／iPhone 捷徑用）
 *   dist/shortcuts/README.md                 iPhone「捷徑」自動化的設定步驟
 */
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const site = String(args.site || process.env.SITE_URL || "https://visit.healsdesign.org").replace(/\/$/, "");
const key = String(args.key || process.env.SIGNAL_KEY || "");
if (!key) { console.error("需要 --key=<SIGNAL_KEY>（與 Netlify 環境變數相同）"); process.exit(2); }
const deck = String(args.deck || "");
const out = path.resolve(String(args.out || "dist/shortcuts"));
const ROOMS = ["briefing", "301", "302", "303", "304", "305"]; // briefing = 總體介紹的簡報室電腦：開總體簡報就是整場的起點訊號
const LABEL = { briefing: "總體介紹（簡報室）", "301": "Lab 301", "302": "Lab 302", "303": "Lab 303", "304": "Lab 304", "305": "Lab 305" };

for (const room of ROOMS) {
  const dir = path.join(out, room);
  await fs.mkdir(dir, { recursive: true });
  const url = `${site}/api/timeline?room=${room}&source=presentation&key=${encodeURIComponent(key)}`;
  const nfc = `${site}/api/timeline?room=${room}&source=nfc&key=${encodeURIComponent(key)}`;
  await fs.writeFile(path.join(dir, "今日參訪.bat"), [
    "@echo off",
    `rem GHRC 參訪：${LABEL[room]} 開簡報就記時（訊號一）。桌面放這個檔的捷徑。`,
    `curl -s -m 5 "${url}" >nul 2>&1`,
    deck ? `start "" "${deck}"` : `rem 把當天簡報路徑填在下一行，例如 start "" "C:\\GHRC\\today.pptx"`,
    deck ? "" : `rem start "" "C:\\GHRC\\today.pptx"`,
  ].join("\r\n"));
  await fs.writeFile(path.join(dir, "今日參訪.command"), [
    "#!/bin/bash",
    `# GHRC 參訪：${LABEL[room]} 開簡報就記時（訊號一）。`,
    `curl -s -m 5 "${url}" >/dev/null 2>&1 &`,
    deck ? `open "${deck}"` : `# open "/Users/you/GHRC/today.pptx"`,
  ].join("\n"), { mode: 0o755 });
  await fs.writeFile(path.join(dir, "signal.url"), `${nfc}\n`);
}

await fs.writeFile(path.join(out, "README.md"), `# 現場訊號捷徑

站台：${site}

## 訊號一｜老師開簡報（研究室電腦）

簡報室電腦（\`briefing/\`，總體介紹是動線的第一站）與每間研究室電腦桌面各放一個「今日參訪」捷徑，指到 \`<房號>/今日參訪.bat\`（Windows）或 \`今日參訪.command\`（macOS）。
老師從那裡點開簡報，捷徑先在背景送一個訊號（一秒），再開簡報。把 .bat／.command 裡的簡報路徑改成當天的檔案。

## 訊號二｜主持人進門碰 NFC 貼紙（iPhone）

簡報室與五間研究室門口各貼一片 NFC 貼紙（NTAG213 即可），簡報室那片用 \`briefing/signal.url\`。在 iPhone「捷徑」App：

1. 自動化 → 新增自動化 → NFC → 掃描貼紙並命名（例如 Lab 303）→ 立即執行（關閉「執行前先詢問」）
2. 動作：「取得 URL 內容」，URL 填該房間的 \`signal.url\` 內容：
   \`${site}/api/timeline?room=303&source=nfc&key=…\`
   方法 GET 即可（或 POST，JSON body \`{"room":"303","source":"nfc","key":"…"}\`）
3. 不加任何顯示動作，碰一下就送出，螢幕不用亮。

訊號不用帶 visit_id：伺服器會對到「今天」排定的參訪；今天沒有排定就回 404、不記錄。

## 備援

- 研究生代按：同一個網址，\`source=student\`
- 來賓自己按：來賓端專頁最下面的「我現在在哪一間」，不需要金鑰

## 安全

網址裡的 key 就是 SIGNAL_KEY，只能記錄動線時間，不能讀任何資料。外洩就到 Netlify 換一個新的並重做貼紙。
`);
console.log(`已產生 ${out}/{${ROOMS.join(",")}}/ 與 README.md`);
