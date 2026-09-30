/**
 * 支援人力表的畫面——`/rota`（各研究室填）與後台「設定」分頁（主辦端看與改）**同一份渲染**。
 *
 * 兩邊長得一樣是刻意的（明確要求：設定這邊要直接看到這張表、也改得了）：主辦端看到的就是
 * 老師看到的那一張，改的也是同一格——群組裡接龍回的，就由主辦端填進對應的格子，資料只有一份。
 *
 * 樣式自帶、類名一律 `rota-` 開頭：放進後台時不會跟後台自己的 .card／.muted 打架。
 * 格子不帶 `type=`，後台 `input[type=text]` 那條全域樣式也就套不上來。
 * 資料怎麼讀、怎麼寫由呼叫的那一頁給（`/rota` 帶連結裡的 key，後台走登入的 session）——這裡不管授權，
 * **過去的場次改不動也是伺服器在擋**，畫面上的灰底與 disabled 只是照著顯示。
 */

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
.rota-card { background: #fff; border: 1px solid #e7e5e4; border-radius: .9rem; padding: 1rem 1.1rem; scroll-margin-top: 1rem; }
.rota-card + .rota-card { margin-top: .75rem; }
/* 過去的一場：灰底、字淡下來、顏色抽掉。只靠顏色不夠——旁邊還寫著「已結束」，格子也是 disabled */
.rota-card.rota-past { background: #ebe9e7; color: #78716c; border-color: #d6d3d1; }
/* 從通告的連結點進來的那一場：亮一下，不必在一整張表裡找 */
.rota-card.rota-focus { outline: 3px solid #0f766e; outline-offset: 2px; }
.rota-muted { color: #78716c; font-size: .86rem; }
.rota-over { font-weight: 600; color: #57534e; }
.rota-grid { display: grid; gap: .5rem; margin-top: .75rem; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.rota-cell { border-top: 3px solid var(--tone); border-radius: .5rem; padding: .4rem .5rem; background: #fff; }
.rota-past .rota-cell { background: #f5f5f4; border-top-color: #d6d3d1 !important; }
.rota-past .rota-lab, .rota-past .rota-when { color: #a8a29e !important; }
.rota-lab { font-size: .78rem; font-weight: 600; }
.rota-when { color: #78716c; font-size: .74rem; }
.rota-who { display: block; width: 100%; margin-top: .25rem; border: 1px solid #d6d3d1; border-radius: .45rem; padding: .3rem .5rem; font-size: .92rem; background: #fff; box-sizing: border-box; }
.rota-who:focus { outline: 2px solid var(--tone); outline-offset: 1px; }
.rota-who:disabled { background: #f5f5f4; color: #a8a29e; border-style: dashed; }
.rota-who.rota-saved { border-color: #15803d; }
.rota-bg > summary { cursor: pointer; list-style: none; font-size: .88rem; font-weight: 500; margin-top: .5rem; }
.rota-bg > summary::-webkit-details-marker { display: none; }
.rota-bg > summary::before { content: "▸ "; }
.rota-bg[open] > summary::before { content: "▾ "; }
.rota-f { font-size: .78rem; font-weight: 600; color: #57534e; }
.rota-bg ol, .rota-bg ul { padding-left: 1.25rem; }
.rota-bg ol { list-style: decimal; }
.rota-bg ul { list-style: disc; }
`;

function injectStyle() {
  if (document.getElementById("rota-style")) return;
  const el = document.createElement("style");
  el.id = "rota-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** 背景研判：整份摺起來，點開才看——表上一眼要看到的是日期與空格，不是一整頁研判。 */
function background(b) {
  if (!b) return "";
  const list = (items, fn) => (items || []).map((x) => `<li>${fn(x)}</li>`).join("");
  return `
    <details class="rota-bg">
      <summary>訪客背景研判（點開來看）</summary>
      <div style="margin-top:.5rem;font-size:.88rem;display:grid;gap:.5rem">
        <p>${esc(b.org_profile)}</p>
        ${(b.purposes || []).length ? `<div><div class="rota-f">可能的參訪目的</div><ol>${list(b.purposes, esc)}</ol></div>` : ""}
        ${(b.people || []).length ? `<div><div class="rota-f">名單上的人</div><ul>${list(b.people, (p) => `<b>${esc(p.name)}</b>　${esc(p.note)}`)}</ul></div>` : ""}
        ${(b.rooms || []).length ? `<div><div class="rota-f">可能最想看</div><ul>${list(b.rooms, (x) => `<b>${esc(x.room)}</b>　${esc(x.why)}`)}</ul></div>` : ""}
        ${(b.prepare || []).length ? `<div><div class="rota-f">可以先準備</div><ul>${list(b.prepare, esc)}</ul></div>` : ""}
        ${(b.unknowns || []).length ? `<div><div class="rota-f">還要確認</div><ul style="color:#b45309">${list(b.unknowns, esc)}</ul></div>` : ""}
      </div>
    </details>`;
}

function card(v, labs) {
  const lab = (room) => labs.find((l) => String(l.room) === String(room)) || { room, name_zh: room, color: "#0f766e" };
  const d = new Date(`${v.date}T00:00:00+08:00`);
  const when = `${v.date}（${WEEK[d.getUTCDay()]}）${v.start_time || ""}${v.end_time ? `–${v.end_time}` : ""}`;
  const stops = v.stops || [];
  const cells = stops.length
    ? `<div class="rota-grid">${stops
        .map((s) => {
          const l = lab(s.room);
          const tone = esc(l.color || "#0f766e");
          const attrs = `data-visit="${esc(v.visit_id)}" data-room="${esc(s.room)}" ${v.past ? "disabled" : ""}`;
          return `<div class="rota-cell" style="--tone:${tone}">
              <div class="rota-lab" style="color:${tone}">${esc(s.room)} ${esc(l.name_zh)}</div>
              <div class="rota-when">${esc(s.start)}–${esc(s.end)}　${esc(String(s.minutes))} 分</div>
              <input class="rota-who" ${attrs} data-field="name" value="${esc(v.presenters?.[s.room] || "")}" placeholder="${v.past ? "" : "誰能支援？"}" aria-label="${esc(s.room)} 誰能支援">
              <input class="rota-who" ${attrs} data-field="hours" value="${esc(v.lab_hours?.[s.room] || "")}" placeholder="${v.past ? "" : "可以的時段？"}" aria-label="${esc(s.room)} 可以的時段"
                     title="那一天貴室方便的時段。「整段都可以」「16:00 之後」「要避開 15:40 的課」都可以，不必寫成標準時間">
            </div>`;
        })
        .join("")}</div>`
    : `<p class="rota-muted" style="margin-top:.5rem">行程還沒排，排好之後這裡就會列出要走哪幾間。</p>`;
  return `<section class="rota-card ${v.past ? "rota-past" : ""}" data-rota-visit="${esc(v.visit_id)}">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem">
        <b>${esc(v.org?.name)}</b>
        ${v.org?.name_local && v.org.name_local !== v.org.name ? `<span class="rota-muted">${esc(v.org.name_local)}</span>` : ""}
        <span class="rota-muted">${esc(when)}</span>
        ${v.org?.country ? `<span class="rota-muted">${esc(v.org.country)}</span>` : ""}
        ${v.headcount ? `<span class="rota-muted">${esc(String(v.headcount))} 位</span>` : ""}
        ${v.contact_teacher ? `<span class="rota-muted">對口 ${esc(v.contact_teacher)}</span>` : ""}
        ${v.past ? `<span class="rota-over">已結束</span>` : ""}
      </div>
      ${v.purpose ? `<p class="rota-muted" style="margin-top:.25rem">${esc(v.purpose)}</p>` : ""}
      ${background(v.background)}
      ${cells}
    </section>`;
}

/** 從通告的連結（`/rota?key=…#<visit_id>`）點進來：捲到那一場、亮一下。 */
export function focusVisit(root, id) {
  if (!id) return false;
  const el = [...root.querySelectorAll("[data-rota-visit]")].find((x) => x.dataset.rotaVisit === id);
  if (!el) return false;
  root.querySelectorAll(".rota-focus").forEach((x) => x.classList.remove("rota-focus"));
  el.classList.add("rota-focus");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  return true;
}

/**
 * 讀資料、畫表、接上「填完自己存」。回傳讀到的那一份（失敗回 null，訊息已經交給 onStatus）。
 *
 *   load()          → { ok, visits, labs } 或 { ok:false, error }
 *   save(body)      → { ok, error? }；body 是 { visit_id, room, name } 或 { visit_id, room, hours }
 *   onStatus(msg, isError)
 *   focus           要亮起來的那一場的 visit_id（通告連結 # 後面那一段）
 */
export async function mountRota(root, { load, save, onStatus = () => {}, focus = "" } = {}) {
  injectStyle();
  const r = await load();
  if (!r || !r.ok) {
    root.innerHTML = "";
    onStatus((r && r.error) || "打不開", true);
    return null;
  }
  const labs = r.labs || [];
  for (const l of labs) if (l.color) document.documentElement.style.setProperty(`--c${l.room}`, l.color);
  const visits = r.visits || [];
  root.innerHTML = visits.length ? visits.map((v) => card(v, labs)).join("") : `<p class="rota-muted">還沒有任何參訪。</p>`;
  const upcoming = visits.filter((v) => !v.past).length;
  onStatus(upcoming ? `接下來有 ${upcoming} 場要填；底下灰色的 ${visits.length - upcoming} 場已經結束。` : "目前沒有將來的參訪。", false);

  // 填完自己存：打完字 0.8 秒後寫回去，沒有送出鍵。**只送自己這一格**——兩個人同時在填
  // 不同的格子，不該互相蓋掉。用賦值不用 addEventListener：後台每次切到設定分頁都會重畫一次，
  // 疊上好幾個 listener 就會同一格存好幾次。
  const timers = new Map();
  root.oninput = (e) => {
    const el = e.target.closest && e.target.closest(".rota-who");
    if (!el || el.disabled) return;
    el.classList.remove("rota-saved");
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(async () => {
        const field = el.dataset.field === "hours" ? "hours" : "name";
        const res = await save({ visit_id: el.dataset.visit, room: el.dataset.room, [field]: el.value });
        if (res && res.ok) {
          el.classList.add("rota-saved");
          onStatus(`已存 ${new Date().toTimeString().slice(0, 5)}`, false);
        } else onStatus((res && res.error) || "存不起來", true);
      }, 800),
    );
  };
  if (focus) focusVisit(root, focus);
  return r;
}
