import { nowISO, randomId, taipeiToday } from "./http.mts";
import { getStore } from "./store.mts";
import { extractFile } from "./files.mts";
import { aiConfigured, readVisitList } from "./ai.mts";
import { createSheet, sheetFile, sheetInfo, sheetsReady, type SheetInfo } from "./drive.mts";
import { purgePublicVisits } from "./cdn.mts";
import { startBackground } from "./jobs.mts";
import type { Visit } from "./types.mts";
import { importedVisit, listRows, parseVisitTable, planImport, rowsText } from "../../lib/import.mjs";
import { normalizeVisit } from "../functions/visits.mts";

/**
 * 參訪名單自動同步（明確指示：「每一次有增加再自動加入」「地圖應該是自動去 check 這個 Google Drive」）。
 *
 * 名單是**系統自己的一份 Google 試算表**（匯入以前的參訪時勾「同時存成 Google 試算表」建的，在 Drive 的「GHRC 參訪」資料夾）：
 * Drive 的授權只有 drive.file，使用者自己放上去的 xlsx 系統讀不到，所以看的是系統建的這一份。
 * 有人在裡面**加一列**，系統就自己把那一列加進參訪紀錄——兩張地圖、`/visits` 都跟著有，不必再按「匯入」：
 *   - `visit-list-cron` 每十五分鐘問一次 Drive「這份名單改過了沒」（只問修改時間，一次呼叫）；
 *     後台打開「資料」分頁也問一次。改過了才開背景工作（`visit-list-background`）真的去讀。
 *   - 哪幾列是新的：每一列的身分是「日期＋來訪單位」（`lib/import.mjs listRows`）；讀過的記在 `seen`。
 *     列的先後、其他欄改了不算新的一列；改了日期或單位就是新的一列（那本來就是另一場）。
 *   - 新的那幾列照匯入的同一套讀（AI 讀英文名稱、類型、該不該拆）→ `planImport`（系統裡已經有的——同一天、同一個單位——不再建）→ 建立。
 *     **這裡不再給人看過才寫**：名單本身就是主辦端自己維護的那一份，加一列就是要它出現（明確指示）。
 *     加進來的跟匯入的一樣帶原表的「來訪人員」「交流重點」，所以公開的 `/visits` 上就看得到；不想公開的在「資料」分頁勾掉。
 *   - 刪掉一列、改已經加進來的那一列，系統裡那一場**不會**跟著刪或改（要改在「資料」分頁改）——自動刪東西太危險。
 *   - 加完清 CDN（首頁地圖與 `/visits` 重新整理就有），也開一個查位置的工作（地圖上的點落在那個城市，不必等人打開資料分頁）。
 */
const KEY = "sync/visit-list.json";
const MAX_ROWS = 60; // 一次最多讀這麼多列（AI 一段 15 列、四段同時讀）；還有剩的下一輪接著讀
const RETRY_AFTER = 6 * 3600 * 1000; // 讀失敗了：名單沒再改的話，六小時後才再試（不要每十五分鐘打一次 AI）
const RUNNING_FOR = 15 * 60 * 1000; // 背景函式的上限：超過就當作上一輪已經死掉了
const CLAIM_WAIT = 1500; // 兩輪同時開始時，等這麼久再看記號是誰的

export interface ListState {
  file_id: string;
  name: string;
  url: string;
  /** 從哪一個檔建的（使用者匯入的那一份）。 */
  from: string;
  linked_at: string;
  /** 上一次讀完時名單的修改時間：一樣就是沒人改過。 */
  modified_seen: string;
  /** 讀過的列（「日期|來訪單位」）。 */
  seen: string[];
  checked_at?: string;
  last?: { at: string; added: string[]; skipped: { row: string; org: string; reason: string }[] };
  running_since?: string;
  /** 這一輪是誰在讀（同時開了兩輪的話，只有寫進去的那一輪讀）。 */
  claim?: string;
  error?: string;
  error_at?: string;
  error_modified?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function loadList(): Promise<ListState | null> {
  const m = await getStore().getMedia(KEY);
  if (!m) return null;
  try {
    const s = JSON.parse(dec.decode(m.bytes)) as ListState;
    return s?.file_id ? s : null;
  } catch {
    return null;
  }
}

async function saveList(s: ListState): Promise<void> {
  await getStore().putMedia(KEY, enc.encode(JSON.stringify(s)), "application/json");
}

/** 給後台看的樣子（讀過哪幾列那一長串不必送）。 */
export function listSummary(s: ListState | null) {
  if (!s) return { linked: false };
  const { seen, ...rest } = s;
  return { linked: true, ...rest, rows: (seen || []).length };
}

/** 該不該去讀：名單改過了（修改時間跟上次讀完時不一樣），而且不是剛失敗、也不是正在讀。 */
export function listDue(s: ListState, info: SheetInfo, now = Date.now()): boolean {
  if (s.running_since && now - Date.parse(s.running_since) < RUNNING_FOR) return false;
  if (!info.modifiedTime || info.modifiedTime === s.modified_seen) return false;
  if (s.error_at && s.error_modified === info.modifiedTime && now - Date.parse(s.error_at) < RETRY_AFTER) return false;
  return true;
}

/** 記一下「看過了」（修改時間沒變就只更新這個）。寫之前再讀一次：背景那一輪剛寫完的不能被手上這一份舊的蓋回去。 */
export async function touchList(s: ListState): Promise<void> {
  await saveList({ ...((await loadList()) || s), checked_at: nowISO() });
}

/**
 * 寫進參訪紀錄：匯入（`/api/import` 的 commit）與名單同步共用。`planImport` 已經對過一次最新的資料，
 * 有問題的、系統裡已經有的、名單裡重複的不建；其他的做成一般的一場。
 */
export async function createImported(
  plan: ReturnType<typeof planImport>,
  { file, at, site, group }: { file: string; at: string; site: string; group?: (r: any) => string },
): Promise<{ created: string[]; skipped: { row: string; org: string; reason: string }[] }> {
  const store = getStore();
  const skipped: { row: string; org: string; reason: string }[] = [];
  const todo: Visit[] = [];
  for (const r of plan) {
    const reason = r.problems.join("、") || (r.exists ? `已經有了（${r.exists}）` : r.duplicate ? "名單裡重複" : "");
    if (reason) {
      skipped.push({ row: r.source_row, org: r.org.name_local || r.org.name, reason });
      continue;
    }
    const v = normalizeVisit(importedVisit(r, { file, at }) as any, site);
    v.headcount = r.headcount; // 原表沒寫人數就是 0（不知道），不拿名單上有名字的人數充數
    v.created_at = at;
    v.updated_at = at;
    const g = group?.(r);
    if (g && (v as any).imported) (v as any).imported.group = g;
    todo.push(v);
  }
  // 一場一個 key，彼此不衝突：幾筆一起寫，二十幾場也在一般函式的 10 秒內寫完
  const created: string[] = [];
  for (let i = 0; i < todo.length; i += 6) {
    const batch = todo.slice(i, i + 6);
    await Promise.all(batch.map((v) => store.putVisit(v)));
    created.push(...batch.map((v) => v.visit_id));
  }
  return { created, skipped };
}

/** 檔案 → 文字（試算表一張工作表一段）。 */
async function fileText(name: string, mime: string, bytes: Uint8Array): Promise<string> {
  const out = await extractFile(name, mime, bytes);
  if (out.kind !== "text" || !out.text.trim()) throw new Error("名單裡讀不到文字");
  return out.text;
}

/**
 * 連上名單：把使用者匯入的那一份（xlsx／csv）存成系統自己的 Google 試算表。這份檔裡**現在有的每一列都算讀過了**——
 * 主辦端剛剛在預覽裡看過、勾過（沒勾的就是不要，之後也不會被自動加進來）。
 * 讀過的列用兩份文字各算一次（原檔，與 Google 轉過之後匯出的那一份）：轉換時日期、空白的寫法變了也對得上。
 */
export async function linkList(file: { name: string; mime: string; bytes: Uint8Array }): Promise<ListState> {
  if (!(await sheetsReady())) throw new Error("Google Drive 還沒接好（設定分頁看得到）");
  const already = await loadList();
  if (already) return already;
  const text = await fileText(file.name, file.mime, file.bytes);
  const table = listRows(text);
  if (!table) throw new Error("這個檔裡找不到表頭：第一列要有「日期」與「來訪單位」");
  const seen = new Set(table.rows.map((r) => r.key));
  const info = await createSheet("GHRC 參訪名單", file.bytes, file.mime);
  try {
    const back = await sheetFile(info.id);
    for (const r of listRows(await fileText("名單.xlsx", back.mime, back.bytes))?.rows || []) seen.add(r.key);
  } catch {
    /* 讀不回來也沒關係：原檔算的那一份就夠用，對不上的列 planImport 也會認出系統裡已經有了 */
  }
  const fresh = await sheetInfo(info.id).catch(() => info);
  const s: ListState = { file_id: info.id, name: info.name, url: info.url, from: file.name, linked_at: nowISO(), modified_seen: fresh.modifiedTime, seen: [...seen], checked_at: nowISO() };
  await saveList(s);
  return s;
}

/**
 * 讀名單裡新加的那幾列、寫進參訪紀錄。`force`：不管修改時間，現在就讀（後台的「現在就看一次」）。
 * 回傳 { added: [visit_id], skipped, fresh（這一輪讀到幾列新的）, unchanged? }。
 */
export async function syncList({ force = false, site = "" }: { force?: boolean; site?: string } = {}) {
  const s = await loadList();
  if (!s) return { linked: false, added: [] as string[], skipped: [] as any[], fresh: 0 };
  let info: SheetInfo;
  try {
    info = await sheetInfo(s.file_id);
  } catch (e: any) {
    await saveList({ ...s, error: `找不到名單（可能被刪掉了，或不是系統建的那一份）：${e?.message || e}`.slice(0, 300), error_at: nowISO(), checked_at: nowISO() });
    throw e;
  }
  if (info.trashed) {
    const error = "名單在 Google Drive 的垃圾桶裡：拿回來就會繼續自動加";
    await saveList({ ...s, error, error_at: nowISO(), error_modified: info.modifiedTime, checked_at: nowISO() });
    throw new Error(error);
  }
  if (!force && info.modifiedTime === s.modified_seen) {
    await touchList(s);
    return { added: [], skipped: [], fresh: 0, unchanged: true };
  }
  // 同一時間只讓一輪讀：排程與「打開資料分頁」剛好一起觸發的話，兩輪會看到同樣的新列、各建一次。
  // 已經有一輪在讀就讓它讀；兩輪同時開始的話，寫下自己的記號、稍等一下再讀回來，記號還是自己的那一輪才讀。
  if (s.running_since && Date.now() - Date.parse(s.running_since) < RUNNING_FOR) return { added: [], skipped: [], fresh: 0, busy: true };
  const claim = randomId(10);
  await saveList({ ...s, running_since: nowISO(), claim });
  await new Promise((r) => setTimeout(r, CLAIM_WAIT));
  if ((await loadList())?.claim !== claim) return { added: [], skipped: [], fresh: 0, busy: true };
  try {
    const file = await sheetFile(s.file_id);
    const table = listRows(await fileText(`${info.name || s.name}.xlsx`, file.mime, file.bytes));
    if (!table) throw new Error("名單裡找不到表頭：第一列要有「日期」與「來訪單位」");
    const seen = new Set(s.seen || []);
    const fresh = table.rows.filter((r) => !seen.has(r.key));
    const batch = fresh.slice(0, MAX_ROWS);
    let added: string[] = [];
    let skipped: { row: string; org: string; reason: string }[] = [];
    if (batch.length) {
      const mini = rowsText(table, batch);
      const read = aiConfigured() ? await readVisitList(mini, taipeiToday()) : parseVisitTable(mini);
      const plan = planImport(read.rows, await getStore().listVisits());
      // 同一列拆出來的那幾筆算同一場：group 用那一列的身分（列號會因為中間插了一列而跑掉）
      const byN = new Map(batch.map((r) => [String(r.n), r]));
      const name = info.name || s.name;
      const res = await createImported(plan, { file: name, at: nowISO(), site, group: (r) => (byN.has(String(r.source_row)) ? `${name}#${byN.get(String(r.source_row))!.key}` : "") });
      added = res.created;
      skipped = res.skipped;
      // 讀過就記下來：有問題的那一列（例如沒寫日期）補好之後身分就變了，會當成新的一列再讀一次
      for (const r of batch) seen.add(r.key);
    }
    const done = fresh.length <= MAX_ROWS;
    const next: ListState = {
      ...s,
      name: info.name || s.name,
      url: info.url || s.url,
      seen: [...seen],
      // 還有沒讀完的：修改時間先不記，下一輪接著讀
      modified_seen: done ? info.modifiedTime : s.modified_seen,
      checked_at: nowISO(),
      last: batch.length ? { at: nowISO(), added, skipped } : s.last,
    };
    delete next.running_since;
    delete next.claim;
    delete next.error;
    delete next.error_at;
    delete next.error_modified;
    await saveList(next);
    if (added.length) {
      await purgePublicVisits(); // 首頁的地圖與來訪紀錄頁，重新整理就看得到
      await startBackground("geo", {}).catch(() => {}); // 新的單位在哪裡：自己去查，不必等人打開資料分頁
    }
    return { added, skipped, fresh: batch.length };
  } catch (e: any) {
    const fresh = (await loadList()) || s;
    const next: ListState = { ...fresh, error: String(e?.message || e).slice(0, 300), error_at: nowISO(), error_modified: info.modifiedTime, checked_at: nowISO() };
    delete next.running_since;
    delete next.claim;
    await saveList(next);
    throw e;
  }
}
