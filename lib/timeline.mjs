/**
 * 動線時間軸推補（工作包 4.2 訊號三／第 5 章「用三個訊號校正／推補完整時間軸」）。
 *
 * 輸入：訪前排程（各室預定進入時間與分鐘數）＋ 現場訊號（簡報捷徑、NFC、備援）。
 * 規則：
 *  1. 有訊號的房間，以最早的主要訊號（presentation／nfc）為進入時間；沒有主要訊號才用備援（student／guest）。
 *  2. 沒有訊號的房間，依「前一個有訊號房間的實際－預定」偏移量平移預定時間。
 *  3. 離開時間 = 下一間（依實際進入時間排序）的進入時間；最後一間 = 進入 + 預定分鐘。
 *  4. 完全沒有訊號時，整條時間軸就是排程本身（來源 schedule）。
 */

const PRIMARY = new Set(["presentation", "nfc"]);
const FALLBACK = new Set(["student", "guest"]);

/** 依訪前排程算出各室預定進入時間。tour 起點 = 行程中 kind=tour 區塊的 start，否則 = visit.start_time。 */
export function plannedEntries(visit) {
  const date = visit.date;
  const tour = (visit.programme || []).find((p) => p.kind === "tour");
  const startHHMM = tour?.start || visit.start_time || "10:00";
  let t = toDate(date, startHHMM);
  const rows = [];
  for (const step of visit.itinerary || []) {
    const minutes = Number(step.minutes) || 10;
    rows.push({ room: String(step.room), planned: new Date(t), minutes });
    t = new Date(t.getTime() + minutes * 60000);
  }
  return rows;
}

/**
 * @param {object} visit  visits 表的一筆
 * @param {Array<{room:string, at:string, source:string}>} signals  timeline 表的原始訊號
 * @returns {Array<{room, enter, exit, minutes, source}>}
 */
export function reconcileTimeline(visit, signals = []) {
  const plan = plannedEntries(visit);
  if (plan.length === 0) return [];

  const byRoom = new Map();
  for (const s of signals) {
    if (!s || !s.room || !s.at) continue;
    const at = new Date(s.at);
    if (Number.isNaN(at.getTime())) continue;
    const room = String(s.room);
    const list = byRoom.get(room) || [];
    list.push({ at, source: s.source || "unknown" });
    byRoom.set(room, list);
  }

  const pick = (room) => {
    const list = byRoom.get(room);
    if (!list || list.length === 0) return null;
    const primary = list.filter((x) => PRIMARY.has(x.source)).sort((a, b) => a.at - b.at);
    if (primary.length) return primary[0];
    const fb = list.filter((x) => FALLBACK.has(x.source)).sort((a, b) => a.at - b.at);
    if (fb.length) return fb[0];
    return list.sort((a, b) => a.at - b.at)[0];
  };

  let offsetMs = 0;
  let anySignal = false;
  const entries = plan.map((p) => {
    const sig = pick(p.room);
    if (sig) {
      anySignal = true;
      offsetMs = sig.at.getTime() - p.planned.getTime();
      return { room: p.room, enter: sig.at, minutes: p.minutes, source: sig.source };
    }
    return { room: p.room, enter: new Date(p.planned.getTime() + offsetMs), minutes: p.minutes, source: "schedule" };
  });

  entries.sort((a, b) => a.enter - b.enter);
  return entries.map((e, i) => {
    const next = entries[i + 1];
    const exit = next ? next.enter : new Date(e.enter.getTime() + e.minutes * 60000);
    const minutes = Math.max(0, Math.round((exit - e.enter) / 60000));
    return {
      room: e.room,
      enter: e.enter.toISOString(),
      exit: exit.toISOString(),
      minutes,
      source: anySignal ? e.source : "schedule",
    };
  });
}

export function toDate(dateStr, hhmm) {
  const [h, m] = String(hhmm || "00:00").split(":").map((x) => parseInt(x, 10) || 0);
  // 以台北時間（UTC+8）解讀排程
  return new Date(`${dateStr}T${pad(h)}:${pad(m)}:00+08:00`);
}

export function pad(n) {
  return String(n).padStart(2, "0");
}
