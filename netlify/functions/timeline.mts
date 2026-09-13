import { checkSignalKey, env, fail, json, nowISO, readJSON, requireAdmin, siteUrl, taipeiToday } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import type { Visit } from "../lib/types.mts";
import { isValidVisitId } from "../../lib/visit.mjs";
import { reconcileTimeline } from "../../lib/timeline.mjs";

const ROOMS = new Set(["briefing", "301", "302", "303", "304", "305"]); // briefing = 總體介紹（簡報室）；順序就是動線順序
const KEYED = new Set(["presentation", "nfc", "student"]);

/**
 * 現場訊號（工作包 4.2）。
 *  POST /api/timeline {room, source, at?, visit_id?, key?}   source=presentation|nfc|student 需 SIGNAL_KEY；guest 需 visit_id
 *  GET  /api/timeline?room=303&source=presentation&key=…       同上（給只能開網址的捷徑用）
 *  GET  /api/timeline?id=<visit_id>                             admin：原始訊號 ＋ 推補後的時間軸
 *  GET  /api/timeline?shortcuts=1                               admin：六個房間的捷徑與 NFC 網址（後台自己產貼紙）
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const store = getStore();

  // 現場訊號的捷徑網址（admin）：後台自己產捷徑與 NFC 貼紙，不必開終端機跑 scripts/make-shortcuts.mjs
  if (req.method === "GET" && url.searchParams.get("shortcuts")) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const site = siteUrl(req);
    const key = env("SIGNAL_KEY") || "";
    const label: Record<string, string> = { briefing: "總體介紹（簡報室）", "301": "Lab 301 智能室", "302": "Lab 302 規劃室", "303": "Lab 303 模擬室", "304": "Lab 304 全景影院", "305": "Lab 305 IVR" };
    return json({
      ok: true,
      site,
      // SIGNAL_KEY 本來就會印在門口的 NFC 貼紙網址裡，而且只能寫動線時間、讀不到任何資料；
      // 這裡只給登入過的主辦端看（比貼在牆上還少曝光）。Claude／Google 那些金鑰仍然絕不出前端。
      key_set: !!key,
      rooms: [...ROOMS].map((room) => ({
        room,
        label: label[room] || room,
        presentation_url: `${site}/api/timeline?room=${room}&source=presentation&key=${encodeURIComponent(key)}`,
        nfc_url: `${site}/api/timeline?room=${room}&source=nfc&key=${encodeURIComponent(key)}`,
      })),
    });
  }

  if (req.method === "GET" && url.searchParams.get("id")) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const id = url.searchParams.get("id")!;
    const visit = await store.getVisit(id);
    if (!visit) return fail(404, "找不到這次參訪");
    const signals = await store.listTimeline(id);
    return json({ ok: true, signals, timeline: reconcileTimeline(visit, signals) });
  }

  let input: any = {};
  if (req.method === "POST") input = (await readJSON<any>(req)) || {};
  else if (req.method === "GET") input = Object.fromEntries(url.searchParams.entries());
  else return fail(405, "method not allowed");

  const room = String(input.room || "").trim();
  const source = String(input.source || "nfc").trim();
  if (!ROOMS.has(room)) return fail(400, "room 需為 briefing 或 301–305");
  if (KEYED.has(source)) {
    if (!checkSignalKey(req, input.key)) return fail(401, "SIGNAL_KEY 不對或未設定");
  } else if (source === "guest") {
    if (!isValidVisitId(String(input.visit_id || ""))) return fail(400, "guest 訊號需要 visit_id");
  } else return fail(400, "source 需為 presentation|nfc|student|guest");

  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) return fail(400, "at 不是有效時間");

  let visitId = String(input.visit_id || "");
  if (!visitId) {
    const v = await resolveTodaysVisit(await store.listVisits(), at);
    if (!v) return fail(404, "今天沒有排定的參訪，訊號未記錄");
    visitId = v.visit_id;
  } else if (!(await store.getVisit(visitId))) return fail(404, "找不到這次參訪");

  await store.appendTimeline({ visit_id: visitId, room, at: at.toISOString(), source, note: input.note ? String(input.note).slice(0, 200) : undefined });
  return json({ ok: true, visit_id: visitId, room, source, at: at.toISOString(), recorded_at: nowISO() });
};

/** 沒帶 visit_id 的訊號：找今天（台北）的參訪；多場時取時間窗涵蓋 now 的，否則最接近開始時間的。 */
export function resolveTodaysVisit(visits: Visit[], now: Date): Visit | null {
  const today = taipeiToday(now);
  const todays = visits.filter((v) => v.date === today);
  if (!todays.length) return null;
  const startOf = (v: Visit) => new Date(`${v.date}T${v.start_time || "00:00"}:00+08:00`).getTime();
  const inWindow = todays.filter((v) => {
    const s = startOf(v);
    return now.getTime() >= s - 15 * 60000 && now.getTime() <= s + ((v.duration_minutes || 90) + 60) * 60000;
  });
  const pool = inWindow.length ? inWindow : todays;
  return pool.sort((a, b) => Math.abs(startOf(a) - now.getTime()) - Math.abs(startOf(b) - now.getTime()))[0];
}
