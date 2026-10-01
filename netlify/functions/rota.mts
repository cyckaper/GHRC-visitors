import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { loadSettings } from "./settings.mts";
import { loadLabs } from "./labs.mts";
import { getStore } from "../lib/store.mts";
import { retimeProgramme, rotaRooms, visitEndAt, withLabMinutes } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";
import type { Visit } from "../lib/types.mts";

/**
 * **支援人力表**（`/rota`）：所有參訪列成一張表，各研究室自己填「那一場誰能支援」。
 *
 * 為什麼要有這一頁：同一段時間常常好幾個單位來，每一場要問每一間「這個日期誰有空」，
 * 在 LINE 上一場一場問就亂掉了（明確回報）。一張表看得到全部，各室自己填自己那一格。
 *
 * GET  /api/rota?key=<k>                                 → 未來與過去的場次（過去的 `past: true`）
 * POST /api/rota?key=<k> {visit_id, room, name, minutes} → 寫進 `visit.presenters[room]` 與 `visit.lab_minutes[room]`
 *
 * **只問兩件事：接待人員、共需幾分鐘**（明確指示：「只要填該研究室人力及共需幾分鐘，說明越簡單越好」）。
 * 通告說「研究室參訪時段目前尚未分配到各室」，各室回報要多少時間，主辦端才排得出各室的時段；
 * 以前問的是「那一天方便的時段」（一句話），改掉了。
 * **填的分鐘自動排進行程**（明確指示）：`visit.itinerary` 那一間改成填的分鐘、今日流程從開始時間重推一次，
 * 所以訪前的行程表、來賓專頁的參訪流程、回報那一則都跟著變，不必主辦端再抄一次。
 * 這兩個欄位**只有這一支在寫**：`visits.mts` 的 `ROTA_FIELDS` 一律沿用伺服器上那一份，後台存檔蓋不掉。
 *
 * **過去的不給改，這件事在伺服器上擋**——畫面灰掉只是提示，擋在前端等於沒擋。
 * 判斷用 `visitEndAt()`（跟後續提醒同一個算法）：行程走完那一刻起就是過去式。
 *
 * **`key` 是連結裡的密語，不是登入**：老師從 LINE 點進來就要能填，卡在帳號密碼回覆率就沒了。
 * 值存在 `settings.rota_key`，後台「設定」分頁可以重新產生——換一個，舊連結就失效。
 * 沒設定過就只有 admin 打得開（`requireAdmin` 那條路照舊）。
 *
 * **這一頁上有訪客背景研判**（明確要求：可以點開來看）。那份研判本來就是主辦端的東西，
 * 而各研究室老師就是主辦端——但它仍然**不進來賓專頁、不進信件**，那條規矩沒有變。
 * 相對的，這一頁**不放名單與 email**：老師要準備的是「誰來、為什麼來」，不需要聯絡方式，
 * 而連結轉出去就擋不住，個資少放一點。
 */

/** 表上每一場只給這些欄位——名單、信件、回覆、摘要都不給。 */
function rotaVisit(v: Visit, labs: any, now: Date) {
  // **行程還沒排的那一場，五間都列出來**（明確指示：還沒填的也要看得到，才知道有填沒填）。
  // 主辦端排好之後只列動線上那幾間（加上已經填過的），其他的是「免填」。研究室自己填的分鐘會排進動線，
  // 那幾間不算主辦端排的——規則在 `lib/visit.mjs rotaRooms()`
  const { rooms, planned } = rotaRooms(v, labs) as { rooms: string[]; planned: boolean };
  return {
    visit_id: v.visit_id,
    date: v.date,
    start_time: v.start_time,
    end_time: (v as any).end_time || "",
    org: { name: v.org?.name || "", name_local: v.org?.name_local || "", country: v.org?.country || "", type: v.org?.type || "" },
    headcount: v.headcount || 0,
    purpose: v.purpose || "",
    contact_teacher: v.contact_teacher || "",
    // 各室排定的時段不給：通告說「尚未分配到各室」，表上再印一份排定的時間只會讓人以為已經定了
    stops: rooms.map((room) => ({ room })),
    planned,
    presenters: (v as any).presenters || {},
    lab_minutes: (v as any).lab_minutes || {},
    background: (v as any).background?.org_profile ? (v as any).background : null,
    past: visitEndAt(v) < now,
  };
}

async function allowed(req: Request): Promise<boolean> {
  const key = new URL(req.url).searchParams.get("key") || "";
  const want = (await loadSettings()).rota_key || "";
  // 空的 key 不算通過——不然還沒產生連結之前，任何人都打得開
  return !!want && key === want;
}

export default async (req: Request) => {
  if (!(await allowed(req))) {
    const denied = requireAdmin(req);
    if (denied) return fail(403, "這個連結不對，或是已經換過了。請跟中心要新的網址。");
  }
  const store = getStore();

  if (req.method === "GET") {
    const now = new Date();
    const labs = await loadLabs();
    const visits = (await store.listVisits()).filter((v) => v.visit_id && v.date);
    const rows = visits.map((v) => rotaVisit(v, labs, now));
    // 還沒到的照日期由近到遠（那才是現在要填的），過去的由新到舊接在後面
    const upcoming = rows.filter((r) => !r.past).sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
    const done = rows.filter((r) => r.past).sort((a, b) => `${b.date}${b.start_time}`.localeCompare(`${a.date}${a.start_time}`));
    return json({ ok: true, visits: [...upcoming, ...done], labs: (labs.labs || []).map((l: any) => ({ room: l.room, name_zh: l.name_zh, name_en: l.name_en, color: l.color, lead: l.lead?.name_zh || "" })) });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");

  const body = await readJSON<{ visit_id?: string; room?: string; name?: string; minutes?: string | number }>(req);
  const room = String(body?.room || "");
  if (!/^30[1-5]$/.test(room)) return fail(400, "房號只有 301–305");
  const visitId = String(body?.visit_id || "");

  // 共需幾分鐘：填一個數字就好（「20」「20 分」「２０」都收）；清空＝把這一格拿掉
  let minutes: number | null | undefined;
  if (body?.minutes !== undefined) {
    const digits = String(body.minutes ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).match(/\d+/);
    if (String(body.minutes ?? "").trim() && !digits) return fail(400, "共需幾分鐘：填一個數字就好");
    minutes = digits ? Math.min(Number(digits[0]), 600) : null;
    if (minutes === 0) minutes = null;
  }

  // 只改送上來的那一格，而且**在 updateVisit 裡改**：讀到的一定是最新那一份，寫的時候中間有人存過就重讀重改。
  // 五間同時在填、主辦端開著行程表自動存、背景在備份 Drive——誰都不會把別人剛存的那一格蓋回去
  let ended = false;
  const saved = await store.updateVisit(visitId, (v) => {
    if (visitEndAt(v) < new Date()) {
      ended = true;
      return false;
    }
    const put = (field: "presenters" | "lab_minutes", val: string | number | null | undefined) => {
      if (val === undefined) return;
      const map: Record<string, string | number> = { ...((v as any)[field] || {}) };
      if (val === null || val === "") delete map[room];
      else map[room] = val;
      (v as any)[field] = map;
    };
    put("presenters", body?.name === undefined ? undefined : String(body.name ?? "").trim().slice(0, 60));
    put("lab_minutes", minutes);
    const now = nowISO();
    if (minutes !== undefined) {
      const at: Record<string, string> = { ...((v as any).lab_minutes_at || {}) };
      // 哪幾間是研究室自己填進動線的（主辦端沒排）：支援人力表判斷「這一場排了沒」要把它們排除（rotaRooms）
      const added = new Set<string>((((v as any).lab_added || []) as unknown[]).map(String));
      if (minutes) {
        // **填的分鐘自動排進行程**（明確指示）：動線上那一間改成這個分鐘數（沒有就插進去），
        // 今日流程從開始時間往後重推——訪前的行程表、來賓專頁的參訪流程、回報那一則都照這一份。
        // 記下是什麼時候填的：後台手上那一份如果比這個舊，存檔時不會把它蓋回去（visits.mts）
        if (!(v.itinerary || []).some((s) => String(s.room) === room && Number(s.minutes) > 0)) added.add(room);
        v.itinerary = withLabMinutes(v.itinerary, room, minutes) as Visit["itinerary"];
        v.programme = retimeProgramme(v) as Visit["programme"];
        at[room] = now;
      } else {
        // 清空＝「還沒回」。主辦端排的那一間不動（說不定本來就要去）；只因為研究室填了才排進去的，跟著拿掉
        delete at[room];
        if (added.delete(room)) {
          v.itinerary = (v.itinerary || []).filter((s) => String(s.room) !== room);
          v.programme = retimeProgramme(v) as Visit["programme"];
        }
      }
      (v as any).lab_minutes_at = at;
      (v as any).lab_added = [...added];
    }
    (v as any).updated_at = now;
  });
  if (!saved) return fail(404, "找不到這一場");
  if (ended) return fail(409, "這一場已經結束了，不能再改");
  await triggerDriveSync(saved.visit_id);
  return json({ ok: true, presenters: (saved as any).presenters || {}, lab_minutes: (saved as any).lab_minutes || {} });
};
