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
  room: string;
  minutes: number;
  focus?: string;
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
  deck: { spec_path?: string; pptx_url?: string; pdf_url?: string; generated_at?: string };
  signbook: { photo_key?: string; transcript?: string; entries?: SignbookEntry[]; read_at?: string };
  dictation: { audio_key?: string; transcript?: string; extracted?: DictationExtract; recorded_at?: string };
  letters: {
    confirmation?: { subject: string; body: string; drafted_at: string };
    thanks?: { subject: string; body: string; sender: string; drafted_at: string; sent_to?: { name: string; email: string }[]; sent_at?: string };
  };
  summary: string;
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
