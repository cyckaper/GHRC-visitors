/**
 * 世界地圖：後台「資料」分頁的「訪客來自哪裡」與中心首頁 `/` 的「來訪單位」共用這一份
 * （明確要求：「GHRC 介紹首頁加入設定中的世界地圖，標出來訪單位」）。畫法、放大、群集、名稱都同一套，
 * 兩邊不會各長各的。
 *
 * - 等距長方投影，一度兩個座標單位（720×360）。`public/data/world.json` 是 Natural Earth 1:110m，
 *   座標已經投影好（scripts/make-world.mjs），所以不必為了一張圖去載一套地圖函式庫——頁面都是單檔 HTML、
 *   沒有建置步驟，而且現場網路不一定好。
 * - **一個單位一個點**，落在那個學校或公司所在的地方（明確指示：「點要能縮小到學校或公司，不要佔了整個國家」）；
 *   只查到國家的放在國家的位置、畫成空心的圈。
 * - 可以放大：＋／－／全圖、觸控板雙指（瀏覽器送 ctrl＋滾輪）、雙擊、手機平板兩指撐開；放大之後可以拖曳。
 *   **還在整張世界地圖時，手指滑過地圖是捲頁面、滾輪也是**（不會被地圖吃掉）。最多放大 20 倍
 *   （看得出臺北、新竹是不同的點；再大 1:50m 的海岸線就撐不住了）。
 * - 螢幕上靠得比 14 px 近的點合成一顆帶數字的群集，點下去放大到看得開；放到最大還是疊在一起的
 *   （座標本來就只到城市），點下去就交給 `onPick` 列出那幾個單位。點旁邊放得下就寫名稱，放不下就不寫。
 * - **圓點的大小是螢幕上的像素，不是地圖座標**：地圖放得越大，點在地圖上就越小，螢幕上看起來一樣大、
 *   蓋住的地方越來越少。場次多的大一點（絕對尺度，最大 8 px）；另外疊一顆透明的圓當點擊範圍（至少 11 px）。
 * - 放大超過 3 倍換細海岸線（`world-detail.json`，1:50m，第一次放大才載；載不到就繼續用粗的）。
 *
 * 用法：
 *   const world = await loadWorld();
 *   const at = placeOf(world, { country, geo });         // {x, y, approx, country, place}；國名對不到、也沒有座標就是 null
 *   const map = mountWorldMap(el, world, { ariaLabel, controls: { zoomIn, zoomOut, reset }, onPick, clusterTitle });
 *   map.setPoints([{ key, x, y, n, approx, label, title }]); // n：場次（點的大小）；label：點旁邊的字；title：說明
 *   map.highlight(keys);
 * 樣式自帶（`.wm` 底下），點的顏色吃 CSS 變數 `--wm-dot`（沒設就是中心的青綠色）。
 */

export const MAP_FULL = { x: 0, y: 12, w: 720, h: 288 }; // 上下切掉南北極的空白（北緯 84 以北、南緯 60 以南沒有訪客）
export const MAX_ZOOM = 20;
const DETAIL_AT = 3; // 放大超過這個倍數換細海岸線
export const project = (lat, lon) => ({ x: ((Number(lon) + 180) * 720) / 360, y: ((90 - Number(lat)) * 360) / 180 });

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const normCountry = (x) => String(x || "").trim().toLowerCase().replace(/^the\s+/, "").replace(/[.,\s]+/g, " ").trim();

let worldP = null;
/** 陸地輪廓與各國的落點（載一次，大家共用）。 */
export function loadWorld() {
  if (!worldP) {
    worldP = fetch("/data/world.json").then((r) => r.json()).then((w) => {
      w.byName = new Map(w.countries.map((c) => [normCountry(c.name), c]));
      w.alias = new Map(Object.entries(w.aliases).map(([k, v]) => [normCountry(k), normCountry(v)]));
      // 中文國名：aliases 是「各種寫法 → 英文名」，反過來查就有中文（「臺」優先於「台」）
      w.zh = new Map();
      for (const [k, v] of Object.entries(w.aliases)) {
        if (!/[一-鿿]/.test(k)) continue;
        const cur = w.zh.get(v);
        if (!cur || (/台/.test(cur) && /臺/.test(k))) w.zh.set(v, k);
      }
      return w;
    }).catch((e) => { worldP = null; throw e; });
  }
  return worldP;
}
/** 來信裡的國名（中英文各種寫法）→ world.json 的那一國。對不到是 null。 */
export const countryPoint = (w, raw) => { const n = normCountry(raw); return (n && (w.byName.get(n) || w.byName.get(w.alias.get(n) || ""))) || null; };
/** 國名照頁面的語言（中文頁用中文；沒有中文寫法就照英文）。 */
export const countryName = (w, name, lang) => (lang === "zh" && w.zh.get(name)) || name;

/**
 * 這一個單位畫在哪裡：查到城市（或更細）的照座標；只知道國家的放在國家的位置（approx，空心的圈）；
 * 兩樣都沒有就是 null——呼叫的那一邊自己決定要不要把它列在圖下面。
 */
export function placeOf(world, { country, geo } = {}) {
  const c = countryPoint(world, country);
  const exact = !!geo && geo.precision !== "country" && geo.lat != null && geo.lon != null;
  if (exact) return { ...project(geo.lat, geo.lon), approx: false, country: c ? c.name : String(country || ""), place: geo.place || "" };
  if (c) return { x: c.x, y: c.y, approx: true, country: c.name, place: "" };
  return null;
}

const WIDE = /[⺀-鿿가-힯぀-ヿ＀-￯]/;
const textWidth = (s) => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? 1 : 0.58), 0);
/** 點旁邊的字太長就截短（完整的名稱在點一下之後的清單裡）。英文截在字與字之間（「University of Western…」）。 */
export function shortLabel(s) {
  let w = 0;
  let out = "";
  for (const ch of String(s || "")) {
    w += WIDE.test(ch) ? 1 : 0.58;
    if (w > 15) return `${(/\s/.test(out) && !WIDE.test(out) ? out.replace(/\s+\S*$/, "") : out).trimEnd()}…`;
    out += ch;
  }
  return out;
}

// 亮起來的是滑鼠停著的那一個點、與點了之後列在下面的那幾個（[data-on]）。要寫 g[data-cluster]：
// 所有的點都包在同一個 <g> 裡，只寫 g:hover 的話，滑鼠停在任何一個點上，外面那一層也算 hover，全部的點一起變色
const STYLE = `
.wm svg { display: block; width: 100%; height: auto; border: 1px solid #e7e5e4; border-radius: .75rem; background: #f0fdfa; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.wm svg.zoomed { touch-action: none; cursor: grab; }
.wm svg.dragging { cursor: grabbing; }
.wm .wm-land { fill: #e7e5e4; stroke: #a8a29e; stroke-width: .6; }
.wm g[data-cluster] { cursor: pointer; }
.wm g[data-cluster]:focus { outline: none; }
.wm circle.dot { fill: var(--wm-dot, #0f766e); fill-opacity: .85; stroke: #fff; stroke-width: 1.5; }
.wm circle.dot.approx { fill: #fff; stroke: var(--wm-dot, #0f766e); stroke-width: 2; }
.wm g[data-cluster]:hover circle.dot, .wm g[data-on] circle.dot { fill: #b45309; fill-opacity: 1; }
.wm g[data-cluster]:hover circle.dot.approx, .wm g[data-on] circle.dot.approx { fill: #fff; stroke: #b45309; }
.wm g[data-cluster]:focus-visible circle.dot { stroke: #b45309; stroke-width: 3; }
.wm circle.hit { fill: transparent; stroke: none; }
.wm text { pointer-events: none; font-family: inherit; }
.wm text.count { fill: #fff; font-weight: 700; }
.wm text.lbl { fill: #292524; paint-order: stroke; stroke: rgba(255, 255, 255, .92); stroke-linejoin: round; }
`;
function injectStyle() {
  if (document.getElementById("wm-style")) return;
  const s = document.createElement("style");
  s.id = "wm-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

let detailP = null;
let detailFailed = false;

/**
 * 把地圖畫進 root（裡面原有的東西會被換掉）。points 之後用 setPoints 給。
 * @param {HTMLElement} root
 * @param {object} world loadWorld() 的結果
 * @param {{ariaLabel?: string, controls?: {zoomIn?: HTMLElement, zoomOut?: HTMLElement, reset?: HTMLElement},
 *          onPick?: (keys: string[]) => void, clusterTitle?: (members: object[]) => string}} opts
 */
export function mountWorldMap(root, world, opts = {}) {
  injectStyle();
  root.classList.add("wm");
  const F = MAP_FULL;
  const st = { view: { ...F }, points: [], clusters: [], picked: [], raf: 0 };
  root.innerHTML = `<svg viewBox="${F.x} ${F.y} ${F.w} ${F.h}" role="group" aria-label="${esc(opts.ariaLabel || "")}"><path class="wm-land" d="${world.land}" vector-effect="non-scaling-stroke"></path><path class="wm-land wm-land-detail" vector-effect="non-scaling-stroke" display="none"></path><g class="wm-dots"></g><g class="wm-labels"></g></svg>`;
  const svg = root.querySelector("svg");
  const ctl = opts.controls || {};
  const zoom = () => F.w / st.view.w;
  const clusterTitle = opts.clusterTitle || ((members) => members.map((p) => p.title || p.label || p.key).join(", "));

  const radius = (c) => (c.members.length === 1 ? Math.min(8, 4 + 1.5 * Math.sqrt(c.members[0].n || 1)) : Math.min(14, 8 + 1.5 * Math.sqrt(c.members.length)));
  function draw() {
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const v = st.view;
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    svg.classList.toggle("zoomed", zoom() > 1.01);
    if (ctl.zoomOut) ctl.zoomOut.disabled = zoom() <= 1.01;
    if (ctl.reset) ctl.reset.disabled = zoom() <= 1.01;
    if (ctl.zoomIn) ctl.zoomIn.disabled = zoom() >= MAX_ZOOM * 0.99;
    showDetailLand();
    const k = v.w / box.width; // 一個螢幕像素等於幾個地圖座標
    const clusters = [];
    for (const p of [...st.points].sort((a, b) => (b.n || 1) - (a.n || 1) || String(a.label).localeCompare(String(b.label)))) {
      const c = clusters.find((c) => Math.hypot(c.x - p.x, c.y - p.y) / k < 14);
      if (c) c.members.push(p);
      else clusters.push({ x: p.x, y: p.y, members: [p] });
    }
    st.clusters = clusters;
    svg.querySelector(".wm-dots").innerHTML = clusters.map((c, i) => {
      const one = c.members.length === 1 ? c.members[0] : null;
      const r = radius(c);
      const title = one ? one.title || one.label || "" : clusterTitle(c.members);
      const on = c.members.some((p) => st.picked.includes(p.key)) ? " data-on" : "";
      return `<g data-cluster="${i}"${on} tabindex="0" role="button" aria-label="${esc(title)}"><circle class="hit" cx="${c.x}" cy="${c.y}" r="${(Math.max(r, 11) * k).toFixed(4)}"></circle><circle class="dot${one ? (one.approx ? " approx" : "") : " cluster"}" cx="${c.x}" cy="${c.y}" r="${(r * k).toFixed(4)}" vector-effect="non-scaling-stroke"><title>${esc(title)}</title></circle>${one ? "" : `<text class="count" x="${c.x}" y="${c.y}" font-size="${(11 * k).toFixed(4)}" text-anchor="middle" dominant-baseline="central">${c.members.length}</text>`}</g>`;
    }).join("");
    // 名稱：點旁邊放得下才寫（場次多的先放；右邊放不下試左邊），跟別的名稱或點重疊就不寫
    const FS = 12;
    const taken = clusters.map((c) => { const r = radius(c); const sx = (c.x - v.x) / k; const sy = (c.y - v.y) / k; return { x0: sx - r, y0: sy - r, x1: sx + r, y1: sy + r }; });
    const overlaps = (b) => taken.some((a) => b.x0 < a.x1 && b.x1 > a.x0 && b.y0 < a.y1 && b.y1 > a.y0);
    const labels = [];
    for (const c of clusters) {
      if (c.members.length !== 1) continue; // 群集的數字已經寫在圈裡
      const text = shortLabel(c.members[0].label);
      if (!text) continue;
      const w = textWidth(text) * FS;
      const r = radius(c);
      const sx = (c.x - v.x) / k;
      const sy = (c.y - v.y) / k;
      for (const side of [1, -1]) {
        const x0 = side > 0 ? sx + r + 3 : sx - r - 3 - w;
        const b = { x0, y0: sy - FS * 0.65, x1: x0 + w, y1: sy + FS * 0.65 };
        if (b.x0 < 2 || b.x1 > box.width - 2 || b.y0 < 0 || b.y1 > box.height || overlaps(b)) continue;
        taken.push(b);
        labels.push(`<text class="lbl" x="${(v.x + b.x0 * k).toFixed(4)}" y="${c.y}" font-size="${(FS * k).toFixed(4)}" stroke-width="${(3 * k).toFixed(4)}" dominant-baseline="central">${esc(text)}</text>`);
        break;
      }
    }
    svg.querySelector(".wm-labels").innerHTML = labels.join("");
  }
  function requestDraw() {
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => { st.raf = 0; draw(); });
  }
  /** 放大超過幾倍就換細海岸線（第一次才載，壓縮後約 120 KB）；載不到就繼續用粗的，這一頁不再試。 */
  function showDetailLand() {
    const want = zoom() >= DETAIL_AT;
    const detail = svg.querySelector(".wm-land-detail");
    if (want && !detail.getAttribute("d") && !detail.dataset.loading && !detailFailed) {
      detail.dataset.loading = "1";
      detailP ||= fetch("/data/world-detail.json").then((r) => r.json());
      detailP.then((w) => { detail.setAttribute("d", w.land); requestDraw(); }).catch(() => { detailP = null; detailFailed = true; }).finally(() => { delete detail.dataset.loading; });
    }
    const on = want && !!detail.getAttribute("d");
    detail.setAttribute("display", on ? "inline" : "none");
    svg.querySelector(".wm-land:not(.wm-land-detail)").setAttribute("display", on ? "none" : "inline");
  }

  /** 換一個看的範圍：不能比整張世界大、不能放大超過 MAX_ZOOM 倍，也不能拖出地圖外。 */
  function setView({ x, y, w }) {
    const vw = Math.min(F.w, Math.max(F.w / MAX_ZOOM, w));
    const vh = (vw * F.h) / F.w;
    st.view = { x: Math.min(F.x + F.w - vw, Math.max(F.x, x)), y: Math.min(F.y + F.h - vh, Math.max(F.y, y)), w: vw, h: vh };
    requestDraw();
  }
  /** 以地圖上 (cx, cy) 為中心放大 f 倍（f 小於 1 是縮小）：那一點留在螢幕上原來的位置。 */
  function zoomAt(f, cx, cy) {
    const v = st.view;
    const w = Math.min(F.w, Math.max(F.w / MAX_ZOOM, v.w / f));
    const s = w / v.w;
    setView({ x: cx - (cx - v.x) * s, y: cy - (cy - v.y) * s, w });
  }
  /** 放大到看得開這幾個點（四周留一些邊）。 */
  function fitPoints(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const w = Math.max((Math.max(...xs) - Math.min(...xs)) * 2.2, ((Math.max(...ys) - Math.min(...ys)) * 2.2 * F.w) / F.h, F.w / MAX_ZOOM);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ x: cx - w / 2, y: cy - (w * F.h) / F.w / 2, w });
  }
  const toMap = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const v = st.view;
    return { x: v.x + ((clientX - r.left) / r.width) * v.w, y: v.y + ((clientY - r.top) / r.height) * v.h };
  };
  /**
   * 點一個點：一個單位就交給 onPick；一群就放大到看得開。放到最大還是疊在一起
   * （同一個城市裡的幾個單位——查到的座標本來就只到城市），就直接把那幾個交給 onPick。
   */
  function pickCluster(i) {
    const c = st.clusters[i];
    if (!c) return;
    const spread = Math.max(...c.members.map((p) => p.x)) - Math.min(...c.members.map((p) => p.x)) + Math.max(...c.members.map((p) => p.y)) - Math.min(...c.members.map((p) => p.y));
    if (c.members.length > 1 && zoom() < MAX_ZOOM * 0.99 && spread > 0.05) return fitPoints(c.members);
    opts.onPick?.(c.members.map((p) => p.key));
  }

  // 拖曳、雙指、滾輪、雙擊
  const ptrs = new Map(); // 按著的手指（或滑鼠）→ 上一次的位置
  let moved = false;
  let downAt = null;
  svg.addEventListener("pointerdown", (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { moved = false; downAt = { x: e.clientX, y: e.clientY }; }
  });
  svg.addEventListener("pointermove", (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    const r = svg.getBoundingClientRect();
    const v = st.view;
    if (ptrs.size >= 2) {
      // 雙指：兩指距離變幾倍就放大幾倍，兩指中間底下那一點跟著手指走
      const other = [...ptrs].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(now.x - other.x, now.y - other.y);
      if (d0 > 0 && d1 > 0) {
        const anchor = toMap((prev.x + other.x) / 2, (prev.y + other.y) / 2);
        const w = Math.min(F.w, Math.max(F.w / MAX_ZOOM, (v.w * d0) / d1));
        const h = (w * F.h) / F.w;
        setView({ x: anchor.x - (((now.x + other.x) / 2 - r.left) / r.width) * w, y: anchor.y - (((now.y + other.y) / 2 - r.top) / r.height) * h, w });
      }
      moved = true;
    } else if (zoom() > 1.01) {
      // 放大之後一指（或滑鼠）拖曳。移動不到 5 px 算點一下，不算拖
      if (!moved && Math.hypot(now.x - downAt.x, now.y - downAt.y) < 5) return;
      if (!moved) { moved = true; svg.classList.add("dragging"); try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 某些瀏覽器不給，不影響拖曳 */ } }
      setView({ x: v.x - ((now.x - prev.x) / r.width) * v.w, y: v.y - ((now.y - prev.y) / r.height) * v.h, w: v.w });
    }
    ptrs.set(e.pointerId, now);
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  // 拖完或雙指放大完放開，不算點了一個點
  svg.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); moved = false; } }, true);
  // 觸控板雙指（瀏覽器送 ctrl＋滾輪）隨時可以縮放；一般滾輪只在已經放大的時候縮放，還在整張世界地圖時是捲頁面
  svg.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && zoom() <= 1.01) return;
    e.preventDefault();
    const p = toMap(e.clientX, e.clientY);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }, { passive: false });
  svg.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-cluster]")) return;
    const p = toMap(e.clientX, e.clientY);
    zoomAt(2, p.x, p.y);
  });
  svg.addEventListener("click", (e) => { const g = e.target.closest("[data-cluster]"); if (g) pickCluster(Number(g.dataset.cluster)); });
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const g = e.target.closest("[data-cluster]");
    if (g) { e.preventDefault(); pickCluster(Number(g.dataset.cluster)); }
  });
  const center = () => ({ x: st.view.x + st.view.w / 2, y: st.view.y + st.view.h / 2 });
  if (ctl.zoomIn) ctl.zoomIn.onclick = () => { const c = center(); zoomAt(2, c.x, c.y); };
  if (ctl.zoomOut) ctl.zoomOut.onclick = () => { const c = center(); zoomAt(0.5, c.x, c.y); };
  if (ctl.reset) ctl.reset.onclick = () => setView({ ...F });
  // 地圖跟著版面寬度縮放：寬度一變就重畫（點的大小是螢幕上的像素，群集也跟著變）
  if (window.ResizeObserver) new ResizeObserver(() => requestDraw()).observe(root);

  return {
    /** 換一批點（同一個 key 的視角與選取都留著）。 */
    setPoints(points) { st.points = points || []; draw(); },
    /** 這幾個 key 的點亮起來（點了之後列在下面的那幾個）。 */
    highlight(keys) {
      st.picked = keys || [];
      for (const el of svg.querySelectorAll("[data-cluster]")) el.toggleAttribute("data-on", !!st.clusters[Number(el.dataset.cluster)]?.members.some((p) => st.picked.includes(p.key)));
    },
    reset() { setView({ ...F }); },
  };
}
