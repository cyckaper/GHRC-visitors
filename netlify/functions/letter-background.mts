import { nowISO, siteUrl } from "../lib/http.mts";
import { loadPublicData, webDeckReady } from "../lib/data.mts";
import { getStore } from "../lib/store.mts";
import { draftLetter } from "../lib/ai.mts";
import { backgroundHandler } from "../lib/jobs.mts";
import { labRecipients, recipientList, sanitizeMaterials, scheduleFingerprint } from "../../lib/visit.mjs";
import { ensureRotaKey } from "./settings.mts";
import { triggerDriveSync } from "../lib/drive.mts";
import { gmailReady, gmailSend, photoAttachments, type MailAttachment } from "../lib/mail.mts";
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
    // 感謝信把合照直接附在信裡（明確指示：「讓照片直接附在信裡」）：讀一次，每一封都附同一批
    const photos = kind === "thanks" && recipients.length ? await photoAttachments(sanitizeMaterials(visit.materials).photos) : null;
    const attachments: MailAttachment[] = photos?.attachments || [];
    const unattached: { email: string; error: string }[] = []; // 照片附不上去、只寄了信的
    for (const r of recipients) {
      try {
        await gmailSend(r.email, subject, text, attachments);
        sent.push({ name: r.name || "", email: r.email });
      } catch (e: any) {
        if (!attachments.length) {
          failed.push({ email: r.email, error: String(e?.message || e) });
          continue;
        }
        // 附了照片寄不出去（太大、收信端或 Gmail 不收）：信照樣寄——信裡本來就有專頁相簿的連結，不能為了照片讓感謝信卡住
        try {
          await gmailSend(r.email, subject, text);
          sent.push({ name: r.name || "", email: r.email });
          unattached.push({ email: r.email, error: String(e?.message || e) });
        } catch (e2: any) {
          failed.push({ email: r.email, error: String(e2?.message || e2) });
        }
      }
    }
    const withPhotos = sent.filter((s) => !unattached.some((u) => u.email === s.email)).length;
    // 信寄完才記（寄信不能重來，所以放在 updateVisit 外面）；記的時候只動 letters／status，寫進最新的那一份
    await store.updateVisit(visit.visit_id, (v) => {
      v.letters = v.letters || ({} as Visit["letters"]);
      if (kind === "notice" || kind === "rundown") {
        // 內部通告：寄 email 只是備援（多半是複製到 LINE 群組），一樣記下寄給誰、什麼時候寄的
        const prev = v.letters[kind];
        v.letters[kind] = { subject, body: text, sender: input.sender || prev?.sender || "director", drafted_at: prev?.drafted_at || nowISO(), sent_to: [...(prev?.sent_to || []), ...sent], sent_at: nowISO() };
      } else if (kind === "thanks") {
        v.letters.thanks = { subject, body: text, sender: input.sender || v.letters.thanks?.sender || "director", drafted_at: v.letters.thanks?.drafted_at || nowISO(), sent_to: [...(v.letters.thanks?.sent_to || []), ...sent], sent_at: nowISO(), ...(attachments.length && withPhotos ? { photos_attached: attachments.length } : {}) };
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
    return {
      ok: failed.length === 0,
      sent: sent.length > 0,
      sent_to: sent,
      failed,
      // 附了幾張合照（給幾個人）、放不下沒附的幾張、照片附不上去只寄了信的
      ...(photos ? { photos: { attached: withPhotos ? attachments.length : 0, to: withPhotos, skipped: photos.skipped, unattached } } : {}),
    };
  }

  const sender = input.sender === "contact" ? "contact" : "director";
  const [labs, i18n] = await Promise.all([loadPublicData("labs"), loadPublicData("i18n")]);
  // 通告裡一定帶著支援人力表的連結（**自動產生**，主辦端不必先去設定按什麼）；
  // 只有通告要，回報與來賓信用不到——不為了它們去產一個連結
  const rotaUrl = kind === "notice" ? `${siteUrl(req)}/rota?key=${await ensureRotaKey()}` : "";
  // 感謝信自動帶入當天的簡報：沒有放上簡報 PDF 就給網頁版簡報的連結（建好了才給）
  const webDeck = kind === "thanks" ? await webDeckReady() : false;
  // 合照會不會直接附在信裡（明確指示：「讓照片直接附在信裡」）：用 Gmail 寄才附得上去，信裡就照實寫附了幾張
  const attachedPhotos = kind === "thanks" && (await gmailReady()) ? (await photoAttachments(sanitizeMaterials(visit.materials).photos)).attachments.length : 0;
  const draft = await draftLetter({ kind, visit, labs, i18n, sender, siteUrl: siteUrl(req), rotaUrl, webDeck, attachedPhotos });
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
