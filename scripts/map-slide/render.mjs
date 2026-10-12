/**
 * 把「訪客來自哪裡」那張世界地圖畫成一張圖，給母簡報的地圖頁用。
 *
 * 為什麼要這一支：`/deck` 的地圖頁是**活的**（deck.html 直接掛 /lib/worldmap.mjs，資料一變它就變），
 * 但 .pptx 裡只能放圖。所以同一份資料、同一支畫法（public/lib/worldmap.mjs），在這裡用無頭瀏覽器畫成 PNG，
 * 再由 scripts/map-slide/insert.py 換進母簡報那一頁。**兩邊長得一樣**，不會各畫各的。
 *
 * 用法：
 *   node scripts/map-slide/render.mjs --out=/tmp/map.png                    # 線上資料（/api/visitor-map）
 *   node scripts/map-slide/render.mjs --out=/tmp/map.png --data=visitor-map.json   # 離線：先存下來的那一份
 *   選項：--lang=en|zh（點旁邊的名稱，預設 en——簡報以英文為主）、--width=1660（CSS 寬度）、--scale=3（每 CSS 像素幾個實體像素）
 *         --site=https://visit.healsdesign.org（線上資料從哪裡拿）
 *
 * 另外吐一份 <out>.json：國家數、單位數、場次合計，與地圖在圖裡的位置——insert.py 拿去寫那一行數字。
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const OUT = path.resolve(arg("out", path.join(ROOT, "map.png")));
const LANG = arg("lang", "en") === "zh" ? "zh" : "en";
const WIDTH = Number(arg("width", 1660));
const SCALE = Number(arg("scale", 3));
const SITE = String(arg("site", "https://visit.healsdesign.org")).replace(/\/+$/, "");
const DATA = arg("data", "");

const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** 站台的 public/ 就地起一個小伺服器：worldmap.mjs 是 ES module，file:// 載不了，而 world.json 它寫死用 /data/world.json。 */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(PUBLIC, decodeURIComponent(req.url.split("?")[0]));
      if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function institutions() {
  if (DATA) return JSON.parse(fs.readFileSync(path.resolve(DATA), "utf8")).institutions || [];
  const r = await fetch(`${SITE}/api/visitor-map`);
  if (!r.ok) throw new Error(`/api/visitor-map ${r.status}`);
  return (await r.json()).institutions || [];
}

const { srv, port } = await serve();
const list = await institutions();
if (!list.length) { console.error("沒有任何單位，不產圖"); srv.close(); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.ceil(WIDTH) + 80, height: 900 }, deviceScaleFactor: SCALE });
await page.goto(`http://127.0.0.1:${port}/lib/worldmap.mjs`, { waitUntil: "domcontentloaded" }); // 先進同一個 origin
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  #wrap{width:${WIDTH}px;font-family:"Noto Sans CJK TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;--wm-dot:#0f766e}
</style><div id="wrap"></div>`);

const stats = await page.evaluate(async ({ list, lang, origin }) => {
  const W = await import(`${origin}/lib/worldmap.mjs`);
  const world = await W.loadWorld();
  const by = new Map();
  let dropped = 0;
  for (const it of list) {
    const at = W.placeOf(world, { country: it.country, geo: it.geo });
    if (!at) { dropped += 1; continue; } // 國名對不到、也還沒查到位置：跟公開頁一樣先不畫
    const key = `${W.normCountry(it.name)}|${W.normCountry(at.country)}`;
    const p = by.get(key) || { key, name: it.name, local: it.local || "", country: at.country, place: at.place, approx: at.approx, x: at.x, y: at.y, n: 0 };
    p.n += Number(it.visits) || 1;
    by.set(key, p);
  }
  const points = [...by.values()];
  const nameOf = (p) => (lang === "zh" && /[一-鿿]/.test(p.local) ? p.local : p.name);
  // 這張圖比網頁上的地圖寬得多，名稱放得下長一點（預設 15 個字寬在這裡會變成滿頁的「University of…」）
  const map = W.mountWorldMap(document.getElementById("wrap"), world, { ariaLabel: "", labelWidth: lang === "zh" ? 16 : 30 });
  map.setPoints(points.map((p) => ({ ...p, label: nameOf(p), title: nameOf(p) })));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    countries: new Set(points.map((p) => p.country)).size,
    institutions: points.length,
    visits: points.reduce((s, p) => s + p.n, 0),
    dropped,
  };
}, { list, lang: LANG, origin: `http://127.0.0.1:${port}` });

await page.waitForTimeout(250); // 細海岸線不會在整張世界地圖時載，這裡只是讓字排完
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const box = await page.locator("#wrap svg").boundingBox();
await page.locator("#wrap svg").screenshot({ path: OUT, scale: "device" });
await browser.close();
srv.close();

const meta = { ...stats, lang: LANG, width: Math.round(box.width), height: Math.round(box.height), aspect: box.width / box.height, built_at: new Date().toISOString(), source: DATA ? path.resolve(DATA) : `${SITE}/api/visitor-map` };
fs.writeFileSync(`${OUT}.json`, `${JSON.stringify(meta, null, 1)}\n`);
console.log(`${OUT}  ${meta.institutions} 個單位 · ${meta.countries} 個國家 · ${meta.visits} 場${meta.dropped ? `（${meta.dropped} 個還沒有位置，沒畫）` : ""}`);
