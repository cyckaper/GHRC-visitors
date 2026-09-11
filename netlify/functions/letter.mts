import { env, fail, json, nowISO, readJSON, requireAdmin, siteUrl } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { draftLetter } from "../lib/ai.mts";
import { recipientList } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";

/**
 * POST /api/letter {visit_id, kind: confirmation|thanks, sender: director|contact}   → 草稿（存在 visit.letters）
 * POST /api/letter {visit_id, action: "recipients"}                                   → 寄送清單（名單全員＋現場留信箱）
 * POST /api/letter {visit_id, action: "send", subject, body, recipients:[{name,email}]} → 逐一寄出（Gmail API）；未設定則回 sent:false 與 mailto
 */
export default async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJSON<any>(req);
  if (!body?.visit_id) return fail(400, "需要 visit_id");
  const store = getStore();
  const visit = await store.getVisit(body.visit_id);
  if (!visit) return fail(404, "找不到這次參訪");
  const responses = await store.listResponses(visit.visit_id);

  if (body.action === "recipients") return json({ ok: true, recipients: recipientList(visit, responses) });

  if (body.action === "send") {
    const recipients: { name: string; email: string }[] = Array.isArray(body.recipients) ? body.recipients.filter((r: any) => r?.email) : [];
    const subject = String(body.subject || "").trim();
    const text = String(body.body || "").trim();
    if (!recipients.length || !subject || !text) return fail(400, "需要 subject、body、recipients");
    const gmailReady = !!(env("GMAIL_CLIENT_ID") && env("GMAIL_CLIENT_SECRET") && env("GMAIL_REFRESH_TOKEN"));
    if (!gmailReady) {
      const mailto = `mailto:?bcc=${encodeURIComponent(recipients.map((r) => r.email).join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
      return json({ ok: true, sent: false, reason: "gmail_not_configured", mailto, recipients });
    }
    const sent: { name: string; email: string }[] = [];
    const failed: { email: string; error: string }[] = [];
    for (const r of recipients) {
      try {
        await gmailSend(r.email, subject, text);
        sent.push({ name: r.name || "", email: r.email });
      } catch (e: any) {
        failed.push({ email: r.email, error: String(e?.message || e) });
      }
    }
    const kind = body.kind === "confirmation" ? "confirmation" : "thanks";
    if (kind === "thanks") {
      visit.letters.thanks = { subject, body: text, sender: body.sender || visit.letters.thanks?.sender || "director", drafted_at: visit.letters.thanks?.drafted_at || nowISO(), sent_to: [...(visit.letters.thanks?.sent_to || []), ...sent], sent_at: nowISO() };
      if (!failed.length) visit.status = "done";
    } else {
      visit.letters.confirmation = { subject, body: text, drafted_at: visit.letters.confirmation?.drafted_at || nowISO() };
      if (visit.status === "draft") visit.status = "confirmed";
    }
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return json({ ok: failed.length === 0, sent: sent.length > 0, sent_to: sent, failed });
  }

  const kind = body.kind === "confirmation" ? "confirmation" : "thanks";
  const sender = body.sender === "contact" ? "contact" : "director";
  const [labs, i18n] = await Promise.all([loadPublicData("labs"), loadPublicData("i18n")]);
  const mostWanted = [...new Set([...(visit.dictation?.extracted?.most_wanted_rooms || []), ...responses.flatMap((r) => r.most_wanted_rooms || [])])];
  try {
    const draft = await draftLetter({ kind, visit, labs, i18n, sender, siteUrl: siteUrl(req), mostWantedRooms: mostWanted });
    if (kind === "thanks") visit.letters.thanks = { ...draft, sender, drafted_at: nowISO(), sent_to: visit.letters.thanks?.sent_to, sent_at: visit.letters.thanks?.sent_at };
    else visit.letters.confirmation = { ...draft, drafted_at: nowISO() };
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    return json({ ok: true, kind, sender, draft, recipients: recipientList(visit, responses) });
  } catch (e: any) {
    return fail(502, `草擬失敗：${e?.message || e}`);
  }
};

let gmailToken: { token: string; exp: number } | null = null;

async function gmailAccessToken(): Promise<string> {
  if (gmailToken && gmailToken.exp > Date.now() + 60000) return gmailToken.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID")!, client_secret: env("GMAIL_CLIENT_SECRET")!, refresh_token: env("GMAIL_REFRESH_TOKEN")!, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(`Gmail token ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  gmailToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

async function gmailSend(to: string, subject: string, text: string): Promise<void> {
  const from = env("GMAIL_SENDER") || "me";
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64"),
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${await gmailAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send ${r.status}: ${await r.text()}`);
}
