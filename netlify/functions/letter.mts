import { env, fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { recipientList } from "../../lib/visit.mjs";

/**
 * 訪後信／確認信。草擬要 Claude 寫一整封雙語信、寄出要一個一個打 Gmail API，
 * 兩件事都常常超過一般函式的 10 秒（回 504），所以都交給 letter-background。
 *
 * GET  /api/letter?job=<id>                                                          → 進度與結果
 * POST /api/letter {visit_id, kind: confirmation|thanks, sender: director|contact}    → 202 {job_id}；草稿存在 visit.letters
 * POST /api/letter {visit_id, action: "recipients"}                                   → 寄送清單（名單全員＋現場留信箱；不花時間，當場回）
 * POST /api/letter {visit_id, action: "send", subject, body, recipients:[{name,email}]} → 202 {job_id}；逐一寄出（Gmail API），未設定則回 sent:false 與 mailto
 */
export default async (req: Request) => {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.method === "GET") return pollJob(req, "信件");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(body.visit_id);
  if (!visit) return fail(404, "找不到這次參訪");

  if (body.action === "recipients") {
    const responses = await store.listResponses(visit.visit_id);
    return json({ ok: true, recipients: recipientList(visit, responses) });
  }

  const kind = body.kind === "confirmation" ? "confirmation" : "thanks";

  if (body.action === "send") {
    const recipients: { name: string; email: string }[] = Array.isArray(body.recipients) ? body.recipients.filter((r: any) => r?.email) : [];
    const subject = String(body.subject || "").trim();
    const text = String(body.body || "").trim();
    if (!recipients.length || !subject || !text) return fail(400, "需要 subject、body、recipients");
    if (!(env("GMAIL_CLIENT_ID") && env("GMAIL_CLIENT_SECRET") && env("GMAIL_REFRESH_TOKEN"))) {
      // 沒設定 Gmail 就沒有等待可言，當場把 mailto 交回去
      const mailto = `mailto:?bcc=${encodeURIComponent(recipients.map((r) => r.email).join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
      return json({ ok: true, sent: false, reason: "gmail_not_configured", mailto, recipients });
    }
    return startBackground("letter", { mode: "send", visit_id: visit.visit_id, kind, sender: body.sender, subject, body: text, recipients }, req);
  }

  return startBackground("letter", { mode: "draft", visit_id: visit.visit_id, kind, sender: body.sender === "contact" ? "contact" : "director" }, req);
};
