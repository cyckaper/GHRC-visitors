/**
 * 測試用的「以前的參訪名單」試算表（API 測試與瀏覽器測試共用）。照真的那一份的樣子做：
 * 日期格子存成 Excel 的數字（45299＝2024/1/8）、空白格寫成 `<c …/>`（LibreOffice 存的檔就是）、
 * 第一列有兩個國家的兩個單位（研討會講者，要拆開、算同一場）、有一列沒有日期、第二張工作表是統計（不算參訪）。
 */
import JSZip from "jszip";

export async function pastVisitsXlsx() {
  const strings = [];
  const s = (t) => { if (!strings.includes(t)) strings.push(t); return strings.indexOf(t); };
  const cell = (ref, t) => (t === "" ? `<c r="${ref}" s="0"/>` : typeof t === "number" ? `<c r="${ref}"${ref[0] === "B" ? ' s="1"' : ""} t="n"><v>${t}</v></c>` : `<c r="${ref}" t="s"><v>${s(t)}</v></c>`);
  const row = (r, cells) => `<row r="${r}">${cells.map((t, i) => cell(`${String.fromCharCode(65 + i)}${r}`, t)).join("")}</row>`;
  const sheet1 = [
    row(1, ["編號", "日期", "類別", "國家／地區", "來訪單位", "來訪人員", "同行單位", "交流重點／成果"]),
    row(2, [1, 45299, "國際", "美國、芬蘭", "美國伊利諾大學、芬蘭赫爾辛基大學", "John A. Smith 教授（伊利諾大學）、Aino Virtanen 教授（赫爾辛基大學）", "", "研討會講者"]),
    row(3, [2, 45714, "企業", "臺灣", "佐臻股份有限公司（AR眼鏡公司）", "王大明副總經理", "", "參訪 303 與 304"]),
    row(4, [3, "", "國內", "臺灣", "某某大學景觀系", "系上師生", "", ""]),
  ].join("");
  const sheet2 = [row(1, ["類別", "場次"]), row(2, ["國際", 14])].join("");
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="參訪名單" sheetId="1" r:id="rId1"/><sheet name="統計" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `<styleSheet><numFmts><numFmt numFmtId="165" formatCode="yyyy/mm/dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs></styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${sheet1}</sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<worksheet><sheetData>${sheet2}</sheetData></worksheet>`);
  zip.file("xl/sharedStrings.xml", `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}
