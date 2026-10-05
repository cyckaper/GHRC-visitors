/**
 * 支援人力表的畫面——`/rota`（各研究室填）與後台「設定」分頁（主辦端看與改）**同一份渲染**。
 *
 * 兩邊長得一樣是刻意的（明確要求：設定這邊要直接看到這張表、也改得了）：主辦端看到的就是
 * 老師看到的那一張，改的也是同一格——在群組裡直接回的，就由主辦端填進對應的格子，資料只有一份。
 *
 * **簡單明瞭**（明確指示）：每一間只填兩件事——接待人員、共需幾分鐘；說明越少越好。
 * **座談的場次**（不參觀研究室，`v.forum`）：各研究室的老師是固定的，不必填名字——每一間只要下拉選
 * 「可參加」或「無法參加」（`attendance`，明確指示），不問分鐘。
 * 卡片上只有「誰、哪一天、幾位」，其他（國家、對口、目的、背景研判）摺在「訪客背景」裡。
 *
 * 樣式自帶、類名一律 `rota-` 開頭：放進後台時不會跟後台自己的 .card／.muted 打架。
 * 格子不帶 `type=`，後台 `input[type=text]` 那條全域樣式也就套不上來。
 * 資料怎麼讀、怎麼寫由呼叫的那一頁給（`/rota` 帶連結裡的 key，後台走登入的 session）——這裡不管授權，
 * **過去的場次改不動也是伺服器在擋**，畫面上的灰底與 disabled 只是照著顯示。
 * 主辦端（登入的後台）過去的也改得了（伺服器回 `can_edit_past`；明確指示：老師臨時來了、或沒填表，紀錄要補得了）：
 * 那幾列照樣灰底、照樣收在「已結束」底下，只是格子可以填。
 */

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
/**
 * 那一天是星期幾。**日期字串本身沒有時區**，直接照年月日算。以前是拿「台北時間的午夜」去問 UTC 是星期幾，
 * 得到的是前一天下午四點——整張表每一天都早一天（明確回報：11/2 是週一，表上寫成週日）。
 */
export function weekdayOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  return m ? WEEK[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] : "";
}
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
/* 座談的場次（不參觀研究室）：一個小標籤，格子只問老師能否出席 */
.rota-tag { display: inline-block; font-size: .78rem; font-weight: 600; padding: .05rem .5rem; border-radius: 9999px; background: #ecfccb; color: #3f6212; border: 1px solid #bef264; }
/*
 * 老師多半是從 LINE 點連結、用手機填（實際回報：手機上整頁比螢幕寬，右邊那一欄與字尾都被切掉）。
 * 所以：手機上一間一列（一格至少 11rem，放不下兩格就一格；字放大了 rem 跟著變大，也就自動變一欄），
 * 格子裡的東西可以縮、可以換行，整頁不會被撐寬；桌機照樣五間一排。
 */
.rota-grid { display: grid; gap: .6rem; margin-top: .75rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr)); }
/* 名稱長的那一間（305）會換行：名稱吃掉多出來的高度，兩格就跟隔壁對齊在底下 */
.rota-cell { border-top: 3px solid var(--tone); border-radius: .5rem; padding: .45rem .55rem; background: #fff; display: flex; flex-direction: column; min-width: 0; }
.rota-cell > .rota-lab { flex: 1 0 auto; }
.rota-past .rota-cell { background: #f5f5f4; border-top-color: #d6d3d1 !important; }
.rota-past .rota-lab { color: #a8a29e !important; }
.rota-lab { font-size: .9rem; font-weight: 600; }
.rota-in { display: block; width: 100%; margin-top: .3rem; border: 1px solid #d6d3d1; border-radius: .45rem; padding: .3rem .5rem; font-size: .92rem; background: #fff; box-sizing: border-box; color: inherit; }
.rota-in:focus { outline: 2px solid var(--tone); outline-offset: 1px; }
.rota-in:disabled { background: #f5f5f4; color: #a8a29e; border-style: dashed; }
.rota-in.rota-saved { border-color: #15803d; }
.rota-min { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-top: .35rem; font-size: .95rem; color: #57534e; }
.rota-min > span { white-space: nowrap; } /* 「共需」「分鐘」不要被拆成一個字一行 */
.rota-min .rota-in { display: inline-block; width: 4.5em; margin-top: 0; text-align: right; }
/* 手機上的格子字至少 16px：看得清楚，iPhone 點下去也不會自己放大（小於 16px 的輸入框一點就整頁放大，放大了就要左右捲） */
.rota-cell .rota-in { font-size: 1rem; padding: .4rem .55rem; max-width: 100%; }
.rota-title { font-size: 1.05rem; overflow-wrap: anywhere; }
.rota-past .rota-min { color: #a8a29e; }
.rota-bg > summary { cursor: pointer; list-style: none; font-size: .88rem; font-weight: 500; margin-top: .5rem; }
.rota-bg > summary::-webkit-details-marker { display: none; }
.rota-bg > summary::before { content: "▸ "; }
.rota-bg[open] > summary::before { content: "▾ "; }
.rota-f { font-size: .78rem; font-weight: 600; color: #57534e; }
.rota-bg ol, .rota-bg ul { padding-left: 1.25rem; }
.rota-bg ol { list-style: decimal; }
.rota-bg ul { list-style: disc; }
/* ── 後台用的總表（layout: "table"）：一場一列、一間一欄，填了沒一眼看得到 ── */
.rota-scroll { overflow-x: auto; }
.rota-table { width: 100%; min-width: 640px; border-collapse: separate; border-spacing: 4px; }
.rota-th { text-align: left; vertical-align: bottom; padding: .15rem .35rem; font-size: .82rem; font-weight: 700; }
.rota-sub { font-size: .72rem; font-weight: 400; color: #78716c; }
.rota-rh { text-align: left; vertical-align: top; padding: .35rem .4rem; min-width: 8.5rem; font-size: .88rem; font-weight: 400; }
.rota-td { vertical-align: top; padding: .3rem .4rem; background: #fff; border: 1px solid #e7e5e4; border-top: 3px solid var(--tone, #d6d3d1); border-radius: .5rem; font-size: .88rem; }
.rota-td .rota-in { margin-top: 0; }
/* 還沒填：整格淡黃、那一格寫著「未填」——顏色之外還有字，只看得到灰階也分得出來 */
.rota-td.rota-todo { background: #fffbeb; }
.rota-td.rota-todo .rota-in[data-field="name"]::placeholder { color: #b45309; opacity: 1; }
.rota-td.rota-todo select.rota-in { color: #b45309; }
.rota-td.rota-todo select.rota-in option { color: #1c1917; }
/* 這一場不走這一間 */
.rota-td.rota-na { background: #fafaf9; border-style: dashed; border-top-width: 1px; color: #a8a29e; text-align: center; vertical-align: middle; }
.rota-past .rota-rh, .rota-past .rota-td { color: #78716c; }
.rota-past .rota-td { background: #f5f5f4; border-top-color: #d6d3d1; }
.rota-pastbox > summary { cursor: pointer; margin-top: .75rem; font-size: .88rem; color: #57534e; }
`;

function injectStyle() {
  if (document.getElementById("rota-style")) return;
  const el = document.createElement("style");
  el.id = "rota-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * 訪客背景：整份摺起來，點開才看——卡片上一眼要看到的只有「誰、哪一天、幾位」與要填的格子
 * （明確指示：簡單明瞭）。國家、對口老師、來訪目的與 AI 的背景研判都收在這裡面。
 */
function background(v) {
  const b = v.background;
  const facts = [v.org?.country && `國家：${v.org.country}`, v.contact_teacher && `對口：${v.contact_teacher}`].filter(Boolean);
  if (!b && !facts.length && !v.purpose) return "";
  const list = (items, fn) => (items || []).map((x) => `<li>${fn(x)}</li>`).join("");
  return `
    <details class="rota-bg">
      <summary>訪客背景（點開來看）</summary>
      <div style="margin-top:.5rem;font-size:.88rem;display:grid;gap:.5rem">
        ${facts.length ? `<p class="rota-muted">${esc(facts.join("　"))}</p>` : ""}
        ${v.purpose ? `<div><div class="rota-f">來訪目的</div><p>${esc(v.purpose)}</p></div>` : ""}
        ${b?.org_profile ? `<p>${esc(b.org_profile)}</p>` : ""}
        ${(b?.purposes || []).length ? `<div><div class="rota-f">可能的參訪目的</div><ol>${list(b.purposes, esc)}</ol></div>` : ""}
        ${(b?.people || []).length ? `<div><div class="rota-f">名單上的人</div><ul>${list(b.people, (p) => `<b>${esc(p.name)}</b>　${esc(p.note)}`)}</ul></div>` : ""}
        ${(b?.rooms || []).length ? `<div><div class="rota-f">可能最想看</div><ul>${list(b.rooms, (x) => `<b>${esc(x.room)}</b>　${esc(x.why)}`)}</ul></div>` : ""}
        ${(b?.prepare || []).length ? `<div><div class="rota-f">可以先準備</div><ul>${list(b.prepare, esc)}</ul></div>` : ""}
        ${(b?.unknowns || []).length ? `<div><div class="rota-f">還要確認</div><ul style="color:#b45309">${list(b.unknowns, esc)}</ul></div>` : ""}
      </div>
    </details>`;
}

/**
 * 座談的場次：那一間的老師能否出席。**老師是固定的**（各研究室的負責人），不必填名字——
 * 下拉選「可參加」「無法參加」就好（明確指示）。空的＝還沒回。
 * **選項前面就是老師的名字**（「張俊彥 可參加」「張俊彥 無法參加」，明確指示）：選好之後格子上一眼看得出是誰。
 */
const ATTEND = { yes: "可參加", no: "無法參加" };
const attendText = (lead, k) => `${lead ? `${lead} ` : ""}${ATTEND[k]}`;
function attendSelect(v, room, lead, empty) {
  const now = v.attendance?.[room] || "";
  return `<select class="rota-in" data-visit="${esc(v.visit_id)}" data-room="${esc(room)}" data-field="attend" ${v.locked ? "disabled" : ""} aria-label="${esc(room)} ${esc(lead || "")} 能否出席座談">
      <option value="">${esc(empty)}</option>${Object.keys(ATTEND).map((k) => `<option value="${k}" ${now === k ? "selected" : ""}>${esc(attendText(lead, k))}</option>`).join("")}
    </select>`;
}

function card(v, labs) {
  const lab = (room) => labs.find((l) => String(l.room) === String(room)) || { room, name_zh: room, color: "#0f766e" };
  const wk = weekdayOf(v.date);
  const when = `${v.date}${wk ? `（${wk}）` : ""}${v.start_time || ""}${v.end_time ? `–${v.end_time}` : ""}`;
  const stops = v.stops || [];
  // 一間一格，只有兩件事：接待人員、共需幾分鐘（明確指示）。各室排定的時段不印——
  // 通告說「尚未分配到各室」，各室回報要多少時間，主辦端才排得出來
  const cells = stops.length
    ? `<div class="rota-grid">${stops
        .map((s) => {
          const l = lab(s.room);
          const tone = esc(l.color || "#0f766e");
          const attrs = `data-visit="${esc(v.visit_id)}" data-room="${esc(s.room)}" ${v.locked ? "disabled" : ""}`;
          const mins = v.lab_minutes?.[s.room];
          // 座談的場次只問老師能否出席（老師是固定的；不問分鐘：座談不參觀研究室）
          if (v.forum)
            return `<div class="rota-cell" style="--tone:${tone}">
              <div class="rota-lab" style="color:${tone}">${esc(s.room)} ${esc(l.name_zh)}${l.lead ? ` <span class="rota-muted" style="font-weight:400">${esc(l.lead)}</span>` : ""}</div>
              ${attendSelect(v, s.room, l.lead, "請選擇")}
            </div>`;
          return `<div class="rota-cell" style="--tone:${tone}">
              <div class="rota-lab" style="color:${tone}">${esc(s.room)} ${esc(l.name_zh)}</div>
              <input class="rota-in" ${attrs} data-field="name" value="${esc(v.presenters?.[s.room] || "")}" placeholder="${v.locked ? "" : "接待人員"}" aria-label="${esc(s.room)} 接待人員">
              <label class="rota-min"><span>共需</span><input class="rota-in" ${attrs} data-field="minutes" inputmode="numeric" maxlength="3" value="${esc(mins == null ? "" : String(mins))}" aria-label="${esc(s.room)} 共需幾分鐘"><span>分鐘</span></label>
            </div>`;
        })
        .join("")}</div>`
    : `<p class="rota-muted" style="margin-top:.5rem">行程還沒排，排好之後這裡就會列出要走哪幾間。</p>`;
  return `<section class="rota-card ${v.past ? "rota-past" : ""}" data-rota-visit="${esc(v.visit_id)}">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem">
        <b class="rota-title">${esc(v.org?.name)}</b>
        ${v.org?.name_local && v.org.name_local !== v.org.name ? `<span class="rota-muted">${esc(v.org.name_local)}</span>` : ""}
        <span class="rota-muted">${esc(when)}</span>
        ${v.headcount ? `<span class="rota-muted">${esc(String(v.headcount))} 位</span>` : ""}
        ${v.forum ? `<span class="rota-tag" title="跟中心老師們座談，不參觀研究室：請選老師可參加或無法參加">座談・選可否出席</span>` : ""}
        ${v.past ? `<span class="rota-over">已結束</span>` : ""}
      </div>
      ${background(v)}
      ${cells}
    </section>`;
}

/** 研究室名稱放進欄位標題時拿掉括號裡的補充（「IVR 研究室（沉浸式虛擬實境）」→「IVR 研究室」），欄才不會被撐高。 */
const shortName = (l) => String(l?.name_zh || "").replace(/（[^）]*）$/, "").trim();

/**
 * 總表的一格。三種狀態，字就寫在格子裡：填了（人名、分鐘）、**未填**（淡黃，這一場要走這一間但還沒回）、
 * **免填**（這一場不走這一間）。已經結束的只顯示字、不給格子。座談的場次每一格是「可參加／無法參加」的下拉選單。
 */
function tableCell(v, room, lead) {
  const on = (v.stops || []).some((s) => String(s.room) === room);
  if (!on) return `<td class="rota-td rota-na">免填</td>`;
  // 已經結束的那幾列不標「未填」（不然整疊過去的場次永遠是一片黃），主辦端補得了的照樣給格子
  const todo = (filled) => (filled || v.past ? "" : "rota-todo");
  if (v.forum) {
    const now = v.attendance?.[room] || "";
    if (v.locked) return `<td class="rota-td">${now ? esc(attendText(lead, now)) : `<span class="rota-muted">—</span>`}</td>`;
    return `<td class="rota-td ${todo(now)}" style="--tone:var(--c${esc(room)})">${attendSelect(v, room, lead, v.past ? "—" : "未填")}</td>`;
  }
  const name = v.presenters?.[room] || "";
  const mins = v.lab_minutes?.[room];
  if (v.locked) {
    const text = name || mins != null ? `${esc(name || "—")}${mins != null ? `<span class="rota-muted">　${esc(String(mins))} 分</span>` : ""}` : `<span class="rota-muted">—</span>`;
    return `<td class="rota-td">${text}</td>`;
  }
  const attrs = `data-visit="${esc(v.visit_id)}" data-room="${esc(room)}"`;
  return `<td class="rota-td ${todo(name)}" style="--tone:var(--c${esc(room)})">
      <input class="rota-in" ${attrs} data-field="name" value="${esc(name)}" placeholder="${v.past ? "—" : "未填"}" aria-label="${esc(room)} 接待人員">
      <label class="rota-min"><input class="rota-in" ${attrs} data-field="minutes" inputmode="numeric" maxlength="3" value="${esc(mins == null ? "" : String(mins))}" aria-label="${esc(room)} 共需幾分鐘"> 分</label>
    </td>`;
}

/**
 * 後台「設定」分頁用的**總表**（明確指示：要更簡單，還沒填的也要顯示出來才知道有填沒填）：
 * 一場一列、五間一間一欄，每一格就是那一間的接待人員與分鐘，**沒填的寫「未填」**。
 * 老師那一頁（`/rota`）還是一場一張卡片——老師只看自己那一格；主辦端要看的是整張表誰還沒回。
 * 已經結束的收在最底下摺起來；主辦端補得了（`can_edit_past`），研究室那一頁只給看。
 */
function table(visits, labs, editPast) {
  const rooms = labs.length ? labs.map((l) => String(l.room)) : ["301", "302", "303", "304", "305"];
  const lab = (room) => labs.find((l) => String(l.room) === room);
  const head = `<thead><tr><th class="rota-th">場次</th>${rooms.map((room) => `<th class="rota-th" style="color:var(--c${esc(room)})">${esc(room)}<div class="rota-sub">${esc(shortName(lab(room)))}</div></th>`).join("")}</tr></thead>`;
  const row = (v) => {
    const wk = weekdayOf(v.date);
    const when = `${String(v.date || "").slice(5).replace("-", "/")}${wk ? `（${wk}）` : ""}${v.start_time || ""}${v.end_time ? `–${v.end_time}` : ""}`;
    return `<tr class="${v.past ? "rota-past" : ""}" data-rota-visit="${esc(v.visit_id)}">
        <th scope="row" class="rota-rh"><b>${esc(v.org?.name_local || v.org?.name)}</b><div class="rota-sub">${esc(when)}</div>${v.forum ? `<span class="rota-tag" title="跟中心老師們座談，不參觀研究室：每一間只選老師可參加或無法參加">座談・選可否出席</span>` : ""}</th>
        ${rooms.map((room) => tableCell(v, room, lab(room)?.lead)).join("")}
      </tr>`;
  };
  const grid = (list) => `<div class="rota-scroll"><table class="rota-table">${head}<tbody>${list.map(row).join("")}</tbody></table></div>`;
  const upcoming = visits.filter((v) => !v.past);
  const past = visits.filter((v) => v.past);
  return `${upcoming.length ? grid(upcoming) : ""}${past.length ? `<details class="rota-pastbox"><summary>${editPast ? `已結束的 ${past.length} 場（點開來看，可以補改）` : `已結束的 ${past.length} 場（點開來看）`}</summary>${grid(past)}</details>` : ""}`;
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
 *   save(body)      → { ok, error? }；body 是 { visit_id, room, name }、{ visit_id, room, minutes } 或 { visit_id, room, attend }（座談）
 *   onStatus(msg, isError)
 *   focus           要亮起來的那一場的 visit_id（通告連結 # 後面那一段）
 *   layout          "cards"（老師那一頁，一場一張卡片）或 "table"（後台設定分頁，一場一列的總表）
 */
export async function mountRota(root, { load, save, onStatus = () => {}, focus = "", layout = "cards" } = {}) {
  injectStyle();
  const draw = (r) => {
    const labs = r.labs || [];
    for (const l of labs) if (l.color) document.documentElement.style.setProperty(`--c${l.room}`, l.color);
    // 過去的那一場鎖不鎖由伺服器說了算（主辦端補得了，研究室那一頁只給看）
    const visits = (r.visits || []).map((v) => ({ ...v, locked: !!v.past && !r.can_edit_past }));
    root.innerHTML = !visits.length ? `<p class="rota-muted">還沒有任何參訪。</p>` : layout === "table" ? table(visits, labs, !!r.can_edit_past) : visits.map((v) => card(v, labs)).join("");
    return visits;
  };
  const r = await load();
  if (!r || !r.ok) {
    root.innerHTML = "";
    onStatus((r && r.error) || "打不開", true);
    return null;
  }
  const visits = draw(r);
  // 說明越少越好（明確指示）：灰的、寫著「已結束」的那幾場自己看得懂，不必再講一次
  onStatus(visits.some((v) => !v.past) ? "" : "目前沒有將來的參訪。", false);

  // 填完自己存：打完字 0.8 秒後寫回去，沒有送出鍵。**只送自己這一格**——兩個人同時在填
  // 不同的格子，不該互相蓋掉。用賦值不用 addEventListener：後台每次切到設定分頁都會重畫一次，
  // 疊上好幾個 listener 就會同一格存好幾次。
  const timers = new Map();
  const pending = new Set(); // 打了字、還沒存完的格子
  // 下拉選單（座談的「可參加／無法參加」）選了就存；有的瀏覽器只送 change、有的 input 與 change 都送——
  // 兩個都接，同一格排在同一個計時器上，所以只會存一次
  root.onchange = (e) => {
    if (e.target && e.target.matches && e.target.matches("select.rota-in")) root.oninput(e);
  };
  root.oninput = (e) => {
    const el = e.target.closest && e.target.closest(".rota-in");
    if (!el || el.disabled) return;
    // 分鐘那一格只收數字：打「20分」「２０」都變成 20（伺服器那邊也會再整理一次）
    if (el.dataset.field === "minutes" && !e.isComposing) {
      const clean = el.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "").slice(0, 3);
      if (clean !== el.value) el.value = clean;
    }
    el.classList.remove("rota-saved");
    // 總表：人名一填上（座談：可否出席一選），那一格就不再是「未填」（清空又變回來）
    if ((el.dataset.field === "name" || el.dataset.field === "attend") && !el.closest(".rota-past")) el.closest(".rota-td")?.classList.toggle("rota-todo", !el.value.trim());
    clearTimeout(timers.get(el));
    pending.add(el);
    timers.set(
      el,
      setTimeout(async () => {
        const field = el.dataset.field === "minutes" || el.dataset.field === "attend" ? el.dataset.field : "name";
        const res = await save({ visit_id: el.dataset.visit, room: el.dataset.room, [field]: el.value });
        pending.delete(el);
        if (res && res.ok) {
          el.classList.add("rota-saved");
          onStatus(`已存 ${new Date().toTimeString().slice(0, 5)}`, false);
        } else onStatus((res && res.error) || "存不起來", true);
      }, el.tagName === "SELECT" ? 0 : 800),
    );
  };
  if (focus) focusVisit(root, focus);

  // **別台電腦剛填的，回到這個視窗就看得到**（明確問過：不同電腦填的會不會彙整到同一個網頁）。
  // 資料本來就只有一份（存在站台上），但開著的這一頁不會自己知道別人填了什麼——視窗重新拿到焦點時重讀一次。
  // 還有打了字、還沒存完的格子就不動（重畫會把那些字洗掉）；游標停在哪一格，重畫完放回那一格。
  // 後台在別的分頁時（表沒顯示）也不讀。
  let lastRefresh = 0;
  root._rotaRefresh = async () => {
    if (!root.isConnected || root.offsetParent === null || pending.size || Date.now() - lastRefresh < 3000) return;
    lastRefresh = Date.now();
    const again = await load();
    if (!again || !again.ok || pending.size) return;
    const a = document.activeElement;
    const at = a && root.contains(a) && a.matches(".rota-in") ? { ...a.dataset, start: a.selectionStart, end: a.selectionEnd } : null;
    draw(again);
    if (focus) [...root.querySelectorAll("[data-rota-visit]")].find((x) => x.dataset.rotaVisit === focus)?.classList.add("rota-focus");
    if (at) {
      const el = [...root.querySelectorAll(".rota-in")].find((x) => x.dataset.visit === at.visit && x.dataset.room === at.room && x.dataset.field === at.field);
      if (el) {
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(at.start, at.end);
        } catch (e) {}
      }
    }
  };
  if (!root._rotaWatching) {
    root._rotaWatching = true;
    const refresh = () => root._rotaRefresh && root._rotaRefresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
  }
  return r;
}
