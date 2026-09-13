import { nowISO, siteUrl } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { draftLetter } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { recipientList } from "../../lib/visit.mjs";
import { triggerDriveSync } from "../lib/drive.mts";
import { gmailSend } from "../lib/mail.mts";

type Input = {
  mode: "draft" | "send";
  visit_id: string;
  kind: "confirmation" | "thanks";
  sender?: string;
  subject?: string;
  body?: string;
  recipients?: { name?: string; email: string }[];
};

/**
 * 信件（背景函式，15 分鐘上限）：草擬要 Claude 寫一整封雙語信，寄出要一封一封打 Gmail API，
 * 兩件事在一般函式的 10 秒裡都做不完——寄到一半被砍掉更糟（有些人收到了、紀錄卻沒寫回去）。
 */
export default backgroundHandler<Input>("信件", async (input, req) => {
  const store = getStore();
  const visit = await store.getVisit(String(input.visit_id));
  if (!visit) throw new Error("找不到這次參訪");
  const responses = await store.listResponses(visit.visit_id);
  const kind = input.kind === "confirmation" ? "confirmation" : "thanks";

  if (input.mode === "send") {
    const recipients = (input.recipients || []).filter((r) => r?.email);
    const subject = String(input.subject || "");
    const text = String(input.body || "");
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
    if (kind === "thanks") {
      visit.letters.thanks = { subject, body: text, sender: input.sender || visit.letters.thanks?.sender || "director", drafted_at: visit.letters.thanks?.drafted_at || nowISO(), sent_to: [...(visit.letters.thanks?.sent_to || []), ...sent], sent_at: nowISO() };
      if (!failed.length) visit.status = "done";
    } else {
      // 確認信也記下寄給誰、什麼時候寄的：信裡有來賓專頁的網址，寄出去之後那個網址就不能再改了
      visit.letters.confirmation = { subject, body: text, sender: input.sender || visit.letters.confirmation?.sender || "contact", drafted_at: visit.letters.confirmation?.drafted_at || nowISO(), sent_to: [...(visit.letters.confirmation?.sent_to || []), ...sent], sent_at: nowISO() };
      if (visit.status === "draft") visit.status = "confirmed";
    }
    visit.updated_at = nowISO();
    await store.putVisit(visit);
    await triggerDriveSync(visit.visit_id);
    return { ok: failed.length === 0, sent: sent.length > 0, sent_to: sent, failed };
  }

  const sender = input.sender === "contact" ? "contact" : "director";
  const [labs, i18n] = await Promise.all([loadPublicData("labs"), loadPublicData("i18n")]);
  const mostWanted = [...new Set([...(visit.dictation?.extracted?.most_wanted_rooms || []), ...responses.flatMap((r) => r.most_wanted_rooms || [])])];
  const draft = await draftLetter({ kind, visit, labs, i18n, sender, siteUrl: siteUrl(req), mostWantedRooms: mostWanted });
  if (kind === "thanks") visit.letters.thanks = { ...draft, sender, drafted_at: nowISO(), sent_to: visit.letters.thanks?.sent_to, sent_at: visit.letters.thanks?.sent_at };
  else visit.letters.confirmation = { ...draft, drafted_at: nowISO() };
  visit.updated_at = nowISO();
  await store.putVisit(visit);
  return { kind, sender, draft, recipients: recipientList(visit, responses) };
});
