import { env, fail, json, nowISO, readJSON, requireAdmin } from "../lib/http.mts";
import { getStore } from "../lib/store.mts";
import { gmailConfigured } from "../lib/mail.mts";
import { pollJob, startBackground } from "../lib/jobs.mts";
import { labRecipients, recipientList } from "../../lib/visit.mjs";
import { loadPublicData } from "../lib/data.mts";
import { loadSettings } from "./settings.mts";

/**
 * 訪後信／確認信。草擬要 Claude 寫一整封雙語信、寄出要一個一個打 Gmail API，
 * 兩件事都常常超過一般函式的 10 秒（回 504），所以都交給 letter-background。
 *
 * 四種 kind：寄給來賓的 confirmation（訪前確認）與 thanks（訪後感謝）；寄給**中心自己**各研究室的
 * notice（行前通告：哪個單位什麼時候來，請各室安排簡報人員）與 rundown（回報：定案的時間、
 * 簡報人員與內容）。內部那兩則預設是**貼到 LINE 群組**用的，寄 email 只是備援。
 *
 * GET  /api/letter?job=<id>                                                          → 進度與結果
 * POST /api/letter {visit_id, kind: confirmation|thanks|notice|rundown, sender}       → 202 {job_id}；草稿存在 visit.letters
 * POST /api/letter {visit_id, action: "recipients", kind}                             → 寄送清單（不花時間，當場回）
 *   來賓那兩種＝名單全員＋現場留信箱；內部那兩種＝這一場動線上的研究室老師（信箱在「設定」）
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

  const KINDS = ["confirmation", "thanks", "notice", "rundown"] as const;
  const kind = (KINDS as readonly string[]).includes(body.kind) ? (body.kind as (typeof KINDS)[number]) : "thanks";
  const internal = kind === "notice" || kind === "rundown";

  if (body.action === "recipients") {
    if (internal) {
      const [labs, settings] = await Promise.all([loadPublicData("labs"), loadSettings()]);
      return json({ ok: true, recipients: labRecipients(visit, labs, settings.lab_emails) });
    }
    const responses = await store.listResponses(visit.visit_id);
    return json({ ok: true, recipients: recipientList(visit, responses) });
  }

  if (body.action === "send") {
    const recipients: { name: string; email: string }[] = Array.isArray(body.recipients) ? body.recipients.filter((r: any) => r?.email) : [];
    const subject = String(body.subject || "").trim();
    const text = String(body.body || "").trim();
    if (!recipients.length || !subject || !text) return fail(400, "需要 subject、body、recipients");
    if (!gmailConfigured()) {
      // 沒設定 Gmail 就沒有等待可言，當場把 mailto 交回去。
      // **內文不放進 mailto**：整封信 percent-encode 之後輕易破兩千字元，作業系統的信件程式
      // 會直接不開（按了沒反應，實際踩過）。收件人與主旨夠短，內文由後台複製到剪貼簿讓人貼上。
      const mailto = `mailto:?bcc=${encodeURIComponent(recipients.map((r) => r.email).join(","))}&subject=${encodeURIComponent(subject)}`;
      return json({ ok: true, sent: false, reason: "gmail_not_configured", mailto, recipients });
    }
    return startBackground("letter", { mode: "send", visit_id: visit.visit_id, kind, sender: body.sender, subject, body: text, recipients }, req);
  }

  return startBackground("letter", { mode: "draft", visit_id: visit.visit_id, kind, sender: body.sender === "contact" ? "contact" : "director" }, req);
};
