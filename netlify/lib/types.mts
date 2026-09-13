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
}

export interface ProgrammeBlock {
  start: string; // HH:MM（台北時間）
  end: string;
  kind: "briefing" | "tour" | "discussion" | "photo" | "other";
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
  duration_minutes: number;
  org: { name: string; name_local?: string; type: OrgType; country: string };
  guests: Guest[];
  headcount: number;
  contact_teacher: string;
  purpose: string;
  interests: string[];
  language: Lang;
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
  deck: { skip?: boolean; slides?: number; spec_path?: string; pptx_url?: string; pdf_url?: string; generated_at?: string };
  signbook: { photo_key?: string; transcript?: string; entries?: SignbookEntry[]; read_at?: string };
  dictation: { audio_key?: string; transcript?: string; extracted?: DictationExtract; recorded_at?: string };
  letters: {
    confirmation?: { subject: string; body: string; sender?: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string };
    thanks?: { subject: string; body: string; sender: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string };
  };
  summary: string;
  /** Google Drive 備份（/api/drive）：這場參訪在 Drive 上的資料夾。 */
  drive?: { folder_id?: string; url?: string; backed_up_at?: string; items?: number };
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

export interface TimelineSignal {
  visit_id: string;
  room: string;
  at: string; // ISO
  source: string; // presentation | nfc | student | guest | schedule
  note?: string;
}

export interface SlidePerf {
  visit_id: string;
  org_type: string;
  slide: number;
  used: boolean;
  asked: boolean;
  mentioned: boolean;
}
