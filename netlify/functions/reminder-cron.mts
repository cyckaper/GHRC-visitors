import type { Config } from "@netlify/functions";
import { nowISO, requireCron, siteUrl } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { gmailConfigured, gmailSend } from "../lib/mail.mts";
import { reminderTo } from "./settings.mts";
import { visitEndAt, visitStartAt, wrapupTodo } from "../../lib/visit.mjs";
import type { Visit } from "../lib/types.mts";

/**
 * 收工提醒（每十五分鐘看一次）。
 *
 * 工作包寫的是「依議程結束時間推播提醒」。以前只有一個 .ics 要人自己下載、自己匯入行事曆，
 * 等於沒有提醒。這裡改成：**今日流程結束的時間一到，寄一封信到中心信箱**——手機收信就會跳。
 * 內容是收工那四件事還缺哪幾件，附一個直接打開收工頁的連結。
 *
 * 規矩：一場只寄一次（`visit.reminders.wrapup_sent_at`）；四件事都做完了就不寄；
 * 只看結束後六小時內的場次（功能上線前就過去的參訪不會突然被翻出來提醒）。
 * 寄成功才記，寄失敗下一輪再試。寫回參訪時**不動 `updated_at`**，否則每天的 Drive 備份會被吵醒。
 */
const WINDOW_HOURS = 6;

export default async (req: Request) => {
  const denied = await requireCron(req);
  if (denied) return denied;
  if (!gmailConfigured()) return new Response("Gmail 尚未設定，略過");
  const to = await reminderTo();
  if (!to) return new Response("還沒設定收工提醒的收件者，略過");
  const store = getStore();
  const site = siteUrl(req);
  const now = Date.now();
  const sent: string[] = [];
  const failed: string[] = [];

  for (const v of await store.listVisits()) {
    if ((v as any).reminders?.wrapup_sent_at) continue;
    const end = visitEndAt(v).getTime();
    if (end > now || now - end > WINDOW_HOURS * 3600_000) continue;
    const todo = wrapupTodo(v);
    if (todo.every((t: { done: boolean }) => t.done)) continue; // 四件事都做完了，不必吵
    try {
      await gmailSend(to, subject(v), body(v, todo, site));
      (v as any).reminders = { ...((v as any).reminders || {}), wrapup_sent_at: nowISO(), wrapup_to: to };
      await store.putVisit(v);
      sent.push(v.visit_id);
    } catch (e: any) {
      failed.push(`${v.visit_id}（${e?.message || e}）`); // 沒記 sent_at，下一輪會再試
    }
  }
  return new Response([sent.length ? `已提醒 ${sent.join("、")}` : "沒有要提醒的場次", failed.length ? `失敗：${failed.join("；")}` : ""].filter(Boolean).join("｜"));
};

const hhmm = (d: Date) => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

const subject = (v: Visit) => `收工提醒：${v.org?.name || v.visit_id}（${v.date}）`;

function body(v: Visit, todo: { label: string; done: boolean; detail: string }[], site: string): string {
  return [
    `${v.org?.name || v.visit_id} 的參訪剛結束（${v.date} ${hhmm(visitStartAt(v))}–${hhmm(visitEndAt(v))}）。`,
    "",
    "來賓離開後這幾件事，幾分鐘做完——隔一天記憶就掉了：",
    ...todo.map((t, i) => `${i + 1}. ${t.label}　${t.done ? `✓ 已做${t.detail ? `（${t.detail}）` : ""}` : "← 還沒"}`),
    "",
    `直接打開收工頁：${site}/admin.html#wrapup=${v.visit_id}`,
    "",
    "（這封是系統依今日流程的結束時間自動寄的，一場只寄一次。收件地址在後台「設定」分頁可以改。）",
  ].join("\n");
}

// 每十五分鐘，但只在台北時間 08:00–21:59（UTC 0–13 點）——沒有參訪在半夜結束
export const config: Config = { schedule: "*/15 0-13 * * *" };
