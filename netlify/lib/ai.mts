import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "./http.mts";
import { isMock } from "./data.mts";
import type { DictationExtract, ResponseRow, SignbookEntry, Visit } from "./types.mts";
import type { Extracted } from "./files.mts";
import { allocateProgramme, briefingBlockMinutes, endTimeOf, FORUM_TITLES, isForum, labStops, pageContents } from "../../lib/visit.mjs";
import { parseVisitTable } from "../../lib/import.mjs";

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
- date：來信**提議或約好**的參訪日期（YYYY-MM-DD）。**用問句提的也算**——「請問您下週 10/5（一）有空嗎？……10/5 週一早上 9:00 到中心」，date 就是那一天，不要因為對方還在問、還沒回覆就留空；還要跟對方確認的話在 uncertainties 寫一句。只有信裡**完全沒提日期**，或列了好幾個日期、看不出偏好哪一個，才留空字串，把那幾個日期放 candidate_dates（YYYY-MM-DD）。沒寫年份就用「今天」之後最近的那一個；信裡也寫了星期幾的話要對得上，對不上就在 uncertainties 說。start_time、end_time 用 HH:MM（台北時間），未提到留空——**來信通常寫「10:00-12:30」，照抽**。duration_minutes 只有在信裡直接寫分鐘數（例如「兩小時」）時才給，否則 0。
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
      kind: z.enum(["briefing", "tour", "discussion", "forum", "photo", "other"]),
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
- 每頁約 40–60 秒（索引裡的 minutes），影片頁另計；總頁數要塞得進 briefing_minutes（今日流程裡總體簡報那一段的分鐘數）。
- 選頁偏好：政府單位偏政策與場域落地；大學偏研究與學生交流；企業偏應用與委託研究；學生團偏影片與體驗。以索引的 audience 與 lab 標記為線索，並參考來賓興趣。
- **history（歷次實際表現，有才給）**：slides[].used／used_same_type 是這一頁過去選過幾次、同類單位選過幾次；asked 是那一場被提問、mentioned 是在回饋中被提到。rooms[] 每一間分兩種來源：wanted／cooperate 是**來賓自己回的**（最想看、想合作），host_noted 是**主持人口述裡聽到的**——「主持人覺得對方有興趣」不等於「對方說他有興趣」，兩者不要混著講。用法：**被提問或被提到過的頁優先留下**，同類單位常選的頁優先考慮，來賓自己點名多的研究室優先排進動線（host_noted 只當佐證）。但**沒有數字不代表那頁不好**——可能只是沒人選過，該講還是要講；history 是佐證，不是排行榜。
- **選頁以「區塊」為單位**（groups）：挑到某一區的任何一頁，整個區塊都會進去（後台也只勾區塊、不勾單頁），所以請以區塊為單位思考，不必逐頁斟酌。
- 實驗室頁：只放 **route** 上那幾間的頁（route＝今日流程上這一場要去的研究室，是各研究室在支援人力表上填的、或主辦端排好的；route 是空的才自己依興趣判斷）；分隔頁（role=divider）只在放了該實驗室內容時保留。
- **format="forum"（座談的場次）**：來賓是來跟中心老師們座談的，**不參觀研究室、不介紹各研究室**——不要放任何實驗室的頁（含分隔頁），只挑中心整體的介紹；行程是 briefing（總體簡報）→ forum（座談，title_en "Roundtable with the faculty"）→ photo（可省略），沒有 tour 也沒有 discussion，itinerary 只有 briefing 一步。
- 最後的「您最想看哪一部分」頁與 QR 頁由產檔程式另外加，不要選。
- 不放中心總預算數字；HEALS Design 是 301 專屬方法論。

行程規則：
- 從 start_time 開始，總長 = duration_minutes，區塊順序固定是 briefing（總體簡報）→ tour（依序參訪研究室）→ discussion（**綜合討論，一定要有**；title_en 用 "General discussion"，title_2nd 用「綜合討論」或對應語言）→ photo（合照，5 分鐘，可省略）。
- **時間分配的預設規則**：總體介紹 20 分、每間研究室 20 分、合照 5 分，前面扣掉之後**剩下的時間全部給綜合討論**。只有總時間不夠時才縮短研究室（每間至少 5 分）與總體介紹（至少 10 分），綜合討論至少 10 分。
- itinerary 是現場動線。**第一步固定是 room="briefing"（總體介紹，在簡報室）**，minutes = briefing 區塊長度、focus 寫這場總體簡報要強調什麼；之後才是 tour 區塊內各房間的順序與分鐘數：**有給 route 就照 route 的房間、順序與分鐘，不要增減**；route 是空的才預設 301→302→303→304→305，依興趣可調整或省略房間；房間分鐘數總和 = tour 區塊長度。
- title_2nd 用來賓的第二語言（language）；language=en 時 title_2nd 留空。
- slides_range 用「01 – 12」這種格式描述該區塊對應的**輸出後**頁碼範圍（輸出後頁碼 = 選用頁在 slides 陣列裡的序號，從 1 起算），非簡報區塊填「—」。
- cover_text：封面要替換的三段文字：org_line（單位名稱，英文為主，可加當地語）、guest_lines（主要來賓一到三行：姓名 職稱）、date_line（例如「7 October 2026 · 2026年10月7日」）。
- text_edits：只有在提供母簡報文字（master_text）時才填。針對第 1、2、3 頁，逐一給出 find（母簡報裡**逐字**存在的文字段落）與 replace（新文字），用來改單位名稱、流程表的時間／說明／頁碼、Contents 的章節列表。沒有 master_text 就給空陣列。
- rationale：用中文兩三句說明**為什麼挑這幾個區塊**（後台把它放在選頁旁邊；有給 route 時行程是研究室填的，不必解釋行程）。
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
    // forum＝座談的場次：不參觀研究室，挑頁不挑各研究室的頁
    format: isForum(visit) ? "forum" : "tour",
    // 今日流程是自動排的（各研究室在支援人力表上填的分鐘）：挑頁照這一份動線與總體簡報的長度，不要另排一份
    route: (visit.itinerary || []).filter((s) => s.room !== "briefing" && (Number(s.minutes) || 0) > 0).map((s) => ({ room: s.room, minutes: Number(s.minutes) })),
    briefing_minutes: briefingBlockMinutes(visit.programme) || Number(visit.itinerary?.find((s) => s.room === "briefing")?.minutes) || 20,
    slide_index: slidesIndex.slides,
    labs: (labs.labs || []).map((l: any) => ({ room: l.room, name_en: l.name_en, lead: l.lead?.name_zh, one_line_en: l.one_line_en })),
    master_text: masterText ? { slides: (masterText.slides || []).filter((s: any) => s.n <= 3) } : null,
  };
  return structured(PlanSchema, PLAN_SYSTEM, JSON.stringify(payload), 12000);
}

// ───────────────────────── 3. 信件 ─────────────────────────

const LetterSchema = z.object({ subject: z.string(), body: z.string() });

export interface LetterContext {
  /**
   * 寄給來賓的：confirmation（訪前確認）、thanks（訪後感謝）。
   * 寄給**中心自己**各研究室的：notice（行前通告，請各室安排簡報人員）、
   * rundown（通告的下一步：定案的時間、簡報人員與內容再回報一次）。
   */
  kind: "confirmation" | "thanks" | "notice" | "rundown";
  visit: Visit;
  labs: any;
  i18n: any;
  sender: "director" | "contact";
  siteUrl: string;
  /** 支援人力表的網址（`/rota?key=…`，自動產生，通告一定有）。通告裡會再接上 `#<visit_id>`，點進去直接跳到那一場。 */
  rotaUrl?: string;
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
  const internal = ctx.kind === "notice" || ctx.kind === "rundown"; // 寄給中心自己的研究室，不是來賓
  const briefingLocation = v.itinerary?.find((s) => s.room === "briefing")?.location || "302";
  if (isMock()) return mockLetter(ctx, pageUrl, respondUrl, contents);
  const system =
    ctx.kind === "rundown"
      ? `你替 GHRC 草擬一則**回報給中心自己五間研究室**的訊息：通告發出去、各室回覆簡報人員之後，把定案的安排再送回去一次。收信的是同事，**一律用繁體中文**。
語氣：同事之間，簡短、條列、看一眼就知道自己幾點要做什麼。不要客套話，不要感謝詞，不要公文腔。
結構：1) 一句話說哪個單位、什麼時候來、幾位；2) **定案動線**——照 lab_stops 逐條列「幾點–幾點　房號　研究室　簡報人員　N 分鐘」，presenter 是空的就寫「（待補）」；3) 一兩句提醒當天的重點（來賓想看什麼、簡報大概講多久）；4) 最後一句「有問題直接回這則訊息」。
**format="forum"（座談的場次）**：不參觀研究室，第 2 段改成兩部分——先照 programme 列當天流程（幾點–幾點　內容），再列「座談出席」：照 attendees 逐條列「房號　研究室　老師　可參加／無法參加」（lead 是那一間的老師，attend 是空的就寫「（待回覆）」）。不要寫各室的時段與分鐘。
**不要署名**：這一則是貼進中心自己的 LINE 群組，誰發的大家都看得到。
時間與人員一律照提供的資料，不要自己改也不要補上沒有的人。回傳 subject 與純文字 body。

${CENTER_FACTS}`
      : ctx.kind === "notice"
      ? `你替 GHRC 草擬一封**寄給中心自己五間研究室老師**的行前通告。收信的是同事，不是來賓——**一律用繁體中文**，不管來賓講什麼語言。
語氣：同事之間，簡短、好讀、好回。不要客套話堆疊，不要感謝詞，不要「敬請惠予協助」這種公文腔。
結構，照這個順序：
1) 開頭一行固定寫「各位老師好：」。
2) 一句話說哪個單位、什麼時候來、幾位。
3) 一兩句來賓背景與他們想看什麼（purpose／interests，沒有就省略）。
4) **原封不動**放入提供的 route_block（當天動線），一個字都不要改、不要重排、不要補上各室的時間。
5) **原封不動**放入提供的 roll_call_block（請各研究室回覆，下一行是支援人力表的網址），一個字都不要改，網址要完整（含 # 後面那一段，那是直接跳到這一場用的）。
**roll_call_block 就是整則的最後一段，後面什麼都不要加**：不要回覆期限、不要署名、不要結尾的客套話——這一則是貼進中心自己的 LINE 群組，誰發的大家都看得到。
只寫這一場真的有的資訊：沒有的欄位就不要提，不要自己補上參觀路線以外的安排，也不要另外再問 demo、設備、研究生之類的事——這一則只問一件事：誰來接待（要多少時間，老師在網址那張表上填）。
**format="forum"（座談的場次）**：來賓是來跟中心老師們座談的，不參觀研究室——第 2 句要說明是座談；這一則只問一件事：老師能否出席座談（老師在網址那張表上選「可參加」或「無法參加」），不要提接待、參觀或分鐘。回傳 subject 與純文字 body。

${CENTER_FACTS}`
      : ctx.kind === "confirmation"
      ? `你替 GHRC 草擬參訪確認信。語氣：同行學者之間的誠懇與簡潔，不是服務業。用來賓的語言寫（language=zh 用繁體中文；en 用英文；ko／ja 用英文為主並在開頭與結尾附一句該語言問候）。
內容：確認日期時間與地點（臺大園藝系造園館三樓；總體介紹在 briefing_location 那一間，之後依序走訪研究室——**format="forum" 時不參觀研究室，之後是與中心老師座談**）、當天流程（附 programme）、專屬網頁連結（訪前可先看五間研究室的老師背景）、對口老師。
不要問來賓任何問題；不要加交通、步行、穿著、天氣之類的提醒；不要提到中心以外的地點或單位。署名用提供的 sender。回傳 subject 與純文字 body。

${CENTER_FACTS}`
      : `你替 GHRC 草擬參訪後的感謝信。語氣：同行學者之間的請益與感謝，不是滿意度調查。用來賓的語言寫（language=zh 用繁體中文；en 用英文；ko／ja 用英文為主並在開頭與結尾附一句該語言問候）。
內容順序：1) 感謝來訪，點到當天他們最感興趣的研究室（most_wanted_labs；沒有就不點名）；2) 專屬網頁連結，**只能說頁面上實際有的東西**——逐項對應 page_contents，清單以外的一律不要承諾（例如清單沒有「簡報 PDF」就不要提 PDF，沒有「合照」就不要提照片，沒有「老師的聯絡方式」就不要說裡面有聯絡方式）；3) 然後**原封不動**放入提供的 response_block（三個回應項目，含連結），不要改寫其中任何一句；4) 一兩句收尾；5) 署名 sender。
寄給名單上每一個人，所以不要用只對主要來賓說話的口吻；稱呼用通用的「各位」／"Dear colleagues"，或以單位為對象。不要感謝中心自己的老師或同仁。回傳 subject 與純文字 body。

${CENTER_FACTS}`;
  const payload = {
    visit: { org: v.org, guests: v.guests.map((g) => ({ name: g.name, title: g.title })), date: v.date, start_time: v.start_time, programme: v.programme, itinerary: v.itinerary, language: v.language, contact_teacher: v.contact_teacher, purpose: v.purpose },
    // forum＝座談的場次（跟中心老師們座談，不參觀研究室）
    format: isForum(v) ? "forum" : "tour",
    // 座談：五間的老師能否出席（支援人力表上選的）
    attendees: internal && isForum(v) ? forumAttendees(v, ctx.labs) : undefined,
    briefing_location: briefingLocation,
    page_url: pageUrl,
    page_contents: ctx.kind === "thanks" ? contents.map((c) => c.zh) : undefined,
    most_wanted_labs: wanted.map((l: any) => ({ room: l.room, name_en: l.name_en, lead: `${l.lead.name_zh} ${l.lead.name_en}` })),
    // 行前通告：當天幾點走到哪一間、各幾分鐘、誰負責（通告的主體就是這一份）
    // 行前通告／回報：當天幾點走到哪一間、各幾分鐘、誰負責、各室回覆的簡報人員
    lab_stops: internal
      ? labStops(v, ctx.labs).map((x: any) => ({ ...x, presenter: (v as any).presenters?.[x.room] || "", label: `${x.start}–${x.end}　${x.room} ${x.name_zh}　${x.lead}　${x.minutes} 分` }))
      : undefined,
    interests: internal ? v.interests : undefined,
    headcount: internal ? v.headcount : undefined,
    route_block: ctx.kind === "notice" ? routeBlock(v, ctx.labs) : undefined,
    roll_call_block: ctx.kind === "notice" ? rollCallBlock(v, ctx.rotaUrl) : undefined,
    response_block: ctx.kind === "thanks" ? responseBlock(v.language, ctx.i18n, respondUrl) : undefined,
    // 通告與回報不署名（貼進中心自己的 LINE 群組，誰發的大家都看得到）
    sender: internal ? undefined : senderBlock(ctx),
  };
  const out = await structured(LetterSchema, system, JSON.stringify(payload));
  if (ctx.kind === "notice") out.body = settleNotice(out.body, routeBlock(v, ctx.labs), rollCallBlock(v, ctx.rotaUrl));
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
    `替 GHRC 寫一頁參訪摘要（繁體中文，Markdown，300 字內）。段落固定：誰來（單位、主要來賓、人數）；看了哪幾間各多久（用 visit.itinerary 當天排定的動線；visit.format 是 forum 的是**座談的場次、不參觀研究室**——這一段改寫「座談，不參觀研究室」，並列出席的老師：visit.attendance 是 yes 的那幾間的負責老師（no＝無法參加）；最想看什麼——**分兩行寫，來源不能混**：「來賓自己說」（responses 的 most_wanted_rooms）與「主持人聽到的」（visit.dictation 抽取），只有一邊有資料就只寫那一邊；問了哪些問題；想合作誰（來賓回的 cooperate_rooms；口述裡的合作意願另外一行寫「主持人記下」）；收到什麼建議（responses 的 suggestion，不具名的不要試圖猜是誰）；待辦。沒有資料的段落寫「（無）」。不要評分、不要用滿意度用語。\n\n${CENTER_FACTS}`,
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

// ───────────────────── 7. 訪客地圖：單位在哪裡 ─────────────────────

const GeoSchema = z.object({
  places: z.array(z.object({ id: z.string(), place: z.string(), lat: z.number(), lon: z.number(), precision: z.enum(["site", "city", "region", "country"]) })),
});
export type GeoPlace = z.infer<typeof GeoSchema>["places"][number];
export interface GeoQuery { id: string; name: string; name_local: string; country: string; profile: string }

const GEO_SYSTEM = `你替臺大綠色健康研究中心（GHRC）的訪客地圖標出每一個來訪單位（學校、公司、政府機關、團體）在哪裡。每一個單位回一筆，id 照抄：
- lat／lon：那個單位本部的位置——大學給主校區、公司給總公司、機關給所在地。精度到校區或城市就夠了。
- place：所在城市，用繁體中文寫（例如「臺北市」「新竹縣竹北市」「澳洲伯斯」「韓國首爾」「日本兵庫縣淡路市」）。
- precision：知道是哪一個校區或地址＝site；只知道城市＝city；只知道州／省／縣＝region；連城市都不確定＝country（lat／lon 給那個國家的大概中心）。
只根據你確定知道的，以及附上的公開資料（profile，訪前功課查到的單位側寫）判斷。不確定就降一級精度，不要編一個看起來很準的座標——地圖上點錯地方比放在國家中心更糟。`;

/** 一次查好幾個單位的位置（`geo-background` 呼叫）。 */
export async function locateOrgs(items: GeoQuery[]): Promise<GeoPlace[]> {
  if (!items.length) return [];
  if (isMock()) return items.map(mockPlace);
  const out = await structured(GeoSchema, GEO_SYSTEM, JSON.stringify(items), 4000);
  return out.places;
}

// ───────────────── 8. 匯入以前的參訪名單（系統上線之前的紀錄） ─────────────────

const ImportSchema = z.object({
  rows: z.array(
    z.object({
      source_row: z.string(),
      date: z.string(),
      code: z.string(),
      org: z.object({ name: z.string(), name_local: z.string(), type: z.enum(ORG_TYPES), country: z.string() }),
      people: z.array(z.object({ name: z.string(), title: z.string() })),
      people_text: z.string(),
      people_en: z.string(),
      headcount: z.number().int(),
      companions: z.string(),
      purpose: z.string(),
      purpose_en: z.string(),
    }),
  ),
  skipped: z.array(z.string()),
});
export type ImportedRows = z.infer<typeof ImportSchema>;

const IMPORT_SYSTEM = `你替臺大生農學院綠色健康研究中心（GHRC）把**系統上線以前的參訪紀錄**（試算表、Word 或簡報轉出的文字）整理成一筆一筆的來訪紀錄，匯入參訪系統。只整理，不補資料，不要編造；整理好的結果會先給主辦端看過才存。

一筆＝一個來訪單位在某一天來中心：
- 原表一列通常就是一筆。**一列裡有好幾個各自來訪的單位**（例如研討會的幾位講者分別來自不同學校、不同國家）就拆成幾筆，source_row 都寫同一列。
- 陪同或同行的單位（臺大自己的單位、國科會、外國駐臺機構陪同自己國家的官員這類）不另成一筆，寫進 companions。
- 不是來訪紀錄的不要列：表頭、統計表、說明文字、中心自己出去拜會或出訪的紀錄。有疑慮、沒有列進來的，在 skipped 用中文寫一句（哪一列、為什麼）；統計表與說明文字不必寫進 skipped。

欄位：
- source_row：原表那一列的編號（有「編號」欄就照抄，沒有就寫它是第幾列）。
- date：YYYY-MM-DD（原表「2024/1/8」寫成 2024-01-08）；看不出是哪一天就留空。
- org.name：單位的英文正式名稱。原表有英文就照用；只有中文就照字面翻成英文，**不要加原表沒寫的東西**（例如原表只寫「美國德州大學」，就不要自己決定是哪一個校區）。系所、學院、中心寫進名稱（例如 University of Illinois Urbana-Champaign, Department of Landscape Architecture）。
- org.name_local：原表的中文名稱照抄，去掉括號裡的英文與「（AR眼鏡公司）」這類說明；原表只有英文就留空。
- org.type：government／university／enterprise／school／ngo／other。org.country：英文國名（臺灣寫 Taiwan，韓國寫 South Korea）。
- code：網址代碼，小寫英文與數字（2–16 字），用這個單位常見的縮寫（例如 uiuc、ntou、konkuk）；想不出來就用名稱裡最有辨識度的一個英文字。
- people：原表寫了名字的人（name 照原表的寫法，title 是職稱，例如「教授」「場長」）。只寫職稱、或「師生」「同仁」「成員」的不列。拆成幾筆時，每個人放到他所屬的那一筆。
- people_text：原表「來訪人員」那一格照抄（拆成幾筆時只抄屬於這一筆的部分）。
- headcount：原表寫了人數（例如「共 38 位」）就照填；people 就是這一筆全部的來訪者（沒有「與同仁」「等」「師生」）就填 people 的人數；其他一律 0（＝不知道）。
- companions：原表「同行單位」那一格照抄，加上上面說的陪同單位。
- purpose：原表「交流重點／成果」那一格照抄；空白就留空。
- people_en、purpose_en：people_text 與 purpose 的英文（會放在中心首頁連過去的公開「來訪紀錄」英文版）。照原意翻，不加不減、不美化；人名照原文拼法，單位用你給 org.name 的同一個英文名稱；原文空白就留空。`;

/**
 * 名單長就分段讀（一段 15 列，每一段都帶著那一張工作表的名稱與表頭）：每一列要回中英兩份說明，
 * 整份一次丟進去 AI 的輸出會被截斷，後面幾十列就不見了。各段同時讀（`readVisitList`），總時間跟一段差不多。
 */
export function importChunks(text: string, per = 15): string[] {
  const lines = String(text || "").split("\n");
  if (lines.length <= per + 20) return [String(text || "")];
  // 一張工作表一段（沒有「## 工作表」的文字檔就是一整段）；表頭＝那一段的第一個非空行
  let cur = { name: "", header: "", body: [] as string[] };
  const sections = [cur];
  for (const line of lines) {
    if (/^## /.test(line)) {
      cur = { name: line, header: "", body: [] };
      sections.push(cur);
    } else if (line.trim()) {
      if (cur.header) cur.body.push(line);
      else cur.header = line;
    }
  }
  // 好幾張工作表、其中有表頭寫著「日期」的：只讀那幾張（另外那幾張是統計與說明，不是參訪紀錄，送去只是白等）
  const dated = sections.filter((sec) => /日期|date/i.test(sec.header));
  const chunks: string[] = [];
  for (const sec of dated.length ? dated : sections) {
    const head = [sec.name, sec.header].filter(Boolean);
    for (let i = 0; i < sec.body.length; i += per) chunks.push([...head, ...sec.body.slice(i, i + per)].join("\n"));
  }
  return chunks.length ? chunks : [String(text || "")];
}

/** 讀以前的參訪名單（`import-background` 呼叫）。AI_MOCK 時照欄名讀（`lib/import.mjs parseVisitTable`）。 */
export async function readVisitList(text: string, today: string): Promise<ImportedRows> {
  if (isMock()) return parseVisitTable(text) as ImportedRows;
  const out: ImportedRows = { rows: [], skipped: [] };
  const chunks = importChunks(text);
  // 一次最多四段同時讀；照原本的順序接回去
  const results: ImportedRows[] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = chunks.slice(i, i + 4).map((chunk) => structured(ImportSchema, `${IMPORT_SYSTEM}\n\n${CENTER_FACTS}\n今天是 ${today}。`, `<file>\n${chunk}\n</file>`, 16000));
    (await Promise.all(batch)).forEach((r, j) => (results[i + j] = r));
  }
  for (const r of results) {
    out.rows.push(...r.rows);
    out.skipped.push(...r.skipped);
  }
  return out;
}

// ───────────────────────── mock ─────────────────────────

/** AI_MOCK：測試與示範會用到的幾個單位給真的位置，其他的一律「只知道國家」（0,0 就是查不到）。 */
const MOCK_PLACES: [RegExp, string, number, number, GeoPlace["precision"]][] = [
  [/western australia|西澳/i, "澳洲伯斯", -31.98, 115.82, "site"],
  [/konkuk|建國大學/i, "韓國首爾", 37.54, 127.08, "site"],
  [/awaji|淡路/i, "日本兵庫縣淡路市", 34.46, 134.9, "site"],
  [/national taiwan university|臺灣大學|台灣大學/i, "臺北市", 25.017, 121.54, "site"],
  [/illinois|uiuc/i, "美國伊利諾州厄巴納－香檳", 40.11, -88.23, "site"],
  [/惇陽|dun ?yang/i, "臺北市", 25.05, 121.53, "city"],
];
function mockPlace(item: GeoQuery): GeoPlace {
  const hit = MOCK_PLACES.find(([re]) => re.test(`${item.name} ${item.name_local}`));
  return hit ? { id: item.id, place: `（AI_MOCK）${hit[1]}`, lat: hit[2], lon: hit[3], precision: hit[4] } : { id: item.id, place: "", lat: 0, lon: 0, precision: "country" };
}

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
  const forum = isForum(visit); // 座談：不參觀研究室，也不挑各研究室的頁
  const rooms = (forum ? [] : labSteps.length ? labSteps : ["301", "302", "303", "304", "305"]) as any[];
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
  // 座談：研究室那幾區整區不挑（含併在研究室那一區、沒標研究室的頁）
  const labBlocks = new Set<number>(forum ? ((slidesIndex.groups || []) as any[]).filter((g) => (g.slides || []).some((n: number) => all.find((x) => x.n === n)?.lab)).flatMap((g) => g.slides) : []);
  const candidates = all.filter((s) => !s.always && !s.video && s.role !== "divider" && (!s.lab || rooms.includes(s.lab)) && !labBlocks.has(s.n));
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
  if (forum) add("forum", total - briefing - photo, FORUM_TITLES.title_en, FORUM_TITLES.title_2nd, [], "—");
  else {
    add("tour", tour, `Laboratory tour, Rooms ${rooms[0]} to ${rooms[rooms.length - 1]}`, `研究室參訪 ${rooms[0]}–${rooms[rooms.length - 1]}`, rooms, "—");
    add("discussion", discussion, "General discussion", "綜合討論", [], "—");
  }
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

/**
 * 行前通告的「當天動線」：**照今日流程的區塊列，研究室參訪是一整段、不拆到各室**
 * （明確指示）。通告是去問「誰來接待」的，還沒問到人就先把各室的時間寫死，
 * 等於先斬後奏；各室的時段在**回報**那一則才定案（那時候才有簡報人員）。
 */
function routeBlock(v: Visit, labs: any): string {
  const rooms = labStops(v, labs).map((x: any) => x.room);
  const brief = v.itinerary?.find((s) => String(s.room) === "briefing");
  const label = (b: any) =>
    b.kind === "briefing"
      ? `${brief?.location || "302"}　歡迎與中心總體介紹`
      : b.kind === "tour"
      ? `研究室參訪（${rooms.join("、") || "301–305"}，全程同一層樓）`
      : b.kind === "discussion"
      ? "綜合討論"
      : b.kind === "forum"
      ? "與中心老師座談"
      : b.kind === "photo"
      ? "合照"
      : b.title_2nd || b.title_en || "";
  const blocks = (v.programme || []).filter((b) => b && b.start && b.end);
  const lines = blocks.map((b) => `${b.start}–${b.end}　${label(b)}`);
  return [
    "當天動線（時間已排定）：",
    ...lines,
    // 座談的場次沒有研究室參訪，這一句就不用了
    ...(blocks.some((b) => b.kind === "tour") ? ["※ 研究室參訪時段目前尚未分配到各室，確定後再補上。"] : []),
  ].join("\n");
}

/**
 * 通告的最後一段：**一句話＋支援人力表的連結，就這樣**（明確指示，字照給的寫）。
 * 以前後面還有「點進去怎麼填」的說明、接龍的房號清單、回覆期限與署名——全部拿掉了：
 * 表上自己看得懂要填什麼，而這一則是貼進中心自己的 LINE 群組，誰發的大家都看得到。
 * 連結後面接 `#<visit_id>`，老師點進去**直接跳到這一場**、那一張卡片會亮一下，不必在一整張表裡找。
 * 連結是自動產生的（`ensureRotaKey()`），所以一定帶得出去；沒有連結那條路只是保險。
 */
function rollCallBlock(v: Visit, rotaUrl = ""): string {
  // 座談的場次不參觀研究室：問的是老師能否出席（各室的老師是固定的，支援人力表上那一場只選「可參加」「無法參加」）
  const ask = isForum(v) ? "請各研究室回覆，老師能否出席座談" : "請各研究室回覆，該時段由哪位老師或人員接待";
  return [ask, ...(rotaUrl ? [`${rotaUrl}#${v.visit_id}`] : [])].join("\n");
}

/**
 * 座談的場次：五間的老師能否出席（支援人力表上選的；還沒選就是空的）。回報那一則照這一份列。
 * 各研究室的老師是固定的（負責人），所以只記「可參加」「無法參加」，不記名字。
 */
const ATTEND_LABEL: Record<string, string> = { yes: "可參加", no: "無法參加" };
function forumAttendees(v: Visit, labs: any): { room: string; name_zh: string; lead: string; attend: string }[] {
  return ((labs && labs.labs) || []).map((l: any) => ({ room: String(l.room), name_zh: l.name_zh || "", lead: l.lead?.name_zh || l.lead?.name_en || "", attend: ATTEND_LABEL[(v as any).attendance?.[l.room]] || "" }));
}

/**
 * 通告的結尾一定是那一段回覆與連結，**後面什麼都不接**（AI 自己補的期限、署名、客套話一律剪掉），
 * 前面少了當天動線就補回去。兩段都是排好的字，AI 漏掉或改寫過就換回排好的那一份——那是要貼進 LINE 的。
 */
function settleNotice(body: string, route: string, roll: string): string {
  const at = body.indexOf(roll);
  let head = (at >= 0 ? body.slice(0, at) : body).trimEnd();
  if (!head.includes(route)) head = head ? `${head}\n\n${route}` : route;
  return `${head}\n\n${roll}`;
}

function mockLetter(ctx: LetterContext, pageUrl: string, respondUrl: string, contents: { key: string; zh: string }[]): { subject: string; body: string } {
  const v = ctx.visit;
  const location = v.itinerary?.find((s) => s.room === "briefing")?.location || "302";
  if (ctx.kind === "notice" || ctx.kind === "rundown") {
    // 內部通告：中文、條列、貼得進 LINE、不署名。真提示詞同一個結構
    const stops = labStops(v, ctx.labs) as any[];
    const line = (x: any) => `${x.start}–${x.end}　${x.room} ${x.name_zh}　${ctx.kind === "rundown" ? (v as any).presenters?.[x.room] || "（待補）" : x.lead}　${x.minutes} 分`;
    const n = v.headcount || v.guests?.length || 0;
    const head = `${v.org?.name || "（單位待補）"}　${v.date} ${v.start_time}–${endTimeOf(v)}${n ? `　${n} 位` : ""}`;
    return ctx.kind === "notice"
      ? {
          subject: `（AI_MOCK）行前通告：${v.org?.name || v.visit_id} ${v.date} 來訪`,
          body: `各位老師好：\n\n${head}\n\n${routeBlock(v, ctx.labs)}\n\n${rollCallBlock(v, ctx.rotaUrl)}`,
        }
      : {
          subject: `（AI_MOCK）定案回報：${v.org?.name || v.visit_id} ${v.date}`,
          body: isForum(v)
            ? `各位老師好：\n\n${head}　座談\n\n${(v.programme || []).map((b) => `${b.start}–${b.end}　${b.title_2nd || b.title_en}`).join("\n")}\n\n座談出席：\n${forumAttendees(v, ctx.labs).map((x) => `${x.room} ${x.name_zh}　${x.lead}　${x.attend || "（待回覆）"}`).join("\n")}\n\n有問題直接回這則訊息。`
            : `各位老師好：\n\n${head}\n\n定案動線與簡報人員：\n${stops.map(line).join("\n")}\n\n有問題直接回這則訊息。`,
        };
  }
  if (ctx.kind === "confirmation") {
    return {
      subject: `(AI_MOCK) Your visit to the Green Health Research Center, ${v.date}`,
      body: `Dear colleagues,\n\nWe look forward to welcoming ${v.org?.name || "you"} on ${v.date} at ${v.start_time}. We begin with a short overview in Room ${location}, Landscape Building, 3rd floor, ${isForum(v) ? "followed by a roundtable with the faculty" : "and then walk through the laboratories next door"}.\n\n${isForum(v) ? "Programme and the faculty you will meet" : "Programme and the laboratories you will see"}: ${pageUrl}\n\n${senderBlock(ctx)}`,
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
    isForum(v)
      ? `**看了哪幾間**：座談，不參觀研究室${Object.entries((v as any).attendance || {}).some(([, a]) => a === "yes") ? `（出席：${Object.entries((v as any).attendance).filter(([, a]) => a === "yes").map(([room]) => room).sort().join("、")}）` : ""}`
      : `**看了哪幾間**：${(v.itinerary || []).filter((s) => Number(s.minutes) > 0).map((s) => `${s.room}（${s.minutes} 分）`).join("、") || "（無）"}`,
    `**最想看什麼（來賓自己說）**：${[...new Set(responses.flatMap((r) => r.most_wanted_rooms || []))].join("、") || "（無）"}`,
    `**最想看什麼（主持人聽到的）**：${(v.dictation?.extracted?.most_wanted_rooms || []).join("、") || "（無）"}`,
    `**問了哪些問題**：${(v.dictation?.extracted?.questions || []).map((q) => `\n- ${q}`).join("") || "（無）"}`,
    `**想合作誰（來賓自己說）**：${[...new Set(responses.flatMap((r) => r.cooperate_rooms))].join("、") || "（無）"}`,
    `**收到什麼建議**：${responses.filter((r) => r.suggestion).map((r) => `\n- ${r.suggestion}${r.anonymous ? "（不具名）" : ""}`).join("") || "（無）"}`,
    "",
    "（AI_MOCK 示範摘要）",
  ].join("\n");
}

