import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "./http.mts";
import { isMock } from "./data.mts";
import type { DictationExtract, ResponseRow, SignbookEntry, TimelineSignal, Visit } from "./types.mts";
import type { Extracted } from "./files.mts";
import { allocateProgramme, pageContents } from "../../lib/visit.mjs";

/**
 * 所有 AI 呼叫集中在這裡（工作包第 5 章）。
 * - 結構化輸出一律用 zod schema + messages.parse。
 * - AI_MOCK=1 時回傳固定範例（本機開發／測試不需金鑰）。
 * - 語音轉文字只用於主持人的三十秒口述（Whisper）。
 */

const TEACHERS = ["張俊彥", "林寶秀", "陳惠美", "張伯茹", "鄭佳昆"] as const;
const ROOMS = ["301", "302", "303", "304", "305"] as const;
const LANGS = ["en", "zh", "ko", "ja"] as const;
const ORG_TYPES = ["government", "university", "enterprise", "school", "ngo", "other"] as const;

/**
 * 中心事實：所有提示詞共用。避免 AI 把來信裡的其他單位（例如智慧溫室）寫成中心的、給步行鞋履之類的提醒、
 * 或在信裡感謝中心自己的老師（第一場試跑的感謝信與確認信都出過這些錯）。
 */
export const CENTER_FACTS = `中心事實（所有輸出都要遵守）：
- 綠色健康研究中心（GHRC）只有五間研究室：301 健康景觀智能室（張俊彥）、302 療癒環境規劃室（林寶秀）、303 景觀環境模擬室（陳惠美）、304 全景影院體驗室（張伯茹）、305 IVR 研究室（鄭佳昆）。全部在臺大園藝系造園館三樓，彼此相鄰，全程室內；總體介紹預設在 302。
- 來信、名單或行程裡出現的其他地點與單位（例如智慧溫室、其他系所或中心）不是本中心的，不能寫成「我們的」研究室、團隊或設施；若非提不可，只能說是來賓當天另外參訪的單位，不替他們發言。
- 不要給步行、鞋履、天氣、館舍之間移動之類的提醒（全程室內、同一層樓）。
- 信件不感謝中心自己的人（主任、對口老師、同仁），感謝對象只有來賓與對方單位的窗口；也不替中心的人邀功。
- 不放中心總預算數字；HEALS Design 是 301 專屬方法論，不是中心層級的方法論。`;

function model(): string {
  return env("CLAUDE_MODEL") || "claude-opus-5";
}

function client(): Anthropic {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 未設定（或設 AI_MOCK=1 用範例資料）");
  return new Anthropic({ apiKey });
}

type UserContent = string | Anthropic.ContentBlockParam[];

async function structured<T>(schema: z.ZodType<T>, system: string, user: UserContent, maxTokens = 8000): Promise<T> {
  const res = await client().messages.parse({
    model: model(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema as any) },
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒絕了這個請求");
  if (!res.parsed_output) throw new Error("模型輸出無法解析成預期格式");
  return res.parsed_output as T;
}

async function plain(system: string, user: UserContent, maxTokens = 6000): Promise<string> {
  const res = await client().messages.create({
    model: model(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒絕了這個請求");
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ───────────────────────── 1. 讀信 ─────────────────────────

const GuestSchema = z.object({
  name: z.string(),
  title: z.string(),
  email: z.string(),
  role: z.enum(["lead", "member"]),
  affiliation: z.string(),
});

export const ExtractedSchema = z.object({
  org: z.object({ name: z.string(), name_local: z.string(), type: z.enum(ORG_TYPES), country: z.string() }),
  guests: z.array(GuestSchema),
  headcount: z.number().int(),
  date: z.string(),
  start_time: z.string(),
  duration_minutes: z.number().int(),
  contact_teacher: z.string(),
  purpose: z.string(),
  interests: z.array(z.string()),
  language: z.enum(LANGS),
  candidate_dates: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
export type ExtractedVisit = z.infer<typeof ExtractedSchema>;

const EXTRACT_SYSTEM = `你是臺大生農學院綠色健康研究中心（GHRC）的參訪承辦助理。從主辦端貼上的 email 往來（可能中英夾雜、含轉寄與簽名檔）與上傳的相關檔案（名單 Word／Excel／CSV 轉出的文字、PDF、名單照片）抽出參訪資料。

規則：
- guests：來訪方**每一位**被點名的人都要列出，含職稱與 email（隨行者的 email 是訪後信寄送的關鍵，不要只留主要窗口）。**名單檔（<file> 區塊、PDF、照片）裡的每一列都是一個人**，表格欄位常見順序是姓名／職稱／單位／email，請對應好；沒有 email 的人也要列，email 留空。主要來賓 role=lead，其餘 member。affiliation 填該人的單位（可能與 org 不同）。
- org：來訪單位的正式名稱（英文為主，name_local 放當地語言名稱）；type 取 government／university／enterprise／school／ngo／other；country 用英文國名。
- headcount：預計人數；不知道就用 guests 人數。
- date：**已確定**的參訪日期（YYYY-MM-DD）；未定則留空字串，把候選日期放 candidate_dates。start_time 用 HH:MM（台北時間），未提到留空。duration_minutes 可用時間（分鐘），未提到給 0。
- contact_teacher：中心這邊負責聯絡的老師，只能是 ${TEACHERS.join("／")} 之一，看不出來留空。
- purpose：來訪目的一句話；interests：信中透露的研究興趣關鍵字（英文，每項 2–6 字）。
- language：來賓的第二語言層：台灣／華語團 zh、韓國 ko、日本 ja，其餘 en。
- 不要編造。不知道的欄位留空字串／空陣列／0，並在 uncertainties 用中文列出需要人工確認的事項。`;

export async function extractVisit(emailText: string, today: string, attachments: Extracted[] = []): Promise<ExtractedVisit> {
  const texts = attachments.filter((a): a is Extract<Extracted, { kind: "text" }> => a.kind === "text");
  const binaries = attachments.filter((a) => a.kind === "document" || a.kind === "image");
  let text = emailText.trim() ? `以下是 email 往來：\n\n<email>\n${emailText}\n</email>` : "（沒有 email 內文，資料在附件裡）";
  for (const t of texts) text += `\n\n<file name="${t.name.replace(/"/g, "'")}">\n${t.text}\n</file>`;
  if (isMock()) return mockExtract(text);
  const content: Anthropic.ContentBlockParam[] = [];
  for (const b of binaries) {
    if (b.kind === "document") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b.data }, title: b.name });
    else if (b.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });
  }
  if (binaries.length) text += `\n\n另有 ${binaries.length} 個附件（PDF／照片）已附在前面，裡面的名單也要讀出。`;
  content.push({ type: "text", text });
  return structured(ExtractedSchema, `${EXTRACT_SYSTEM}\n\n${CENTER_FACTS}\n今天是 ${today}。`, content, 12000);
}

// ───────────────────────── 2. 排程與選頁 ─────────────────────────

export const PlanSchema = z.object({
  programme: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      kind: z.enum(["briefing", "tour", "discussion", "photo", "other"]),
      title_en: z.string(),
      title_2nd: z.string(),
      rooms: z.array(z.string()),
      slides_range: z.string(),
    }),
  ),
  itinerary: z.array(z.object({ room: z.enum(["briefing", ...ROOMS]), minutes: z.number().int(), focus: z.string() })),
  slides: z.array(z.number().int()),
  cover_text: z.object({ org_line: z.string(), guest_lines: z.array(z.string()), date_line: z.string() }),
  text_edits: z.array(z.object({ slide: z.number().int(), find: z.string(), replace: z.string() })),
  rationale: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

const PLAN_SYSTEM = `你替 GHRC 排一次參訪的行程並從母簡報挑頁。

母簡報規則（不可違反）：
- 章節編號與實體頁序不一致，只能依提供的頁次索引選頁，不要自己推測。
- always=true 的頁（封面、今日流程、簡報架構、核心宣稱、謝謝）永遠保留。
- 每頁約 40–60 秒（索引裡的 minutes），影片頁另計；總頁數要塞得進「總體簡報」區塊的分鐘數。
- 選頁偏好：政府單位偏政策與場域落地；大學偏研究與學生交流；企業偏應用與委託研究；學生團偏影片與體驗。以索引的 audience 與 lab 標記為線索，並參考來賓興趣。
- 實驗室頁：要參訪的房間才放它的頁；分隔頁（role=divider）只在放了該實驗室內容時保留。
- 最後的「您最想看哪一部分」頁與 QR 頁由產檔程式另外加，不要選。
- 不放中心總預算數字；HEALS Design 是 301 專屬方法論。

行程規則：
- 從 start_time 開始，總長 = duration_minutes，區塊順序固定是 briefing（總體簡報）→ tour（依序參訪研究室）→ discussion（**綜合討論，一定要有**；title_en 用 "General discussion"，title_2nd 用「綜合討論」或對應語言）→ photo（合照，5 分鐘，可省略）。
- **時間分配的預設規則**：總體介紹 20 分、每間研究室 20 分、合照 5 分，前面扣掉之後**剩下的時間全部給綜合討論**。只有總時間不夠時才縮短研究室（每間至少 5 分）與總體介紹（至少 10 分），綜合討論至少 10 分。
- itinerary 是現場動線。**第一步固定是 room="briefing"（總體介紹，在簡報室）**，minutes = briefing 區塊長度、focus 寫這場總體簡報要強調什麼；之後才是 tour 區塊內各房間的順序與分鐘數，預設 301→302→303→304→305，依興趣可調整或省略房間；房間分鐘數總和 = tour 區塊長度。
- title_2nd 用來賓的第二語言（language）；language=en 時 title_2nd 留空。
- slides_range 用「01 – 12」這種格式描述該區塊對應的**輸出後**頁碼範圍（輸出後頁碼 = 選用頁在 slides 陣列裡的序號，從 1 起算），非簡報區塊填「—」。
- cover_text：封面要替換的三段文字：org_line（單位名稱，英文為主，可加當地語）、guest_lines（主要來賓一到三行：姓名 職稱）、date_line（例如「7 October 2026 · 2026年10月7日」）。
- text_edits：只有在提供母簡報文字（master_text）時才填。針對第 1、2、3 頁，逐一給出 find（母簡報裡**逐字**存在的文字段落）與 replace（新文字），用來改單位名稱、流程表的時間／說明／頁碼、Contents 的章節列表。沒有 master_text 就給空陣列。
- rationale：用中文兩三句說明為什麼這樣排。
- 總體介紹的地點由主辦端決定（見 briefing_location，預設 302），不用寫進輸出。

${CENTER_FACTS}`;

export async function planVisit(visit: Visit, slidesIndex: any, labs: any, masterText: any | null): Promise<Plan> {
  if (isMock()) return mockPlan(visit, slidesIndex);
  const payload = {
    visit: {
      org: visit.org, guests: visit.guests, headcount: visit.headcount, date: visit.date, start_time: visit.start_time,
      duration_minutes: visit.duration_minutes, purpose: visit.purpose, interests: visit.interests, language: visit.language, contact_teacher: visit.contact_teacher,
    },
    briefing_location: visit.itinerary?.find((s) => s.room === "briefing")?.location || "302",
    slide_index: slidesIndex.slides,
    labs: (labs.labs || []).map((l: any) => ({ room: l.room, name_en: l.name_en, lead: l.lead?.name_zh, one_line_en: l.one_line_en })),
    master_text: masterText ? { slides: (masterText.slides || []).filter((s: any) => s.n <= 3) } : null,
  };
  return structured(PlanSchema, PLAN_SYSTEM, JSON.stringify(payload), 12000);
}

// ───────────────────────── 3. 信件 ─────────────────────────

const LetterSchema = z.object({ subject: z.string(), body: z.string() });

export interface LetterContext {
  kind: "confirmation" | "thanks";
  visit: Visit;
  labs: any;
  i18n: any;
  sender: "director" | "contact";
  siteUrl: string;
  mostWantedRooms: string[];
}

function senderBlock(ctx: LetterContext): string {
  if (ctx.sender === "contact" && ctx.visit.contact_teacher && ctx.visit.contact_teacher !== "張俊彥") {
    const lab = (ctx.labs.labs || []).find((l: any) => l.lead?.name_zh === ctx.visit.contact_teacher);
    return `${ctx.visit.contact_teacher}${lab ? ` ${lab.lead.name_en}, ${lab.lead.title_en}, Lab ${lab.room}` : ""}, Green Health Research Center, NTU`;
  }
  return "張俊彥 Chun-Yen Chang, Distinguished Professor and Director, Green Health Research Center, National Taiwan University";
}

/** 訪後信裡三個回應項目的固定文字（措辭不可改成滿意度語氣）。 */
export function responseBlock(lang: string, i18n: any, url: string): string {
  const t = i18n[lang] || i18n.en;
  const e = i18n.en;
  const bi = (k: string) => (lang === "en" ? e[k] : `${e[k]}\n${t[k]}`);
  return [
    "────────",
    bi("respond_intro"),
    "",
    `1. ${bi("cooperate")}`,
    `2. ${bi("next")}`,
    `3. ${bi("ask_better")}`,
    `   ${bi("one_sentence")}`,
    `   ${bi("anonymous")}`,
    "",
    `→ ${url}`,
    "────────",
  ].join("\n");
}

export async function draftLetter(ctx: LetterContext): Promise<{ subject: string; body: string }> {
  const v = ctx.visit;
  const pageUrl = v.page_url || `${ctx.siteUrl}/${v.visit_id}`;
  const respondUrl = `${pageUrl}#respond`;
  const wanted = (ctx.labs.labs || []).filter((l: any) => ctx.mostWantedRooms.includes(l.room));
  const contents = pageContents(v, ctx.labs);
  const briefingLocation = v.itinerary?.find((s) => s.room === "briefing")?.location || "302";
  if (isMock()) return mockLetter(ctx, pageUrl, respondUrl, contents);
  const system =
    ctx.kind === "confirmation"
      ? `你替 GHRC 草擬參訪確認信。語氣：同行學者之間的誠懇與簡潔，不是服務業。用來賓的語言寫（language=zh 用繁體中文；en 用英文；ko／ja 用英文為主並在開頭與結尾附一句該語言問候）。
內容：確認日期時間與地點（臺大園藝系造園館三樓；總體介紹在 briefing_location 那一間，之後依序走訪研究室）、當天流程（附 programme）、專屬網頁連結（訪前可先看五間研究室的老師背景）、對口老師。
不要問來賓任何問題；不要加交通、步行、穿著、天氣之類的提醒；不要提到中心以外的地點或單位。署名用提供的 sender。回傳 subject 與純文字 body。

${CENTER_FACTS}`
      : `你替 GHRC 草擬參訪後的感謝信。語氣：同行學者之間的請益與感謝，不是滿意度調查。用來賓的語言寫（language=zh 用繁體中文；en 用英文；ko／ja 用英文為主並在開頭與結尾附一句該語言問候）。
內容順序：1) 感謝來訪，點到當天他們最感興趣的研究室（most_wanted_labs；沒有就不點名）；2) 專屬網頁連結，**只能說頁面上實際有的東西**——逐項對應 page_contents，清單以外的一律不要承諾（例如清單沒有「簡報 PDF」就不要提 PDF，沒有「合照」就不要提照片，沒有「老師的聯絡方式」就不要說裡面有聯絡方式）；3) 然後**原封不動**放入提供的 response_block（三個回應項目，含連結），不要改寫其中任何一句；4) 一兩句收尾；5) 署名 sender。
寄給名單上每一個人，所以不要用只對主要來賓說話的口吻；稱呼用通用的「各位」／"Dear colleagues"，或以單位為對象。不要感謝中心自己的老師或同仁。回傳 subject 與純文字 body。

${CENTER_FACTS}`;
  const payload = {
    visit: { org: v.org, guests: v.guests.map((g) => ({ name: g.name, title: g.title })), date: v.date, start_time: v.start_time, programme: v.programme, itinerary: v.itinerary, language: v.language, contact_teacher: v.contact_teacher, purpose: v.purpose },
    briefing_location: briefingLocation,
    page_url: pageUrl,
    page_contents: ctx.kind === "thanks" ? contents.map((c) => c.zh) : undefined,
    most_wanted_labs: wanted.map((l: any) => ({ room: l.room, name_en: l.name_en, lead: `${l.lead.name_zh} ${l.lead.name_en}` })),
    response_block: ctx.kind === "thanks" ? responseBlock(v.language, ctx.i18n, respondUrl) : undefined,
    sender: senderBlock(ctx),
  };
  const out = await structured(LetterSchema, system, JSON.stringify(payload));
  if (ctx.kind === "thanks" && !out.body.includes(respondUrl)) {
    out.body = `${out.body.trim()}\n\n${responseBlock(v.language, ctx.i18n, respondUrl)}`;
  }
  return out;
}

// ───────────────────────── 4. 簽名簿 ─────────────────────────

const SignbookSchema = z.object({
  entries: z.array(z.object({ text: z.string(), signed_by: z.string(), language: z.string() })),
  transcript: z.string(),
});

export async function readSignbook(imageBase64: string, mediaType: string): Promise<{ entries: SignbookEntry[]; transcript: string }> {
  if (isMock()) return { entries: [{ text: "(AI_MOCK) Thank you for a wonderful visit — impressed by the CAVE.", signed_by: "", language: "en" }], transcript: "(AI_MOCK) Thank you for a wonderful visit — impressed by the CAVE." };
  const mt = (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mediaType) ? mediaType : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  return structured(
    SignbookSchema,
    `這是 GHRC 貴賓簽名簿的一頁照片。把每一則手寫留言逐字轉成文字（中、英、韓、日皆可能），每則一筆：text 是留言本文，signed_by 是署名（看不清就留空），language 是語言代碼。transcript 放整頁的原樣轉錄。看不清的字用「□」，不要猜。`,
    [
      { type: "image", source: { type: "base64", media_type: mt, data: imageBase64 } },
      { type: "text", text: "請轉錄這一頁。" },
    ],
  );
}

// ───────────────────────── 5. 口述 ─────────────────────────

const DictationSchema = z.object({
  who_came: z.string(),
  most_wanted_rooms: z.array(z.enum(ROOMS)),
  questions: z.array(z.string()),
  cooperation: z.string(),
  follow_ups: z.array(z.string()),
  other: z.string(),
});

export async function transcribeAudio(bytes: Uint8Array, mime: string, language = "zh"): Promise<string> {
  if (isMock()) return "（AI_MOCK）今天部長來，他最想看 303 的模擬，問了兩個問題，一個是這套能不能用在長照機構，一個是問經費從哪裡來，他的參事會後有來要惠美的名片。";
  const key = env("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY 未設定，無法轉文字（可改用手動輸入逐字稿）");
  const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : mime.includes("mpeg") ? "mp3" : "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), `dictation.${ext}`);
  form.append("model", env("WHISPER_MODEL") || "whisper-1");
  form.append("response_format", "json");
  if (language) form.append("language", language);
  form.append("prompt", "綠色健康研究中心 GHRC 參訪，研究室 301 302 303 304 305，張俊彥、林寶秀、陳惠美、張伯茹、鄭佳昆。");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(`Whisper ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { text: string };
  return (j.text || "").trim();
}

export async function extractDictation(transcript: string, visit: Visit): Promise<DictationExtract> {
  if (isMock()) return mockDictation(transcript);
  return structured(
    DictationSchema,
    `主持人在參訪結束後口述了三十秒。抽取：who_came（誰來，一句）、most_wanted_rooms（來賓在「最想看哪一部分」那一問點名的研究室，房號）、questions（來賓問了什麼，逐條）、cooperation（有沒有透露合作意願，一句；沒有就空字串）、follow_ups（要做的後續事項，例如寄名片、寄論文）、other（其他值得留下的話）。只抽口述裡有的，不要補。房號對應：301 張俊彥智能室、302 林寶秀規劃室、303 陳惠美模擬室、304 張伯茹全景影院、305 鄭佳昆 IVR 研究室。`,
    `本次參訪：${visit.org?.name || ""}，${visit.date}。\n\n口述逐字稿：\n${transcript}`,
  );
}

// ───────────────────────── 6. 摘要與彙整 ─────────────────────────

export async function summarizeVisit(visit: Visit, responses: ResponseRow[], timeline: any[]): Promise<string> {
  if (isMock()) return mockSummary(visit, responses, timeline);
  const payload = { visit: { ...visit, letters: undefined }, responses, timeline };
  return plain(
    `替 GHRC 寫一頁參訪摘要（繁體中文，Markdown，300 字內）。段落固定：誰來（單位、主要來賓、人數）；看了哪幾間各多久（用 timeline）；最想看什麼（口述抽取）；問了哪些問題；想合作誰（responses 的 cooperate_rooms 與口述）；收到什麼建議（responses 的 suggestion，不具名的不要試圖猜是誰）；待辦。沒有資料的段落寫「（無）」。不要評分、不要用滿意度用語。\n\n${CENTER_FACTS}`,
    JSON.stringify(payload),
  );
}

export async function digestSuggestions(items: { visit_id: string; date: string; org_type: string; suggestion: string }[]): Promise<string> {
  if (isMock()) return `（AI_MOCK）共 ${items.length} 則建議。\n\n` + items.map((i) => `- ${i.date} ${i.org_type}：${i.suggestion}`).join("\n");
  return plain(
    `以下是多場參訪收到的開放建議（來賓以請益方式回答「中心哪一部分還可以做得更好」）。跨場次彙整：找出重複出現的主題（例如某一間反覆被說聽不懂），每個主題給 1) 主題 2) 出現次數與單位類型 3) 原話摘錄 4) 建議送給哪一間研究室。繁體中文 Markdown。不要猜測不具名者是誰。`,
    JSON.stringify(items),
  );
}

const TranslateSchema = z.object({ translations: z.array(z.string()) });

/** 給產檔程式用：把母簡報的中文段落換成第二語言（韓／日／英）。順序與數量必須一致。 */
export async function translateTexts(texts: string[], target: "ko" | "ja" | "en"): Promise<string[]> {
  if (isMock()) return texts.map((t) => `[${target}] ${t}`);
  const name = { ko: "韓文", ja: "日文", en: "英文" }[target];
  const out = await structured(
    TranslateSchema,
    `這些是 GHRC 介紹簡報裡的中文輔助文字（英文主標另有，不用管）。逐條翻成${name}，語氣為學術簡報，簡潔；保留數字、專有名詞、人名的原文拼法與符號（·、—、|）。translations 的長度與順序必須和輸入完全一致。`,
    JSON.stringify(texts),
    16000,
  );
  if (out.translations.length !== texts.length) throw new Error(`翻譯數量不符：${out.translations.length} ≠ ${texts.length}`);
  return out.translations;
}

// ───────────────────────── mock ─────────────────────────

function mockExtract(text: string): ExtractedVisit {
  const emails = [...new Set((text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map((e) => e.toLowerCase()))];
  const guests: ExtractedVisit["guests"] = emails.map((email, i) => {
    const local = email.split("@")[0];
    const name = local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return { name, title: i === 0 ? "Principal guest" : "Member", email, role: i === 0 ? "lead" : "member", affiliation: "" };
  });
  const orgLine = (text.split(/\r?\n/).find((l) => /university|大學|ministry|部|college|學院|高中|company|公司/i.test(l)) || "").trim();
  const orgMatch = orgLine.match(/(University of [A-Z][A-Za-z ]+|[A-Z][A-Za-z]+ University|[^\s，。、]+大學|[^\s，。、]+高中)/);
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const date = (text.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1] || "";
  return {
    org: { name: orgMatch?.[1] || orgLine.slice(0, 60) || "Visiting organisation", name_local: "", type: /university|大學|college|學院/i.test(orgLine) ? "university" : /高中|school/i.test(orgLine) ? "school" : /ministry|部|government|政府|agency/i.test(orgLine) ? "government" : "other", country: cjk > 50 ? "Taiwan" : "" },
    guests,
    headcount: Math.max(guests.length, 1),
    date,
    start_time: (text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/) || [])[0] || "",
    duration_minutes: /half day|半天/i.test(text) ? 180 : 90,
    contact_teacher: TEACHERS.find((t) => text.includes(t)) || "張俊彥",
    purpose: "（AI_MOCK）依信件內容自動填入的示範目的",
    interests: ["green infrastructure", "health landscape"],
    language: cjk > 50 ? "zh" : /korea|한국/i.test(text) ? "ko" : /japan|日本/i.test(text) ? "ja" : "en",
    candidate_dates: date ? [] : ["（AI_MOCK）日期未定"],
    uncertainties: ["AI_MOCK 模式：這是範例抽取，不是真正的 AI 結果"],
  };
}

function mockPlan(visit: Visit, slidesIndex: any): Plan {
  const all: any[] = slidesIndex.slides || [];
  const total = Number(visit.duration_minutes) || 150;
  const labSteps = (visit.itinerary || []).map((s) => String(s.room)).filter((r) => r !== "briefing");
  const rooms = (labSteps.length ? labSteps : ["301", "302", "303", "304", "305"]) as any[];
  // 預設規則：總體介紹 20、每間 20、合照 5，剩下全給綜合討論
  const alloc = allocateProgramme(total, rooms.length);
  const briefing = alloc.briefing;
  const perRoom = alloc.perRoom;
  const tour = perRoom * rooms.length;
  const discussion = alloc.discussion;
  const photo = alloc.photo;
  const type = visit.org?.type || "university";
  const picked = new Set<number>(all.filter((s) => s.always).map((s) => s.n));
  let budget = briefing - 3.5;
  const candidates = all.filter((s) => !s.always && !s.video && s.role !== "divider" && (!s.lab || rooms.includes(s.lab)));
  candidates.sort((a, b) => score(b) - score(a));
  function score(s: any) {
    let sc = 0;
    if (s.audience?.includes(type)) sc += 3;
    if (s.n === 13) sc += 2;
    if (s.lab) sc += 1;
    return sc;
  }
  for (const s of candidates) {
    if (budget - (s.minutes || 1) < 0) continue;
    picked.add(s.n);
    budget -= s.minutes || 1;
  }
  const slides = [...picked].sort((a, b) => a - b);
  const t0 = hm(visit.start_time || "10:00");
  const b: Plan["programme"] = [];
  const add = (kind: any, mins: number, en: string, second: string, rooms2: string[], range: string) => {
    const start = fmt(t0 + b.reduce((s, x) => s + span(x), 0));
    b.push({ start, end: fmt(hm(start) + mins), kind, title_en: en, title_2nd: visit.language === "en" ? "" : second, rooms: rooms2, slides_range: range });
  };
  add("briefing", briefing, "Center overview and the laboratories", "中心簡介與研究室概覽", [], `01 – ${String(slides.length).padStart(2, "0")}`);
  add("tour", tour, `Laboratory tour, Rooms ${rooms[0]} to ${rooms[rooms.length - 1]}`, `研究室參訪 ${rooms[0]}–${rooms[rooms.length - 1]}`, rooms, "—");
  add("discussion", discussion, "General discussion", "綜合討論", [], "—");
  if (photo) add("photo", photo, "Group photo in the panoramic cinema", "全景影院合照", ["304"], "—");
  const lead = visit.guests?.find((g) => g.role === "lead") || visit.guests?.[0];
  return {
    programme: b,
    itinerary: [{ room: "briefing" as any, minutes: briefing, focus: "總體介紹" }, ...rooms.map((room) => ({ room, minutes: perRoom, focus: "" }))],
    slides,
    cover_text: { org_line: visit.org?.name || "", guest_lines: lead ? [`${lead.name} ${lead.title}`.trim()] : [], date_line: visit.date },
    text_edits: [],
    rationale: "（AI_MOCK）依單位類型與可用時間的示範排程，不是真正的 AI 結果。",
  };
}

function hm(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}
function fmt(mins: number): string {
  return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
function span(x: { start: string; end: string }): number {
  return hm(x.end) - hm(x.start);
}

function mockLetter(ctx: LetterContext, pageUrl: string, respondUrl: string, contents: { key: string; zh: string }[]): { subject: string; body: string } {
  const v = ctx.visit;
  const location = v.itinerary?.find((s) => s.room === "briefing")?.location || "302";
  if (ctx.kind === "confirmation") {
    return {
      subject: `(AI_MOCK) Your visit to the Green Health Research Center, ${v.date}`,
      body: `Dear colleagues,\n\nWe look forward to welcoming ${v.org?.name || "you"} on ${v.date} at ${v.start_time}. We begin with a short overview in Room ${location}, Landscape Building, 3rd floor, and then walk through the laboratories next door.\n\nProgramme and the laboratories you will see: ${pageUrl}\n\n${senderBlock(ctx)}`,
    };
  }
  // 只提頁面上真的有的東西（page_contents），跟真提示詞同一條規則
  const keys = new Set(contents.map((c) => c.key));
  const items = [keys.has("deck_pdf") && "the slides (PDF)", keys.has("photos") && "the photos from the day", keys.has("links") && "the links we promised", keys.has("papers") && "the papers of the laboratories", keys.has("contacts") && "the contact details of the laboratory leads"].filter(Boolean) as string[];
  const pageLine = items.length ? `${items.join(", ").replace(/^./, (c) => c.toUpperCase())} are on your visit page: ${pageUrl}` : `The programme and the laboratories you saw, with their leads, are on your visit page: ${pageUrl}`;
  return {
    subject: `(AI_MOCK) Thank you for visiting the Green Health Research Center`,
    body: `Dear colleagues,\n\nThank you for visiting us on ${v.date}. ${pageLine}\n\n${responseBlock(v.language, ctx.i18n, respondUrl)}\n\nWith thanks,\n${senderBlock(ctx)}`,
  };
}

function mockDictation(t: string): DictationExtract {
  const rooms = [...new Set((t.match(/30[1-5]/g) || []))] as string[];
  const sentences = t.split(/[。.!?！？\n]/).map((s) => s.trim()).filter(Boolean);
  return {
    who_came: sentences[0] || "",
    most_wanted_rooms: rooms,
    questions: sentences.filter((s) => /問|question|能不能|嗎/.test(s)),
    cooperation: sentences.find((s) => /合作|collaborat|名片/.test(s)) || "",
    follow_ups: sentences.filter((s) => /名片|寄|send/.test(s)),
    other: "（AI_MOCK）",
  };
}

function mockSummary(v: Visit, responses: ResponseRow[], timeline: any[]): string {
  const lead = v.guests?.find((g) => g.role === "lead") || v.guests?.[0];
  return [
    `# ${v.org?.name || v.visit_id} · ${v.date}`,
    "",
    `**誰來**：${v.org?.name || "（無）"}，${lead ? `${lead.name} ${lead.title}` : ""}，${v.headcount || v.guests?.length || 0} 人`,
    `**看了哪幾間**：${timeline.length ? timeline.map((t: any) => `${t.room}（${t.minutes} 分）`).join("、") : "（無）"}`,
    `**最想看什麼**：${(v.dictation?.extracted?.most_wanted_rooms || []).join("、") || "（無）"}`,
    `**問了哪些問題**：${(v.dictation?.extracted?.questions || []).map((q) => `\n- ${q}`).join("") || "（無）"}`,
    `**想合作誰**：${[...new Set(responses.flatMap((r) => r.cooperate_rooms))].join("、") || "（無）"}`,
    `**收到什麼建議**：${responses.filter((r) => r.suggestion).map((r) => `\n- ${r.suggestion}${r.anonymous ? "（不具名）" : ""}`).join("") || "（無）"}`,
    "",
    "（AI_MOCK 示範摘要）",
  ].join("\n");
}

export type { TimelineSignal };
