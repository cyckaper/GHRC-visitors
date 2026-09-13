/**
 * 產生 public/data/world.json：世界地圖的陸地輪廓 ＋ 每個國家的落點（後台「資料」分頁畫訪客地圖用）。
 *
 *   npm pack world-atlas@2.0.2 && tar xzf world-atlas-2.0.2.tgz     # 取得原始資料（npm 上拿得到）
 *   node scripts/make-world.mjs package/land-110m.json package/countries-110m.json
 *
 * 資料來源：Natural Earth 1:110m（public domain），經 world-atlas（Michael Bostock, ISC）轉成 TopoJSON。
 * 產出的是已經投影好的座標（等距長方投影，720×360，一度兩個像素），所以前端只要畫，不必再算投影，
 * 也不必為了一張地圖去載一套地圖函式庫（後台是單檔 HTML、沒有建置步驟）。
 */
import { readFile, writeFile } from "node:fs/promises";

const W = 720;
const H = 360;
const px = (lon, lat) => [((lon + 180) * W) / 360, ((90 - lat) * H) / 180];
const r1 = (n) => Math.round(n * 10) / 10;

/** TopoJSON 的弧線是量化過的差分座標，還原成經緯度。 */
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/** 一圈（ring）＝ 幾段弧線接起來；負的索引代表那一段要反過來走。 */
function ring(arcs, indices) {
  const pts = [];
  for (const i of indices) {
    const arc = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
    for (let k = pts.length ? 1 : 0; k < arc.length; k++) pts.push(arc[k]);
  }
  return pts;
}

const polygons = (geom) => (geom.type === "Polygon" ? [geom.arcs] : geom.type === "MultiPolygon" ? geom.arcs : []);

function pathOf(arcs, geometries) {
  const out = [];
  for (const geom of geometries) {
    for (const poly of polygons(geom)) {
      for (const r of poly) {
        const pts = ring(arcs, r).map(([lon, lat]) => px(lon, lat).map(r1));
        if (pts.length < 3) continue;
        let d = `M${pts[0][0]} ${pts[0][1]}`;
        let [lx, ly] = pts[0];
        for (const [x, y] of pts.slice(1)) {
          if (x === lx && y === ly) continue; // 圓整之後重疊的點就不必再畫一次
          // 跨換日線的那一段（俄羅斯東端、吉里巴斯）會從圖的右邊接到左邊，畫成一條橫貫整張圖的線；
          // 那一段不要連，改成抬筆重下（兩邊各自封口，看起來就是正常的島）
          d += (Math.abs(x - lx) > W / 2 ? "M" : "L") + `${x} ${y}`;
          lx = x;
          ly = y;
        }
        out.push(d + "Z");
      }
    }
  }
  return out.join("");
}

/** 跨換日線的那一圈（俄羅斯、斐濟）經度會從 180 跳到 -180，先接回連續的數列再算形心。 */
function unwrap(pts) {
  let prev = pts[0]?.[0] ?? 0;
  return pts.map(([lon, lat]) => {
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    return [lon, lat];
  });
}
const wrapLon = (lon) => (((lon + 180) % 360) + 360) % 360 - 180;

/** 國家的落點：取面積最大的那一圈的形心（俄羅斯、美國那種有離島的才不會標到海上）。 */
function centroid(arcs, geom) {
  let best = null;
  for (const poly of polygons(geom)) {
    const pts = unwrap(ring(arcs, poly[0]));
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const f = x0 * y1 - x1 * y0;
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    a /= 2;
    if (!a) continue;
    const area = Math.abs(a);
    if (!best || area > best.area) best = { area, lon: wrapLon(cx / (6 * a)), lat: cy / (6 * a) };
  }
  return best;
}

// 1:110m 放不下的小地方，手動補幾個常見的（座標是該地大致的經緯度）
const EXTRA = [
  { name: "Singapore", lon: 103.82, lat: 1.35 },
  { name: "Hong Kong", lon: 114.17, lat: 22.32 },
  { name: "Macau", lon: 113.55, lat: 22.2 },
];

// 來信裡的國名寫法千百種：中文、縮寫、正式名稱都對到 Natural Earth 的名字
const ALIASES = {
  台灣: "Taiwan", 臺灣: "Taiwan", 中華民國: "Taiwan", roc: "Taiwan",
  日本: "Japan", 韓國: "South Korea", 南韓: "South Korea", korea: "South Korea", "republic of korea": "South Korea", "korea, south": "South Korea",
  北韓: "North Korea", 中國: "China", 中國大陸: "China", prc: "China", "people's republic of china": "China",
  香港: "Hong Kong", 澳門: "Macau", 新加坡: "Singapore", 馬來西亞: "Malaysia", 泰國: "Thailand", 越南: "Vietnam",
  印尼: "Indonesia", 印度尼西亞: "Indonesia", 菲律賓: "Philippines", 印度: "India", 蒙古: "Mongolia", 尼泊爾: "Nepal",
  美國: "United States of America", usa: "United States of America", us: "United States of America", "u.s.": "United States of America",
  "u.s.a.": "United States of America", "united states": "United States of America", america: "United States of America",
  英國: "United Kingdom", uk: "United Kingdom", britain: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom", scotland: "United Kingdom",
  澳洲: "Australia", 澳大利亞: "Australia", 紐西蘭: "New Zealand", "new zealand": "New Zealand", 加拿大: "Canada",
  德國: "Germany", 法國: "France", 荷蘭: "Netherlands", holland: "Netherlands", 義大利: "Italy", 意大利: "Italy",
  西班牙: "Spain", 葡萄牙: "Portugal", 瑞典: "Sweden", 挪威: "Norway", 丹麥: "Denmark", 芬蘭: "Finland",
  瑞士: "Switzerland", 奧地利: "Austria", 比利時: "Belgium", 波蘭: "Poland", 捷克: "Czechia", 愛爾蘭: "Ireland",
  以色列: "Israel", 土耳其: "Turkey", 南非: "South Africa", 巴西: "Brazil", 墨西哥: "Mexico", 阿根廷: "Argentina",
  智利: "Chile", 沙烏地阿拉伯: "Saudi Arabia", 阿拉伯聯合大公國: "United Arab Emirates", uae: "United Arab Emirates",
  俄羅斯: "Russia", russia: "Russia", "russian federation": "Russia",
};

const [landFile, countriesFile] = process.argv.slice(2);
if (!landFile || !countriesFile) {
  console.error("用法：node scripts/make-world.mjs <land-110m.json> <countries-110m.json>");
  process.exit(1);
}

const landTopo = JSON.parse(await readFile(landFile, "utf8"));
const cTopo = JSON.parse(await readFile(countriesFile, "utf8"));
const land = pathOf(decodeArcs(landTopo), landTopo.objects.land.geometries);

const cArcs = decodeArcs(cTopo);
const countries = [];
for (const geom of cTopo.objects.countries.geometries) {
  const name = geom.properties?.name;
  const c = centroid(cArcs, geom);
  if (!name || !c) continue;
  const [x, y] = px(c.lon, c.lat);
  countries.push({ id: String(geom.id || ""), name, x: r1(x), y: r1(y) });
}
for (const e of EXTRA) {
  if (countries.some((c) => c.name === e.name)) continue;
  const [x, y] = px(e.lon, e.lat);
  countries.push({ id: "", name: e.name, x: r1(x), y: r1(y) });
}
countries.sort((a, b) => a.name.localeCompare(b.name));

// 對不到國名的別名就是寫錯了，當場停下來（不要靜靜地產出一份對不到的資料）
const known = new Set(countries.map((c) => c.name));
const bad = Object.entries(ALIASES).filter(([, v]) => !known.has(v));
if (bad.length) {
  console.error("這些別名對不到國名：", bad);
  process.exit(1);
}

const out = {
  note: "Natural Earth 1:110m（public domain）經 world-atlas（Michael Bostock, ISC）轉檔，再由 scripts/make-world.mjs 投影成等距長方座標。",
  viewBox: `0 0 ${W} ${H}`,
  land,
  countries,
  aliases: ALIASES,
};
await writeFile("public/data/world.json", JSON.stringify(out));
console.log(`world.json：陸地路徑 ${(land.length / 1024).toFixed(0)} KB、${countries.length} 個國家、${Object.keys(ALIASES).length} 個別名`);
