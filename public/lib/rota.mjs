/**
 * 支援人力表的畫面——`/rota`（各研究室填）與後台「設定」分頁（主辦端看與改）**同一份渲染**。
 *
 * 兩邊長得一樣是刻意的（明確要求：設定這邊要直接看到這張表、也改得了）：主辦端看到的就是
 * 老師看到的那一張，改的也是同一格——在群組裡直接回的，就由主辦端填進對應的格子，資料只有一份。
 *
 * **簡單明瞭**（明確指示）：每一間只填兩件事——接待人員、共需幾分鐘；說明越少越好。
 * 卡片上只有「誰、哪一天、幾位」，其他（國家、對口、目的、背景研判）摺在「訪客背景」裡。
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
/* 名稱長的那一間（305）會換行：名稱吃掉多出來的高度，兩格就跟隔壁對齊在底下 */
.rota-cell { border-top: 3px solid var(--tone); border-radius: .5rem; padding: .4rem .5rem; background: #fff; display: flex; flex-direction: column; }
.rota-cell > .rota-lab { flex: 1 0 auto; }
.rota-past .rota-cell { background: #f5f5f4; border-top-color: #d6d3d1 !important; }
.rota-past .rota-lab { color: #a8a29e !important; }
.rota-lab { font-size: .78rem; font-weight: 600; }
.rota-in { display: block; width: 100%; margin-top: .3rem; border: 1px solid #d6d3d1; border-radius: .45rem; padding: .3rem .5rem; font-size: .92rem; background: #fff; box-sizing: border-box; color: inherit; }
.rota-in:focus { outline: 2px solid var(--tone); outline-offset: 1px; }
.rota-in:disabled { background: #f5f5f4; color: #a8a29e; border-style: dashed; }
.rota-in.rota-saved { border-color: #15803d; }
.rota-min { display: flex; align-items: center; gap: .35rem; margin-top: .3rem; font-size: .88rem; color: #57534e; }
.rota-min .rota-in { display: inline-block; width: 4.2em; margin-top: 0; text-align: right; }
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

function card(v, labs) {
  const lab = (room) => labs.find((l) => String(l.room) === String(room)) || { room, name_zh: room, color: "#0f766e" };
  const d = new Date(`${v.date}T00:00:00+08:00`);
  const when = `${v.date}（${WEEK[d.getUTCDay()]}）${v.start_time || ""}${v.end_time ? `–${v.end_time}` : ""}`;
  const stops = v.stops || [];
  // 一間一格，只有兩件事：接待人員、共需幾分鐘（明確指示）。各室排定的時段不印——
  // 通告說「尚未分配到各室」，各室回報要多少時間，主辦端才排得出來
  const cells = stops.length
    ? `<div class="rota-grid">${stops
        .map((s) => {
          const l = lab(s.room);
          const tone = esc(l.color || "#0f766e");
          const attrs = `data-visit="${esc(v.visit_id)}" data-room="${esc(s.room)}" ${v.past ? "disabled" : ""}`;
          const mins = v.lab_minutes?.[s.room];
          return `<div class="rota-cell" style="--tone:${tone}">
              <div class="rota-lab" style="color:${tone}">${esc(s.room)} ${esc(l.name_zh)}</div>
              <input class="rota-in" ${attrs} data-field="name" value="${esc(v.presenters?.[s.room] || "")}" placeholder="${v.past ? "" : "接待人員"}" aria-label="${esc(s.room)} 接待人員">
              <label class="rota-min">共需 <input class="rota-in" ${attrs} data-field="minutes" inputmode="numeric" maxlength="3" value="${esc(mins == null ? "" : String(mins))}" aria-label="${esc(s.room)} 共需幾分鐘"> 分鐘</label>
            </div>`;
        })
        .join("")}</div>`
    : `<p class="rota-muted" style="margin-top:.5rem">行程還沒排，排好之後這裡就會列出要走哪幾間。</p>`;
  return `<section class="rota-card ${v.past ? "rota-past" : ""}" data-rota-visit="${esc(v.visit_id)}">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem">
        <b>${esc(v.org?.name)}</b>
        ${v.org?.name_local && v.org.name_local !== v.org.name ? `<span class="rota-muted">${esc(v.org.name_local)}</span>` : ""}
        <span class="rota-muted">${esc(when)}</span>
        ${v.headcount ? `<span class="rota-muted">${esc(String(v.headcount))} 位</span>` : ""}
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
 * **免填**（這一場不走這一間）。已經結束的只顯示字、不給格子。
 */
function tableCell(v, room) {
  const on = (v.stops || []).some((s) => String(s.room) === room);
  if (!on) return `<td class="rota-td rota-na">免填</td>`;
  const name = v.presenters?.[room] || "";
  const mins = v.lab_minutes?.[room];
  if (v.past) {
    const text = name || mins != null ? `${esc(name || "—")}${mins != null ? `<span class="rota-muted">　${esc(String(mins))} 分</span>` : ""}` : `<span class="rota-muted">—</span>`;
    return `<td class="rota-td">${text}</td>`;
  }
  const attrs = `data-visit="${esc(v.visit_id)}" data-room="${esc(room)}"`;
  return `<td class="rota-td ${name ? "" : "rota-todo"}" style="--tone:var(--c${esc(room)})">
      <input class="rota-in" ${attrs} data-field="name" value="${esc(name)}" placeholder="未填" aria-label="${esc(room)} 接待人員">
      <label class="rota-min"><input class="rota-in" ${attrs} data-field="minutes" inputmode="numeric" maxlength="3" value="${esc(mins == null ? "" : String(mins))}" aria-label="${esc(room)} 共需幾分鐘"> 分</label>
    </td>`;
}

/**
 * 後台「設定」分頁用的**總表**（明確指示：要更簡單，還沒填的也要顯示出來才知道有填沒填）：
 * 一場一列、五間一間一欄，每一格就是那一間的接待人員與分鐘，**沒填的寫「未填」**。
 * 老師那一頁（`/rota`）還是一場一張卡片——老師只看自己那一格；主辦端要看的是整張表誰還沒回。
 * 已經結束的收在最底下摺起來，只給看、不給改。
 */
function table(visits, labs) {
  const rooms = labs.length ? labs.map((l) => String(l.room)) : ["301", "302", "303", "304", "305"];
  const lab = (room) => labs.find((l) => String(l.room) === room);
  const head = `<thead><tr><th class="rota-th">場次</th>${rooms.map((room) => `<th class="rota-th" style="color:var(--c${esc(room)})">${esc(room)}<div class="rota-sub">${esc(shortName(lab(room)))}</div></th>`).join("")}</tr></thead>`;
  const row = (v) => {
    const d = new Date(`${v.date}T00:00:00+08:00`);
    const when = `${String(v.date || "").slice(5).replace("-", "/")}（${WEEK[d.getUTCDay()]}）${v.start_time || ""}${v.end_time ? `–${v.end_time}` : ""}`;
    return `<tr class="${v.past ? "rota-past" : ""}" data-rota-visit="${esc(v.visit_id)}">
        <th scope="row" class="rota-rh"><b>${esc(v.org?.name_local || v.org?.name)}</b><div class="rota-sub">${esc(when)}</div></th>
        ${rooms.map((room) => tableCell(v, room)).join("")}
      </tr>`;
  };
  const grid = (list) => `<div class="rota-scroll"><table class="rota-table">${head}<tbody>${list.map(row).join("")}</tbody></table></div>`;
  const upcoming = visits.filter((v) => !v.past);
  const past = visits.filter((v) => v.past);
  return `${upcoming.length ? grid(upcoming) : ""}${past.length ? `<details class="rota-pastbox"><summary>已結束的 ${past.length} 場（點開來看）</summary>${grid(past)}</details>` : ""}`;
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
 *   save(body)      → { ok, error? }；body 是 { visit_id, room, name } 或 { visit_id, room, minutes }
 *   onStatus(msg, isError)
 *   focus           要亮起來的那一場的 visit_id（通告連結 # 後面那一段）
 *   layout          "cards"（老師那一頁，一場一張卡片）或 "table"（後台設定分頁，一場一列的總表）
 */
export async function mountRota(root, { load, save, onStatus = () => {}, focus = "", layout = "cards" } = {}) {
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
  root.innerHTML = !visits.length ? `<p class="rota-muted">還沒有任何參訪。</p>` : layout === "table" ? table(visits, labs) : visits.map((v) => card(v, labs)).join("");
  // 說明越少越好（明確指示）：灰的、寫著「已結束」的那幾場自己看得懂，不必再講一次
  onStatus(visits.some((v) => !v.past) ? "" : "目前沒有將來的參訪。", false);

  // 填完自己存：打完字 0.8 秒後寫回去，沒有送出鍵。**只送自己這一格**——兩個人同時在填
  // 不同的格子，不該互相蓋掉。用賦值不用 addEventListener：後台每次切到設定分頁都會重畫一次，
  // 疊上好幾個 listener 就會同一格存好幾次。
  const timers = new Map();
  root.oninput = (e) => {
    const el = e.target.closest && e.target.closest(".rota-in");
    if (!el || el.disabled) return;
    // 分鐘那一格只收數字：打「20分」「２０」都變成 20（伺服器那邊也會再整理一次）
    if (el.dataset.field === "minutes" && !e.isComposing) {
      const clean = el.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "").slice(0, 3);
      if (clean !== el.value) el.value = clean;
    }
    el.classList.remove("rota-saved");
    // 總表：人名一填上，那一格就不再是「未填」（清空又變回來）
    if (el.dataset.field === "name") el.closest(".rota-td")?.classList.toggle("rota-todo", !el.value.trim());
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(async () => {
        const field = el.dataset.field === "minutes" ? "minutes" : "name";
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
