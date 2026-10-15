/**
 * 歡迎海報（A1）要印的字：一場參訪 → 海報上的每一行。瀏覽器（public/poster.html）與測試共用這一份。
 *
 * 規矩（明確要求：「A1 大小、設計格調要大方、議程 optional、以英語及來訪者雙語製作」）：
 * - **英文為主、來訪者的語言為輔**（跟雙語簡報同一條既有標準）。英語來賓的第二語言是中文。
 * - **名稱一律照第 2 步確認過的欄位，不由 AI 翻譯或音譯**：單位的當地語名稱（org.name_local）要是那個語言的字
 *   （韓國團要有韓文、日本團要有假名或漢字、中文要有漢字）才印；不是就不印、說一聲——印出去就改不了，
 *   寧可少一行也不要把對方的名字寫錯。人名照名單上的寫法印。
 * - 流程的第二語言：主辦端自己寫的那一欄（title_2nd）是那個語言的字才用；不然固定的幾種區塊（總體介紹、
 *   研究室參訪、綜合討論、座談、合照）用 i18n.json 裡已經校過的寫法；主辦端自己加的區塊沒有那個語言的寫法就只印英文。
 * - 固定的字（Welcome、流程標題、QR 說明）放在 public/data/i18n.json（poster_*），跟來賓專頁同一份、同一套校對。
 */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const KANA = /[぀-ヿㇰ-ㇿ]/;
const HAN = /[㐀-鿿豈-﫿]/;

/** 來訪者的語言 → 海報的第二語言（英語來賓、中文來賓都是中文）。 */
export function posterLang(language) {
  return language === "ko" || language === "ja" ? language : "zh";
}

/** 這一段字是不是那個語言寫的（名稱用；流程標題另外更嚴，見 programmeL2）。 */
export function writtenIn(text, lang) {
  const s = String(text || "");
  if (!s.trim()) return false;
  if (lang === "ko") return HANGUL.test(s);
  if (lang === "ja") return (KANA.test(s) || HAN.test(s)) && !HANGUL.test(s);
  return HAN.test(s) && !HANGUL.test(s) && !KANA.test(s);
}

/** 人名、職稱用哪一個 lang 屬性排字（同一個漢字中日韓的字形不一樣）。 */
export function scriptLang(text, lang) {
  const s = String(text || "");
  if (HANGUL.test(s)) return "ko";
  if (KANA.test(s)) return "ja";
  if (HAN.test(s)) return lang === "ja" ? "ja" : "zh-Hant";
  return "en";
}

const LANG_NAME = { zh: ["中文", "Chinese"], ko: ["韓文", "Korean"], ja: ["日文", "Japanese"] };

/** 房號清單 → 「301–305」或「301, 303」。 */
export function roomRange(rooms) {
  const list = [...new Set((rooms || []).map(String).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const nums = list.map(Number);
  const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return consecutive ? `${list[0]}–${list[list.length - 1]}` : list.join(", ");
}

const PLACE_L2 = { zh: (r) => `${r} 室`, ko: (r) => `${r}호`, ja: (r) => `${r}号室` };

/** 這一段在哪裡：研究室參訪寫走哪幾間，總體介紹寫在哪一間（空白就是 302），其他不寫——不猜。 */
function placeOf(block, visit) {
  const steps = Array.isArray(visit?.itinerary) ? visit.itinerary : [];
  if (block?.kind === "tour") {
    const rooms = Array.isArray(block.rooms) && block.rooms.length
      ? block.rooms
      : steps.filter((s) => String(s.room) !== "briefing" && (Number(s.minutes) || 0) > 0).map((s) => s.room);
    return rooms.map(String);
  }
  if (block?.kind === "briefing") {
    const at = String(steps.find((s) => String(s.room) === "briefing")?.location || "").trim() || "302";
    return /^\d{3}$/.test(at) ? [at] : [];
  }
  return [];
}

/**
 * 流程一段的第二語言。主辦端寫的那一欄要是那個語言的字才用（預設那一欄是中文，韓國團不能印中文）；
 * 日文只認有假名的——只有漢字的多半是預設的中文（「綜合討論」不是日文）。
 */
function programmeL2(block, lang, i18n) {
  const own = String(block?.title_2nd || "").trim();
  if (own) {
    if (lang === "zh" && writtenIn(own, "zh")) return own;
    if (lang === "ko" && HANGUL.test(own)) return own;
    if (lang === "ja" && KANA.test(own)) return own;
  }
  const kind = block?.kind && block.kind !== "other" ? block.kind : "";
  return kind ? String(i18n?.[lang]?.[`kind_${kind}`] || "") : "";
}

/**
 * 一場參訪 → 海報內容。
 * @param {object} visit  visits 表的一筆（org、guests、date、language、programme、itinerary、page_url）
 * @param {object} i18n   public/data/i18n.json
 * @returns {{lang:string, welcome:{en:string,l2:string}, programmeTitle:{en:string,l2:string}, caption:{en:string,l2:string},
 *   org:{en:string,l2:string}, people:Array<{name:string,title:string,lang:string}>, more:{count:number,en:string,l2:string},
 *   date:string, programme:Array<{time:string,en:string,l2:string,place_en:string,place_l2:string}>, qr_url:string,
 *   warnings:Array<{zh:string,en:string}>}}
 */
export function posterContent(visit, i18n) {
  const v = visit || {};
  const lang = posterLang(v.language);
  const en = i18n?.en || {}, l2 = i18n?.[lang] || {};
  const [langZh, langEn] = LANG_NAME[lang];
  const warnings = [];

  const name = String(v.org?.name || "").trim();
  const local = String(v.org?.name_local || "").trim();
  let orgL2 = "";
  if (local && local !== name) {
    if (writtenIn(local, lang)) orgL2 = local;
    else warnings.push({
      zh: `單位的當地語名稱「${local}」不是${langZh}，海報上不印（要印就在第 2 步改成對方自己的${langZh}寫法）。`,
      en: `The organisation’s local name “${local}” is not in ${langEn}, so it is left off the poster (enter their own ${langEn} name in step 2 to print it).`,
    });
  }

  // 主賓（名單上標「主賓」的人）；四位以上寫前兩位＋「and N colleagues」（跟簡報封面同一個寫法，寧可少寫也不縮字）
  const leads = (Array.isArray(v.guests) ? v.guests : []).filter((g) => g && g.role === "lead" && String(g.name || "").trim());
  const all = leads.map((g) => ({ name: String(g.name).trim(), title: String(g.title || "").trim(), lang: scriptLang(g.name, lang) }));
  const people = all.length > 3 ? all.slice(0, 2) : all;
  const moreCount = all.length - people.length;
  const more = {
    count: moreCount,
    en: moreCount ? `and ${moreCount} colleagues` : "",
    l2: moreCount ? { zh: `及其他 ${moreCount} 位來賓`, ko: `외 ${moreCount}명`, ja: `ほか ${moreCount} 名` }[lang] : "",
  };

  const programme = (Array.isArray(v.programme) ? v.programme : []).filter((b) => b && (b.start || b.title_en || b.title_2nd)).map((b) => {
    const kindEn = b.kind && b.kind !== "other" ? String(en[`kind_${b.kind}`] || "") : "";
    const titleEn = String(b.title_en || "").trim() || kindEn;
    const second = programmeL2(b, lang, i18n);
    if (!second && titleEn) warnings.push({
      zh: `流程「${titleEn}」沒有${langZh}的寫法，海報上只印英文。`,
      en: `“${titleEn}” has no ${langEn} wording, so only the English is printed.`,
    });
    const range = roomRange(placeOf(b, v));
    const many = /[–,]/.test(range);
    return {
      time: String(b.start || ""),
      en: titleEn,
      l2: second,
      place_en: range ? `${many ? "Rooms" : "Room"} ${range}` : "",
      place_l2: range ? PLACE_L2[lang](range) : "",
    };
  });

  return {
    lang,
    welcome: { en: String(en.poster_welcome || "Welcome"), l2: String(l2.poster_welcome || "") },
    programmeTitle: { en: String(en.poster_programme || "Programme"), l2: String(l2.poster_programme || "") },
    caption: { en: String(en.poster_qr || ""), l2: String(l2.poster_qr || "") },
    org: { en: name || local, l2: orgL2 },
    people,
    more,
    date: String(v.date || ""),
    programme,
    qr_url: String(v.page_url || ""),
    warnings,
  };
}
