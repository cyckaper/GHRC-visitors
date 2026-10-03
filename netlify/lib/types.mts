/** 資料模型（CLAUDE.md「資料模型」一節）。四張表靠 visit_id 串接。 */

export type Lang = "en" | "zh" | "ko" | "ja";
export type OrgType = "government" | "university" | "enterprise" | "school" | "ngo" | "other";
export type Room = "301" | "302" | "303" | "304" | "305";

export interface Guest {
  name: string;
  title: string;
  email: string;
  role: "lead" | "member";
  affiliation?: string;
  /** 名片上讀到的電話（/api/cards）；手打的名單通常沒有。 */
  phone?: string;
  /**
   * 這一場的**主要聯絡人**（負責收信、確認行程的那個人）。`role: "lead"` 是禮賓身分（主賓），
   * 兩者常常不是同一個人：確認信預設只寄給 contact，感謝信才寄給名單上每一位。
   */
  contact?: boolean;
}

export interface ProgrammeBlock {
  start: string; // HH:MM（台北時間）
  end: string;
  kind: "briefing" | "tour" | "discussion" | "forum" | "photo" | "other"; // forum：座談（座談的場次不參觀研究室，見 lib/visit.mjs isForum）
  title_en: string;
  title_2nd: string;
  rooms?: string[];
  slides_range?: string; // 例如 "01 – 12"
}

export interface ItineraryStep {
  room: string; // "briefing"（總體介紹，固定第一步）或 301–305
  minutes: number;
  focus?: string;
  location?: string; // briefing 的地點，預設 302（lib/visit.mjs DEFAULT_BRIEFING_LOCATION）
}

/** 專屬頁面的「當天資料」：deck_pdf／photos 是媒體庫 key（materials/<visit_id>/<file>）或 https 連結。 */
export interface Materials {
  deck_pdf: string;
  photos: string[];
  links: { title: string; url: string }[];
}

export interface TextEdit {
  slide: number;
  find: string;
  replace: string;
}

export interface Visit {
  visit_id: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  end_time?: string; // 幾點結束（主辦端填的就是這個；duration_minutes 由它算出來）
  duration_minutes: number;
  org: { name: string; name_local?: string; type: OrgType; country: string };
  guests: Guest[];
  headcount: number;
  contact_teacher: string;
  purpose: string;
  interests: string[];
  language: Lang;
  /** forum：座談的場次（跟老師們座談，不參觀研究室）；沒有或 tour：照常參觀研究室。 */
  format?: "tour" | "forum";
  programme: ProgrammeBlock[];
  itinerary: ItineraryStep[];
  slides: number[];
  text_edits: TextEdit[];
  cover_text?: { org_line: string; guest_lines: string[]; date_line: string };
  page_url: string;
  /** 訪前功課（/api/research）：AI 查過的公開資料與可能的參訪目的，給主辦端看的，不對外。 */
  background?: {
    org_profile: string;
    people: { name: string; note: string }[];
    purposes: string[];
    rooms: { room: string; why: string }[];
    prepare: string[];
    unknowns: string[];
    sources: { title: string; url: string }[];
    searched?: boolean;
    /** running：背景還在查；done：查完；error：查失敗（error 有原因）。 */
    status?: "running" | "done" | "error";
    started_at?: string;
    error?: string;
    researched_at?: string;
  };
  /** 訪客名片原圖（/api/cards）：讀錯時回頭核對用，Drive 備份會一起帶走。 */
  cards?: { key: string; names: string[]; read_at: string }[];
  materials: Materials;
  // skip=true：這場不用簡報，只口頭介紹（後台「簡報」分頁勾的）
  // skip=true：這場不用簡報；fingerprint＝產檔那一刻的行程指紋（行程之後改了就知道這份 .pptx 是舊的）
  deck: { skip?: boolean; slides?: number; spec_path?: string; pptx_url?: string; pdf_url?: string; generated_at?: string; fingerprint?: string };
  signbook: { photo_key?: string; transcript?: string; entries?: SignbookEntry[]; read_at?: string };
  dictation: { audio_key?: string; transcript?: string; extracted?: DictationExtract; recorded_at?: string };
  letters: {
    // fingerprint＝寄出那一刻的行程指紋：寄出去的信不會跟著網頁更新，行程改了要說一聲
    confirmation?: { subject: string; body: string; sender?: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string; fingerprint?: string };
    thanks?: { subject: string; body: string; sender: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string; fingerprint?: string };
    /** 行前通告（寄給中心自己的研究室）：哪個單位什麼時候來，請各室安排簡報人員。 */
    notice?: { subject: string; body: string; sender?: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string; fingerprint?: string };
    /** 回報（通告的下一步）：定案的時間、各室的簡報人員與內容。 */
    rundown?: { subject: string; body: string; sender?: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string; fingerprint?: string };
  };
  /** 各研究室回覆的**簡報人員**（房號 → 姓名，可能不只一位）：通告收到回覆後由主辦端回填。 */
  presenters?: Record<string, string>;
  /**
   * 訪客地圖上這個單位在哪裡（geo-background 用 AI 查的）。key＝查的是哪一個單位（名稱＋國家），
   * 對不上就重查；precision 是 country 時 lat／lon 是空的，地圖放在國家的位置。
   */
  geo?: { key: string; lat: number | null; lon: number | null; place: string; precision: "site" | "city" | "region" | "country"; at: string };
  summary: string;
  /** 產摘要的時間：summary-cron 用它跟最新那筆回覆比，比較舊就自己重寫一份。 */
  summary_at?: string;
  /** 後續那四件事裡「這一場本來就不會有」的（例如沒有簽名簿、沒交換名片）：標了就不算未完成。 */
  wrapup?: { na?: string[] };
  /** 自動提醒（reminder-cron）：後續提醒寄出的時間與收件者，一場只寄一次。 */
  reminders?: { wrapup_sent_at?: string; wrapup_to?: string };
  /** Google Drive 備份（/api/drive）：這場參訪在 Drive 上的資料夾。 */
  drive?: { folder_id?: string; url?: string; backed_up_at?: string; items?: number };
  /**
   * 從以前的參訪名單匯入的（/api/import）：哪一個檔、第幾列；原表同一列拆成好幾個單位時 group 相同＝同一場。
   * people／companions 是原表「來訪人員」「同行單位」那兩格照抄（沒有名字的職稱、師生、同仁）。
   */
  imported?: { from: string; row: string; group: string; at: string; people: string; companions: string };
  /**
   * 公開頁上的說明（中心首頁的地圖與 /visits 來訪紀錄頁；/api/visit-log 寫的，匯入時帶原表的）。
   * hidden＝這一場整個不公開。名單、email、來訪目的、背景研判不在這裡。
   */
  public?: { people_zh: string; people_en: string; note_zh: string; note_en: string; hidden: boolean };
  status: "draft" | "confirmed" | "done";
  created_at: string;
  updated_at: string;
  plan_rationale?: string;
  uncertainties?: string[];
}

export interface SignbookEntry {
  text: string;
  signed_by: string;
  language: string;
}

export interface DictationExtract {
  who_came: string;
  most_wanted_rooms: string[];
  questions: string[];
  cooperation: string;
  follow_ups: string[];
  other: string;
}

export interface ResponseRow {
  visit_id: string;
  source: string; // letter | onsite | signbook | dictation
  anonymous: boolean;
  name: string;
  email: string;
  most_wanted_rooms: string[];
  cooperate_rooms: string[];
  next_actions: string[];
  next_other: string;
  signbook_text: string;
  suggestion: string;
  note: string;
  submitted_at: string;
}

export interface SlidePerf {
  visit_id: string;
  org_type: string;
  slide: number;
  used: boolean;
  asked: boolean;
  mentioned: boolean;
}
