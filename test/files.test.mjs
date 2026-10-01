/** 名單檔讀取：用 JSZip 現做最小的 docx／xlsx／pptx，驗證文字抽取、Big5、不支援格式。 */
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractFile, decodeText, docxText, xlsxText, excelSerial } from "../netlify/lib/files.mts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
async function makeDocx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>
    <w:p><w:r><w:t>參訪名單 Visitor list</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>職稱</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>email</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Simon Kilbane</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Programme Director</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>simon@uwa.edu.au</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Jane </w:t></w:r><w:r><w:t>Doe</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Lecturer</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>jane@uwa.edu.au</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t xml:space="preserve">Purpose: </w:t></w:r><w:r><w:t>collaboration &amp; exchange</w:t></w:r></w:p>
  </w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}
async function makeXlsx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="名單" sheetId="1" r:id="rId1"/><sheet name="備註" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file("xl/sharedStrings.xml", `<sst><si><t>姓名</t></si><si><t>Email</t></si><si><r><t>Kim </t></r><r><t>Lee</t></r></si><si><t>kim.lee@uwa.edu.au</t></si><si><t>陳惠美</t></si></sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>3</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Ann Wu</t></is></c><c r="C3" t="b"><v>1</v></c></row>
  </sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row></sheetData></worksheet>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}
async function makePptx() {
  const zip = new JSZip();
  zip.file("ppt/slides/slide2.xml", `<p:sld xmlns:a="a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:a="a"><a:p><a:r><a:t>Visiting </a:t></a:r><a:r><a:t>Delegation</a:t></a:r></a:p></p:sld>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

test("docx: paragraphs and table rows become tab-separated lines; split runs are joined", async () => {
  const text = await docxText(await makeDocx());
  assert.ok(text.includes("參訪名單 Visitor list"));
  assert.ok(text.includes("Simon Kilbane\tProgramme Director\tsimon@uwa.edu.au"));
  assert.ok(text.includes("Jane Doe\tLecturer\tjane@uwa.edu.au"));
  assert.ok(text.includes("Purpose: collaboration & exchange"));
});

test("xlsx: shared strings, inline strings, numbers, booleans, sheet names, column gaps", async () => {
  const text = await xlsxText(await makeXlsx());
  assert.ok(text.startsWith("## 名單"));
  assert.ok(text.includes("姓名\tEmail\t3"));
  assert.ok(text.includes("Kim Lee\tkim.lee@uwa.edu.au"));
  assert.ok(text.includes("Ann Wu\t\tTRUE"));
  assert.ok(text.includes("## 備註\n陳惠美"));
});

test("xlsx: 日期格子照格式轉回日期；空白格子（<c …/>）不會吃掉右邊那一格", async () => {
  // 以前的參訪名單就是這樣：日期存成 45299（從 1899-12-30 算第幾天），同一列的空白格寫成 <c r="G2" s="6"/>（LibreOffice）
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="參訪名單" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="General"/><numFmt numFmtId="165" formatCode="yyyy/mm/dd"/></numFmts>
    <cellXfs count="5"><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/><xf numFmtId="20"/><xf numFmtId="0"/></cellXfs></styleSheet>`);
  zip.file("xl/sharedStrings.xml", `<sst><si><t>日期</t></si><si><t>來訪單位</t></si><si><t>同行單位</t></si><si><t>交流重點</t></si><si><t>美國伊利諾大學</t></si><si><t>研討會講者</t></si></sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
    <row r="2"/>
    <row r="3"><c r="A3" s="1" t="n"><v>45299</v></c><c r="B3" t="s"><v>4</v></c><c r="C3" s="0"/><c r="D3" t="s"><v>5</v></c><c r="E3" s="3"><v>0.5833333333</v></c><c r="F3" s="4"><v>45299</v></c></row>
    <row r="4"><c r="A4" s="2"><v>46062</v></c></row>
  </sheetData></worksheet>`);
  const text = await xlsxText(new Uint8Array(await zip.generateAsync({ type: "uint8array" })));
  assert.ok(text.includes("2024-01-08\t美國伊利諾大學\t\t研討會講者\t14:00\t45299"), text);
  assert.ok(text.includes("\n2026-02-09"), "內建的日期格式（14）也轉");
  assert.equal(excelSerial(45299), "2024-01-08");
  assert.equal(excelSerial(45299.75, "datetime"), "2024-01-08 18:00");
  assert.equal(excelSerial(43831, "date", true), "2024-01-02", "1904 年制的檔案多 1462 天");
});

test("extractFile dispatches by extension and passes PDF/images through to the model", async () => {
  const pptx = await extractFile("deck.pptx", "", await makePptx());
  assert.equal(pptx.kind, "text");
  assert.ok(pptx.text.indexOf("Visiting Delegation") < pptx.text.indexOf("Second"), "slides in numeric order");
  const csv = await extractFile("list.csv", "text/csv", new TextEncoder().encode("name,email\nA,a@x.org\n"));
  assert.equal(csv.kind, "text");
  assert.ok(csv.text.includes("a@x.org"));
  const pdf = await extractFile("list.pdf", "application/pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  assert.equal(pdf.kind, "document");
  assert.equal(pdf.media_type, "application/pdf");
  const img = await extractFile("photo.JPG", "", new Uint8Array([0xff, 0xd8, 0xff]));
  assert.equal(img.kind, "image");
  assert.equal(img.media_type, "image/jpeg");
  const doc = await extractFile("old.doc", "application/msword", new Uint8Array([0xd0, 0xcf]));
  assert.equal(doc.kind, "unsupported");
  assert.ok(doc.reason.includes(".docx"));
  const bad = await extractFile("x.docx", "", new Uint8Array([1, 2, 3]));
  assert.equal(bad.kind, "unsupported");
  const noext = await extractFile("", "text/plain", new TextEncoder().encode("plain text list"));
  assert.equal(noext.kind, "text");
});

test("decodeText: UTF-8 with BOM, Big5 fallback, UTF-16LE", () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("中文")])), "中文");
  assert.equal(decodeText(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5])), "中文"); // Big5 中文
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), "AB");
});
