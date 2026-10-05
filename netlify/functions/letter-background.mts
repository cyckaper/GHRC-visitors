import { nowISO, siteUrl } from "../lib/http.mts";
import { loadPublicData } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { draftLetter } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { labRecipients, recipientList, scheduleFingerprint } from "../../lib/visit.mjs";
import { ensureRotaKey } from "./settings.mts";
import { triggerDriveSync } from "../lib/drive.mts";
import { gmailSend } from "../lib/mail.mts";
import type { Visit } from "../lib/types.mts";

type Input = {
  mode: "draft" | "send";
  visit_id: string;
  kind: "confirmation" | "thanks" | "notice" | "rundown";
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
  const KINDS = ["confirmation", "thanks", "notice", "rundown"] as const;
  const kind = (KINDS as readonly string[]).includes(input.kind) ? input.kind : "thanks";

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
    // 信寄完才記（寄信不能重來，所以放在 updateVisit 外面）；記的時候只動 letters／status，寫進最新的那一份
    await store.updateVisit(visit.visit_id, (v) => {
      v.letters = v.letters || ({} as Visit["letters"]);
      if (kind === "notice" || kind === "rundown") {
        // 內部通告：寄 email 只是備援（多半是複製到 LINE 群組），一樣記下寄給誰、什麼時候寄的
        const prev = v.letters[kind];
        v.letters[kind] = { subject, body: text, sender: input.sender || prev?.sender || "director", drafted_at: prev?.drafted_at || nowISO(), sent_to: [...(prev?.sent_to || []), ...sent], sent_at: nowISO() };
      } else if (kind === "thanks") {
        v.letters.thanks = { subject, body: text, sender: input.sender || v.letters.thanks?.sender || "director", drafted_at: v.letters.thanks?.drafted_at || nowISO(), sent_to: [...(v.letters.thanks?.sent_to || []), ...sent], sent_at: nowISO() };
        if (!failed.length) v.status = "done";
      } else {
        // 確認信也記下寄給誰、什麼時候寄的：信裡有來賓專頁的網址，寄出去之後那個網址就不能再改了。
        // 一併記下**寄出那一刻的行程指紋**：之後行程再改，畫面才有辦法說「對方手上的時間是舊的」。
        v.letters.confirmation = { subject, body: text, sender: input.sender || v.letters.confirmation?.sender || "contact", drafted_at: v.letters.confirmation?.drafted_at || nowISO(), sent_to: [...(v.letters.confirmation?.sent_to || []), ...sent], sent_at: nowISO(), fingerprint: scheduleFingerprint(v) };
        if (v.status === "draft") v.status = "confirmed";
      }
      v.updated_at = nowISO();
    });
    await triggerDriveSync(visit.visit_id);
    return { ok: failed.length === 0, sent: sent.length > 0, sent_to: sent, failed };
  }

  const sender = input.sender === "contact" ? "contact" : "director";
  const [labs, i18n] = await Promise.all([loadPublicData("labs"), loadPublicData("i18n")]);
  // 通告裡一定帶著支援人力表的連結（**自動產生**，主辦端不必先去設定按什麼）；
  // 只有通告要，回報與來賓信用不到——不為了它們去產一個連結
  const rotaUrl = kind === "notice" ? `${siteUrl(req)}/rota?key=${await ensureRotaKey()}` : "";
  const draft = await draftLetter({ kind, visit, labs, i18n, sender, siteUrl: siteUrl(req), rotaUrl });
  // AI 草擬要一兩分鐘：寫回去的時候只動 letters 這一格，而且寫進最新的那一份
  await store.updateVisit(visit.visit_id, (v) => {
    v.letters = v.letters || ({} as Visit["letters"]);
    if (kind === "notice" || kind === "rundown") {
      const prev = v.letters[kind];
      v.letters[kind] = { ...draft, sender, drafted_at: nowISO(), sent_to: prev?.sent_to, sent_at: prev?.sent_at };
    } else if (kind === "thanks") v.letters.thanks = { ...draft, sender, drafted_at: nowISO(), sent_to: v.letters.thanks?.sent_to, sent_at: v.letters.thanks?.sent_at };
    else v.letters.confirmation = { ...draft, drafted_at: nowISO() };
    v.updated_at = nowISO();
  });
  const recipients = kind === "notice" || kind === "rundown" ? labRecipients(visit, labs) : recipientList(visit, responses);
  return { kind, sender, draft, recipients };
});
