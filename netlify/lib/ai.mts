import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "./http.mts";
import { isMock } from "./data.mts";
import type { DictationExtract, ResponseRow, SignbookEntry, Visit } from "./types.mts";
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

/** Claude 接好了沒（AI_MOCK 也算——本機開發與測試用固定範例）。 */
export const aiConfigured = (): boolean => !!(env("ANTHROPIC_API_KEY") || env("AI_MOCK"));

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
  /** 這封信的往來對象（承辦人／秘書）：確認信預設只寄給他，不寄給全團。 */
  contact: z.boolean(),
});

export const ExtractedSchema = z.object({
  org: z.object({ name: z.string(), name_local: z.string(), type: z.enum(ORG_TYPES), country: z.string() }),
  guests: z.array(GuestSchema),
  headcount: z.number().int(),
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
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
- guests：來訪方**每一位**被點名的人都要列出，含職稱與 email（隨行者的 email 是訪後信寄送的關鍵，不要只留主要窗口）。**名單檔（<file> 區塊、PDF、照片）裡的每一列都是一個人**，表格欄位常見順序是姓名／職稱／單位／email，請對應好；沒有 email 的人也要列，email 留空。主要來賓 role=lead，其餘 member。**contact=true 給真正在往來這件事的人**（寄這封信的人、信裡指定的承辦人或秘書；他常常不是主賓，也可能不在來訪名單上但仍要列）——確認信預設只寄給 contact，所以寧可只標一兩個，不要全部標 true；看不出來就全部 false。affiliation 填該人的單位（可能與 org 不同）。
- org：來訪單位的正式名稱（英文為主，name_local 放當地語言名稱）；type 取 government／university／enterprise／school／ngo／other；country 用英文國名。
- headcount：預計人數；不知道就用 guests 人數。
- date：**已確定**的參訪日期（YYYY-MM-DD）；未定則留空字串，把候選日期放 candidate_dates。start_time、end_time 用 HH:MM（台北時間），未提到留空——**來信通常寫「10:00-12:30」，照抽**。duration_minutes 只有在信裡直接寫分鐘數（例如「兩小時」）時才給，否則 0。
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

// ─────────────────── 1.5 訪客背景研判（訪前功課） ───────────────────

const BackgroundSchema = z.object({
  org_profile: z.string(),
  people: z.array(z.object({ name: z.string(), note: z.string() })),
  purposes: z.array(z.string()),
  rooms: z.array(z.object({ room: z.enum(ROOMS), why: z.string() })),
  prepare: z.array(z.string()),
  unknowns: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});
export type VisitBackground = z.infer<typeof BackgroundSchema> & { searched?: boolean; researched_at?: string };

const RESEARCH_SYSTEM = `你在替臺大綠色健康研究中心（GHRC）的主辦端做訪前功課：查這次來賓與他們單位的**公開專業資料**，判斷他們這一趟可能想看什麼。

只查公開的專業資訊：單位的性質與業務、來賓的職稱與所屬、研究或政策領域、近期公開的計畫、報導或活動。
不要查私人生活，不要臆測沒有根據的事。查不到就說查不到——寧可少寫，不要編。
每一項寫下來的事實都要能對應到你讀過的來源網址；推論要標明是推論。`;

const BACKGROUND_SYSTEM = `把訪前功課整理成主辦端看得懂的一頁研判（繁體中文）。

- org_profile：這是什麼樣的單位、為什麼會來（2–4 句）。查到的事實與推論要分清楚，推論寫「推測」。
- people：名單上被點名的人，一人一句他的位置與關注（查不到就寫「查不到公開資料」）。
- purposes：**可能的參訪目的**，最可能的放最前面，每項一句話，並帶上依據（「信裡寫…」「單位近期在推…」）。
- rooms：五間研究室裡他們可能最想看的（room 只能是 301–305），why 一句話說為什麼。
- prepare：主辦端可以先準備或當天可以談的點，具體、可執行。
- unknowns：查不到或需要跟對方確認的事。
- sources：實際讀過的網址（title ＋ url）；沒有查網路就給空陣列。
- 不要把來賓當顧客，不要用滿意度或服務業用語；這是同行的學術交流。
- 沒有內容的欄位給空陣列或空字串，不要硬湊。

${CENTER_FACTS}`;

const textOf = (res: Anthropic.Message) =>
  res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/** 訪客背景：先用網路搜尋做功課，再整理成固定結構。帳號沒開網路搜尋時退回「只讀來信」的研判。 */
async function researchNotes(user: string): Promise<{ notes: string; searched: boolean }> {
  const c = client();
  const base = { model: model(), max_tokens: 8000, system: `${RESEARCH_SYSTEM}\n\n${CENTER_FACTS}` };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
  try {
    const tools: Anthropic.ToolUnion[] = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];
    let res = await c.messages.create({ ...base, messages, tools });
    // 伺服器端工具跑到一半會回 pause_turn：把這一輪接回去讓它跑完
    for (let i = 0; i < 3 && res.stop_reason === "pause_turn"; i++) {
      messages.push({ role: "assistant", content: res.content as any });
      res = await c.messages.create({ ...base, messages, tools });
    }
    if (res.stop_reason === "refusal") throw new Error("模型拒絕了這個請求");
    return { notes: textOf(res), searched: true };
  } catch (e: any) {
    if (/拒絕/.test(String(e?.message || ""))) throw e;
    // 網路搜尋不能用（帳號沒開、暫時失敗）：還是給一份研判，但要說沒查網路
    const res = await c.messages.create({ ...base, messages: [{ role: "user", content: user }] });
    return { notes: textOf(res), searched: false };
  }
}

export async function researchVisitor(visit: Visit): Promise<VisitBackground> {
  const facts = [
    `單位：${visit.org?.name || "（未填）"}${visit.org?.name_local ? `（${visit.org.name_local}）` : ""}`,
    `單位類型：${visit.org?.type || "未知"}　國家：${visit.org?.country || "未知"}`,
    `日期：${visit.date || "未定"}　時間：${visit.start_time || "未定"}–${visit.end_time || "未定"}（共 ${visit.duration_minutes || 0} 分鐘）　人數：${visit.headcount || 0}`,
    `來訪目的（來信寫的）：${visit.purpose || "（未填）"}`,
    `興趣關鍵字：${(visit.interests || []).join("、") || "（無）"}`,
    `名單：${(visit.guests || []).map((g) => [g.name, g.title, g.affiliation].filter(Boolean).join("／")).join("；") || "（無）"}`,
  ].join("\n");
  if (isMock()) return mockBackground(visit);
  const { notes, searched } = await researchNotes(
    `這一場參訪的已知資料：\n\n${facts}\n\n請查這個單位與名單上的人的公開專業資料，然後寫下你查到什麼、判斷他們可能想看什麼，並列出你讀過的網址。`,
  );
  const background = await structured<z.infer<typeof BackgroundSchema>>(
    BackgroundSchema,
    BACKGROUND_SYSTEM,
    `已知資料：\n${facts}\n\n訪前功課筆記${searched ? "（有查網路）" : "（沒有查網路，只根據來信）"}：\n\n${notes}`,
    6000,
  );
  return { ...background, searched };
}

function mockBackground(visit: Visit): VisitBackground {
  const org = visit.org?.name || "（單位）";
  return {
    org_profile: `（AI_MOCK）${org} 是來信裡的來訪單位，這裡是研判用的範例資料。`,
    people: (visit.guests || []).slice(0, 3).map((g) => ({ name: g.name, note: `（AI_MOCK）${g.title || "職稱未知"}` })),
    purposes: [`（AI_MOCK）了解中心的量測與驗證方法`, `（AI_MOCK）評估後續合作或委託研究的可能`],
    rooms: [
      { room: "301", why: "（AI_MOCK）想看實際怎麼量" },
      { room: "303", why: "（AI_MOCK）想看模擬與驗證" },
    ],
    prepare: ["（AI_MOCK）準備一個與對方領域接近的案例"],
    unknowns: ["（AI_MOCK）名單的職稱需要跟對方確認"],
    sources: [],
    searched: false,
  };
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
- **history（歷次實際表現，有才給）**：slides[].used／used_same_type 是這一頁過去選過幾次、同類單位選過幾次；asked 是那一場被提問、mentioned 是在回饋中被提到。rooms[] 每一間分兩種來源：wanted／cooperate 是**來賓自己回的**（最想看、想合作），host_noted 是**主持人口述裡聽到的**——「主持人覺得對方有興趣」不等於「對方說他有興趣」，兩者不要混著講。用法：**被提問或被提到過的頁優先留下**，同類單位常選的頁優先考慮，來賓自己點名多的研究室優先排進動線（host_noted 只當佐證）。但**沒有數字不代表那頁不好**——可能只是沒人選過，該講還是要講；history 是佐證，不是排行榜。
- **選頁以「區塊」為單位**（groups）：挑到某一區的任何一頁，整個區塊都會進去（後台也只勾區塊、不勾單頁），所以請以區塊為單位思考，不必逐頁斟酌。
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

export async function planVisit(visit: Visit, slidesIndex: any, labs: any, masterText: any | null, history: unknown = null): Promise<Plan> {
  if (isMock()) return mockPlan(visit, slidesIndex);
  const payload = {
    history,
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

/** 名片照片 → 名單。一張照片可能同時拍到好幾張名片，所以回傳陣列。 */
const CardSchema = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      affiliation: z.string(),
      email: z.string(),
      phone: z.string(),
    }),
  ),
  note: z.string(),
});
export type CardRead = z.infer<typeof CardSchema>;

export async function readCard(imageBase64: string, mediaType: string): Promise<CardRead> {
  if (isMock())
    return {
      people: [{ name: "（AI_MOCK）陳大文", title: "Professor", affiliation: "Example University", email: "mock@example.edu", phone: "+886 2 1234 5678" }],
      note: "（AI_MOCK）名片讀取範例",
    };
  return structured(
    CardSchema,
    `讀這張照片裡的名片，抽出人的聯絡資料（照片裡可能不只一張名片，每一張都要抽）。

- name：名片上的姓名。中英文都有時，name 用中文全名（沒有中文才用英文）。
- title：職稱，照名片上的寫法（中英文都有就用中文）。
- affiliation：單位／公司，含系所或部門。
- email、phone：照名片上的字抄，不要改格式、不要自己補網域；名片上沒有就留空字串。
- 看不清楚、被裁掉、有疑慮的字**一律留空**，不要猜——名單的 email 之後要拿來寄信，猜錯比留空更糟。
- note：一句話說這張照片的狀況（幾張名片、哪裡看不清楚）；沒事就留空字串。
- 這是來訪者的名片，不是中心自己的人。

${CENTER_FACTS}`,
    [
      { type: "image", source: { type: "base64", media_type: mediaType as any, data: imageBase64 } },
      { type: "text", text: "把這張照片裡的名片讀成名單。" },
    ],
    4000,
  );
}

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

export async function summarizeVisit(visit: Visit, responses: ResponseRow[]): Promise<string> {
  if (isMock()) return mockSummary(visit, responses);
  const payload = { visit: { ...visit, letters: undefined }, responses };
  return plain(
    `替 GHRC 寫一頁參訪摘要（繁體中文，Markdown，300 字內）。段落固定：誰來（單位、主要來賓、人數）；看了哪幾間各多久（用 visit.itinerary 當天排定的動線）；最想看什麼——**分兩行寫，來源不能混**：「來賓自己說」（responses 的 most_wanted_rooms）與「主持人聽到的」（visit.dictation 抽取），只有一邊有資料就只寫那一邊；問了哪些問題；想合作誰（來賓回的 cooperate_rooms；口述裡的合作意願另外一行寫「主持人記下」）；收到什麼建議（responses 的 suggestion，不具名的不要試圖猜是誰）；待辦。沒有資料的段落寫「（無）」。不要評分、不要用滿意度用語。\n\n${CENTER_FACTS}`,
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
    return { name, title: i === 0 ? "Principal guest" : "Member", email, role: i === 0 ? "lead" : "member", affiliation: "", contact: i === 0 };
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
    end_time: /half day|半天/i.test(text) ? "14:00" : "12:30",
    duration_minutes: 0,
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

function mockSummary(v: Visit, responses: ResponseRow[]): string {
  const lead = v.guests?.find((g) => g.role === "lead") || v.guests?.[0];
  return [
    `# ${v.org?.name || v.visit_id} · ${v.date}`,
    "",
    `**誰來**：${v.org?.name || "（無）"}，${lead ? `${lead.name} ${lead.title}` : ""}，${v.headcount || v.guests?.length || 0} 人`,
    `**看了哪幾間**：${(v.itinerary || []).filter((s) => Number(s.minutes) > 0).map((s) => `${s.room}（${s.minutes} 分）`).join("、") || "（無）"}`,
    `**最想看什麼（來賓自己說）**：${[...new Set(responses.flatMap((r) => r.most_wanted_rooms || []))].join("、") || "（無）"}`,
    `**最想看什麼（主持人聽到的）**：${(v.dictation?.extracted?.most_wanted_rooms || []).join("、") || "（無）"}`,
    `**問了哪些問題**：${(v.dictation?.extracted?.questions || []).map((q) => `\n- ${q}`).join("") || "（無）"}`,
    `**想合作誰（來賓自己說）**：${[...new Set(responses.flatMap((r) => r.cooperate_rooms))].join("、") || "（無）"}`,
    `**收到什麼建議**：${responses.filter((r) => r.suggestion).map((r) => `\n- ${r.suggestion}${r.anonymous ? "（不具名）" : ""}`).join("") || "（無）"}`,
    "",
    "（AI_MOCK 示範摘要）",
  ].join("\n");
}

