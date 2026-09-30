import { fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { loadSettings } from "./settings.mts";
import { loadLabs } from "./labs.mts";
import { getStore } from "../lib/store.mts";
import { labStops, visitEndAt } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";
import type { Visit } from "../lib/types.mts";

/**
 * **支援人力表**（`/rota`）：所有參訪列成一張表，各研究室自己填「那一場誰能支援」。
 *
 * 為什麼要有這一頁：同一段時間常常好幾個單位來，每一場要問每一間「這個日期誰有空」，
 * 在 LINE 上一場一場問就亂掉了（明確回報）。一張表看得到全部，各室自己填自己那一格。
 *
 * GET  /api/rota?key=<k>                               → 未來與過去的場次（過去的 `past: true`）
 * POST /api/rota?key=<k> {visit_id, room, name, hours} → 寫進 `visit.presenters[room]` 與 `visit.lab_hours[room]`
 *
 * **問兩件事：誰來接待、那一天這一間開放的時段**（明確要求）。時段是一句話不是時間欄位——
 * 實際回答常常是「整段都可以」「16:00 之後」「要避開 15:40 的課」，塞進時間選單反而填不了。
 * 這兩個欄位**只有這一支在寫**：`visits.mts` 的 `KEPT` 把它們保留下來，後台存檔蓋不掉。
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
  const stops = labStops(v, labs) as any[];
  return {
    visit_id: v.visit_id,
    date: v.date,
    start_time: v.start_time,
    end_time: (v as any).end_time || "",
    org: { name: v.org?.name || "", name_local: v.org?.name_local || "", country: v.org?.country || "", type: v.org?.type || "" },
    headcount: v.headcount || 0,
    purpose: v.purpose || "",
    contact_teacher: v.contact_teacher || "",
    stops: stops.map((s) => ({ room: s.room, start: s.start, end: s.end, minutes: s.minutes })),
    presenters: (v as any).presenters || {},
    lab_hours: (v as any).lab_hours || {},
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

  const body = await readJSON<{ visit_id?: string; room?: string; name?: string; hours?: string }>(req);
  const room = String(body?.room || "");
  if (!/^30[1-5]$/.test(room)) return fail(400, "房號只有 301–305");
  const v = await store.getVisit(String(body?.visit_id || ""));
  if (!v) return fail(404, "找不到這一場");
  if (visitEndAt(v) < new Date()) return fail(409, "這一場已經結束了，不能再改");

  // 只改送上來的那幾個欄位：兩個人同時在填不同的格子，不該互相蓋掉
  const put = (field: "presenters" | "lab_hours", raw: unknown, max: number) => {
    if (raw === undefined) return;
    const map: Record<string, string> = { ...((v as any)[field] || {}) };
    const val = String(raw ?? "").trim().slice(0, max);
    if (val) map[room] = val;
    else delete map[room]; // 清空＝把這一格拿掉
    (v as any)[field] = map;
  };
  put("presenters", body?.name, 60);
  put("lab_hours", body?.hours, 120);
  (v as any).updated_at = nowISO();
  await store.putVisit(v);
  await triggerDriveSync(v.visit_id);
  return json({ ok: true, presenters: (v as any).presenters || {}, lab_hours: (v as any).lab_hours || {} });
};
