/**
 * 掃出後台畫面上所有中文字串，對照 public/data/i18n-admin.json 看哪些還沒有英文。
 *
 *   node scripts/i18n-scan.mjs            # 列出還沒翻的（有漏就 exit 1）
 *   node scripts/i18n-scan.mjs --all      # 列出全部掃到的字串
 *   node scripts/i18n-scan.mjs --stub     # 印出缺的那些的 JSON 骨架，貼進 i18n-admin.json
 *
 * 後台是**中文寫在 HTML 裡**、英文是疊上去的一層（見 admin.html 的 i18n 區塊）：
 * 翻譯表的鍵就是畫面上那一句中文，所以這支只要把中文撈出來比對就好，不必發明 key。
 * 中文改了、英文沒跟著改，這支（跟著 npm test 跑）就會報。
 */
import { readFileSync } from "node:fs";

const CJK = /[一-鿿]/;
const ADMIN = "public/admin.html";
const DICT = "public/data/i18n-admin.json";

/** 靜態 HTML 裡的文字節點與 title／placeholder／aria-label。 */
export function scanAdmin(html = readFileSync(ADMIN, "utf8")) {
  const body = html.slice(html.indexOf("<body"));
  const markup = body.slice(0, body.indexOf("<script>"));
  const out = new Set();
  // 文字節點：把標籤切掉，剩下的就是畫面上的字
  for (const raw of markup.split(/<[^>]+>/)) {
    const t = collapse(raw);
    if (t && CJK.test(t)) out.add(t);
  }
  // 提示文字（滑鼠停著會出現的那一行）也要翻
  for (const m of markup.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)) {
    const t = collapse(m[1]);
    if (t && CJK.test(t)) out.add(t);
  }
  return [...out];
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

export function loadDict(file = DICT) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  return { strings: d.strings || {}, patterns: d.patterns || [] };
}

/** 掃到但表裡沒有的（或翻成空字串的）。 */
export function missing(strings = scanAdmin(), dict = loadDict()) {
  return strings.filter((s) => !dict.strings[s]);
}

if (process.argv[1] && process.argv[1].endsWith("i18n-scan.mjs")) {
  const strings = scanAdmin();
  if (process.argv.includes("--all")) {
    for (const s of strings) console.log(s);
  } else {
    const gaps = missing(strings);
    if (process.argv.includes("--stub")) console.log(JSON.stringify(Object.fromEntries(gaps.map((s) => [s, ""])), null, 2));
    else for (const s of gaps) console.log(s);
    console.error(`${strings.length} 條中文，${gaps.length} 條還沒有英文`);
    process.exit(gaps.length ? 1 : 0);
  }
}
