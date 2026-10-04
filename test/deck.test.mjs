/**
 * 產檔 CLI 與 slim-master 的測試，用合成母簡報（scripts/make-fixture.py）。
 * 沒有 python-pptx 時整組 skip。DECK_TEST_OUT 指定輸出目錄可留下檔案人工檢查。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildDeck, inspectDeck } from "../cli/deck.mjs";
import { Deck, slimDeck, hasEmbeddedMedia, imageInfo, coverLines, slideBlock } from "../cli/lib/pptx.mjs";
import zlib from "node:zlib";

/** 一張真的 PNG（全黑）：寬、高、色彩型態（2＝RGB，6＝RGBA 有透明）。 */
function pngBytes(w, h, colorType = 2) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Buffer.alloc((w * (colorType === 6 ? 4 : 3) + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const FIXTURE = "test/fixtures/generated/master-fixture.pptx";
if (!existsSync(FIXTURE)) spawnSync("python3", ["scripts/make-fixture.py", FIXTURE], { stdio: "inherit" });
const available = existsSync(FIXTURE);
const outDir = process.env.DECK_TEST_OUT || (await mkdtemp(path.join(os.tmpdir(), "ghrc-deck-")));

const spec = {
  visit_id: "2026-10-07-uwa",
  page_url: "https://visit.healsdesign.org/2026-10-07-uwa",
  language: "ko",
  slides: [1, 2, 3, 5, 9, 10, 99],
  programme: [
    { start: "10:00", end: "10:20", kind: "briefing", title_en: "Center overview", title_2nd: "센터 개요", slides_range: "01 – 04" },
    { start: "10:20", end: "11:00", kind: "tour", title_en: "Laboratory tour", title_2nd: "실험실 견학", slides_range: "—" },
    { start: "11:00", end: "11:20", kind: "discussion", title_en: "Discussion", title_2nd: "토론", slides_range: "—" },
    { start: "11:20", end: "11:30", kind: "photo", title_en: "Group photo", title_2nd: "기념 촬영", slides_range: "—" },
  ],
  text_edits: [
    { slide: 1, find: "Visiting Organisation Name", replace: "University of Western Australia" },
    { slide: 1, find: "Guest Name, Title", replace: "Simon Kilbane, Programme Director" },
    { slide: 1, find: "text that is not there", replace: "x" },
  ],
};
const slidesIndex = { slides: [{ n: 1, role: "cover" }, { n: 2, role: "programme" }, { n: 5, role: "organisation" }, { n: 10, role: "closing" }] };
const translate = async (texts, lang) => texts.map((t) => `[${lang}] ${t}`);

const masterFixes = JSON.parse(await readFile("public/data/master-fixes.json", "utf8")).fixes;

test("inspect lists every slide with its media", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const info = await inspectDeck(await readFile(FIXTURE));
  assert.equal(info.slide_count, 10);
  assert.ok(info.slides[6].media.some((m) => m.part.endsWith(".mp4")));
  assert.ok(info.slides[7].media[0].bytes > 3_000_000);
});

test("build: subset, edits, programme table, Korean swap, ask + QR slides, orphan cleanup, validation", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const { pptx, report, dump } = await buildDeck(spec, await readFile(FIXTURE), { slidesIndex, translate, lang: "ko" });
  await writeFile(path.join(outDir, "ko.pptx"), pptx);
  assert.equal(report.output_slides, 8, "6 kept + ask + qr");
  assert.deepEqual(report.validation.errors, []);
  assert.equal(report.edits.applied, 2);
  assert.equal(report.edits.missed.length, 1);
  assert.ok(report.warnings.some((w) => w.includes("99")));
  assert.equal(report.programme_table, "filled");
  assert.equal(report.translated > 0, true);

  const deck = await Deck.load(pptx);
  const files = deck.files();
  assert.ok(!files.some((f) => f.endsWith(".mp4")), "video from dropped slide removed");
  assert.ok(!files.includes("ppt/media/image3.png"), "big image from dropped slide removed");
  assert.ok(files.includes("ppt/media/image1.png"), "portrait shared by kept slides stays");
  assert.equal(files.filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).length, 0, "the master's speaker notes are left out (they were written for the previous visitors)");
  assert.equal(report.notes_removed, 1);
  const slides = await deck.slides();
  assert.equal(slides.length, 8);
  const cover = await deck.paragraphs(slides[0].path);
  assert.ok(cover.some((p) => p.includes("University of Western Australia")));
  assert.ok(cover.some((p) => p.includes("Simon Kilbane")));
  const prog = await deck.paragraphs(slides[1].path);
  assert.ok(prog.includes("10:00 – 10:20") && prog.includes("센터 개요") && prog.includes("11:20 – 11:30"), "table filled with 4 rows");
  assert.ok(!prog.includes("研究室參訪 301–305"), "old table rows gone");
  const xml3 = await deck.text(slides[2].path);
  assert.ok(/\[ko\] 四間研究室/.test(xml3), "Chinese run replaced by translation");
  assert.ok(!/為什麼是現在/.test(xml3), "the contents slide keeps only the chapters in this deck (slide 9 is chapter 03)");
  assert.ok(/lang="ko-KR"[^>]*>\s*<a:ea typeface="Malgun Gothic"\/>/.test(xml3), "Korean font set on translated runs");
  for (const m of xml3.matchAll(/<a:t>([^<]*)<\/a:t>/g)) if (/\p{Script=Han}/u.test(m[1])) assert.ok(m[1].startsWith("[ko] "), `untranslated run left on contents slide: ${m[1]}`);
  const askTitle = await deck.paragraphs(slides[6].path);
  assert.equal(askTitle[0], "Which part would you most like to see?");
  assert.equal(askTitle[1], "어느 부분을 가장 보고 싶으십니까?");
  assert.ok(askTitle.some((p) => p.includes("Chun-Yen Chang")), "five leads kept from the organisation slide");
  const qrRels = await deck.rels(slides[7].path);
  assert.ok(qrRels.some((r) => r.part && /^ppt\/media\/image\d+\.png$/.test(r.part) && r.type.endsWith("/image")), "QR png linked");
  const qrText = await deck.paragraphs(slides[7].path);
  assert.ok(qrText.some((p) => p.includes("visit.healsdesign.org/2026-10-07-uwa")));
  assert.ok(dump.length === 8);
  const v = await deck.validate();
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
});

test("build: English-only variant strips every Chinese run", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const { pptx, report } = await buildDeck({ ...spec, language: "en", slides: [1, 2, 3, 4, 9, 10] }, await readFile(FIXTURE), { slidesIndex, lang: "en" });
  await writeFile(path.join(outDir, "en.pptx"), pptx);
  assert.equal(report.output_slides, 8);
  const deck = await Deck.load(pptx);
  for (const s of await deck.slides()) {
    const xml = await deck.text(s.path);
    assert.ok(!/<a:t>[^<]*\p{Script=Han}/u.test(xml), `Han text left on ${s.path}`);
  }
  assert.equal((await deck.paragraphs((await deck.slides())[6].path))[0], "Which part would you most like to see?");
});

test("build: page 2's slide-number column fills itself when nobody typed one (the admin no longer asks for it)", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 後台的今日流程不再請人填「頁碼」：總體簡報＝從第 1 頁到最後一張選用頁，其他區塊「—」；有填的照填的
  const programme = spec.programme.map((b, i) => ({ ...b, slides_range: i === 3 ? "（現場）" : "" }));
  const { pptx } = await buildDeck({ ...spec, language: "en", slides: [1, 2, 3, 4, 9, 10], programme }, await readFile(FIXTURE), { slidesIndex, lang: "en" });
  const deck = await Deck.load(pptx);
  const prog = await deck.paragraphs((await deck.slides())[1].path);
  assert.ok(prog.includes("01 – 06"), `the overview covers the six chosen slides (the ask and QR pages come after): ${prog.join(" | ")}`);
  assert.equal(prog.filter((p) => p === "—").length, 2, "the tour and the discussion have no slides");
});

test("build: Chinese variant keeps the deck as is (no translator needed)", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const { report } = await buildDeck({ ...spec, language: "zh", text_edits: [] }, await readFile(FIXTURE), { slidesIndex, lang: "zh" });
  assert.equal(report.translated, undefined);
  assert.equal(report.edits.applied, 0);
});

test("build: refuses Korean without a translator", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  await assert.rejects(() => buildDeck(spec, readFileSyncBuf(), { slidesIndex, lang: "ko" }), /翻譯器/);
});
function readFileSyncBuf() {
  return readFile(FIXTURE);
}

test("slimDeck (browser-side slimming): strips the video with a link, renames a resized image to .jpeg and retargets rels, stays valid", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const src = await readFile(FIXTURE);
  assert.equal(await hasEmbeddedMedia(src), true);
  // 假縮圖：回一張很小的 PNG 當 JPEG（測試只看改名與 rels），大圖門檻 3 MB。
  // 比例要跟原圖一樣（4000×3000 → 400×300）：縮完比例不對的會被擋下來、維持原檔（照片不拉變形）
  const tiny = pngBytes(400, 300);
  const resized = [];
  const { pptx, report } = await slimDeck(src, { videoLinks: { 7: "https://youtu.be/demo" }, resizeImage: async (bytes, ext) => { resized.push(ext); return { bytes: new Uint8Array(tiny), ext: "jpeg" }; } });
  await writeFile(path.join(outDir, "slim-js.pptx"), pptx);
  assert.equal(report.videos_removed, 1);
  assert.equal(report.images_resized, 1);
  assert.deepEqual(resized, ["png"]);
  assert.ok(pptx.length < 1_000_000, `slim output is ${pptx.length} bytes`);
  const deck = await Deck.load(pptx);
  const files = deck.files();
  assert.ok(!files.some((f) => /\.(mp4|m4v|mov)$/i.test(f)), "video removed");
  assert.ok(files.includes("ppt/media/image3.jpeg") && !files.includes("ppt/media/image3.png"), "big png renamed to jpeg");
  assert.equal(await hasEmbeddedMedia(pptx), false);
  const slides = await deck.slides();
  assert.equal(slides.length, 10, "every slide kept");
  const s7 = await deck.text(slides[6].path);
  assert.ok(!/videoFile|p14:media|ppaction:\/\/media|<p:timing>/.test(s7), "media markup gone");
  assert.ok(s7.includes("youtu.be/demo"), "video link text added");
  const rels7 = await deck.rels(slides[6].path);
  assert.ok(rels7.some((x) => x.external && x.target === "https://youtu.be/demo"), "hyperlink rel added");
  assert.ok(rels7.some((x) => x.part === "ppt/media/image2.png"), "poster frame kept");
  const rels8 = await deck.rels(slides[7].path);
  assert.ok(rels8.some((x) => x.part === "ppt/media/image3.jpeg"), "slide rels retargeted to the jpeg");
  const v = await deck.validate();
  assert.deepEqual(v.errors, []);
  // 沒有縮圖函式：只抽影片；再拿去產檔也要能用
  const onlyVideo = await slimDeck(src, {});
  assert.equal(onlyVideo.report.images_resized, 0);
  assert.ok((await Deck.load(onlyVideo.pptx)).files().includes("ppt/media/image3.png"));
  const built = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 7, 10], text_edits: [] }, pptx, { slidesIndex, lang: "zh" });
  assert.deepEqual(built.report.validation.errors, []);
});

test("slim-master: strips the video (with link), downscales the big image, keeps the deck valid", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const out = path.join(outDir, "slim.pptx");
  const r = spawnSync("python3", ["scripts/slim-master.py", FIXTURE, "--out", out, "--video-link", "7=https://youtu.be/demo", "--target-mb", "5"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const buf = await readFile(out);
  assert.ok(buf.length < 2_000_000, `slim output is ${buf.length} bytes`);
  const deck = await Deck.load(buf);
  const files = deck.files();
  assert.ok(!files.some((f) => /\.(mp4|m4v|mov)$/i.test(f)), "video removed");
  assert.ok(files.includes("ppt/media/image3.jpeg") && !files.includes("ppt/media/image3.png"), "big png became jpeg");
  const slides = await deck.slides();
  assert.equal(slides.length, 10, "slim master keeps every slide");
  const s7 = await deck.text(slides[6].path);
  assert.ok(!/videoFile|p14:media|ppaction:\/\/media|<p:timing>/.test(s7), "media markup gone");
  assert.ok(s7.includes("youtu.be/demo"), "video link text added");
  const rels7 = await deck.rels(slides[6].path);
  assert.ok(rels7.some((x) => x.external && x.target === "https://youtu.be/demo"), "hyperlink rel added");
  assert.ok(rels7.some((x) => x.part === "ppt/media/image2.png"), "poster frame kept");
  const v = await deck.validate();
  assert.deepEqual(v.errors, []);
  // slim master 再拿去產檔也要能用
  const built = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 7, 10], text_edits: [] }, buf, { slidesIndex, lang: "zh" });
  assert.deepEqual(built.report.validation.errors, []);
  await writeFile(path.join(outDir, "from-slim.pptx"), built.pptx);
});


test("母簡報寫「四間研究室／301-304」——每一份產出的簡報都要更正成五間、301-305", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const withFixes = { ...spec, language: "zh", slides: [1, 2, 3, 5, 10], text_edits: [] };
  const { pptx, report } = await buildDeck(withFixes, await readFile(FIXTURE), { slidesIndex, masterFixes, lang: "zh" });
  const deck = await Deck.load(pptx);
  const text = (await Promise.all(deck.files().filter((f) => /ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => deck.text(f)))).join("\n");
  assert.ok(text.includes("五間研究室"), "中文：四間 → 五間");
  assert.ok(!text.includes("四間研究室"));
  assert.ok(text.includes("Five Laboratories"), "英文：Four → Five");
  assert.ok(!text.includes("Four Laboratories"));
  // 報告要說動了哪幾處，人才知道系統改過母簡報的字
  assert.deepEqual(
    (report.fixes || []).map((f) => [f.find, f.count]).sort(),
    [["Four Laboratories", 1], ["四間研究室", 1]].sort(),
  );
  assert.deepEqual(report.validation.errors, []);
  // 沒給更正清單就什麼都不動（CLI／瀏覽器沒載到那個檔也不能害產檔停下來）
  const plain = await buildDeck(withFixes, await readFile(FIXTURE), { slidesIndex, lang: "zh" });
  assert.equal(plain.report.fixes, undefined);
});

test("同一段裡有兩處也都要換（editText 的 all）", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const deck = await Deck.load(await readFile(FIXTURE));
  const page = deck.files().find((f) => /ppt\/slides\/slide3\.xml$/.test(f));
  assert.equal(await deck.editText(page, [{ find: "研究室", replace: "研究室", all: true }]) > 0, true);
});

test("選到影片頁時，影片要留在產出的簡報裡——現場才播得動", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 以前產檔前會先把母簡報瘦身（抽掉影片），產出來的簡報按下去沒反應。
  // 瘦身是「放上站台」才需要的事；當場選的母簡報原封不動拿來產檔，影片就跟著選到的那一頁進來。
  const withVideo = { ...spec, language: "zh", slides: [1, 2, 7, 10], text_edits: [] };
  const { pptx, report } = await buildDeck(withVideo, await readFile(FIXTURE), { slidesIndex, lang: "zh" });
  const files = (await Deck.load(pptx)).files();
  assert.ok(files.some((f) => /\.mp4$/i.test(f)), "影片留下來了");
  assert.equal(report.videos, 1, "報告說留了幾支，人才知道這一份為什麼這麼大");
  // 沒選到影片頁的那一場不會平白多一支
  const without = await buildDeck({ ...withVideo, slides: [1, 2, 10] }, await readFile(FIXTURE), { slidesIndex, lang: "zh" });
  assert.equal(without.report.videos, 0);
});

test("imageInfo：只讀檔頭就知道寬高、有沒有透明、拍照時的轉向", () => {
  assert.deepEqual(imageInfo(pngBytes(640, 360)), { type: "png", w: 640, h: 360, alpha: false, orientation: 1 });
  assert.equal(imageInfo(pngBytes(64, 64, 6)).alpha, true, "RGBA 的 PNG 有透明");
  // JPEG：APP1 的 EXIF 寫著轉向 6（轉了 90 度），SOF0 寫著 3000×2000
  const exif = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 8]), Buffer.from("Exif\0\0", "binary"), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0xd0, 0x0b, 0xb8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  assert.deepEqual(imageInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])])), { type: "jpeg", w: 3000, h: 2000, alpha: false, orientation: 6 });
  assert.equal(imageInfo(Buffer.from("not an image")), null);
});

test("產出的簡報照片不拉變形：比例不對的照片照原比例放回框裡（群組、背景、透明圖各有規則）", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 明確指示：「產出的 ppt 照片不要拉變形」。母簡報第 9 頁那張圖是 300×400（直的），框改成正方形＝被拉寬了
  const deck = await Deck.load(await readFile(FIXTURE));
  const slide = "ppt/slides/slide9.xml";
  const original = await deck.text(slide);
  const put = async (pic) => deck.set(slide, original.replace(/<p:pic>[\s\S]*?<\/p:pic>/, () => pic)); // 每一種情況都從原本那一頁開始
  const pic = (embed, x, y, cx, cy, extra = "") => `<p:pic><p:nvPicPr><p:cNvPr id="90" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/>${extra}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  const frame = async () => { const x = await deck.text(slide); const o = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(x.slice(x.indexOf('name="P"'))); return o.slice(1).map(Number); };

  // 一般的圖：照原比例縮進原本的框裡、置中（寬度縮成 0.75 倍、左右各留一半）
  await put(pic("rId2", 1000000, 1000000, 2000000, 2000000));
  assert.equal(await deck.fixPictureAspect(slide), 1);
  assert.deepEqual(await frame(), [1250000, 1000000, 1500000, 2000000]);
  assert.equal(await deck.fixPictureAspect(slide), 0, "改過一次就對了，再跑不會再動");

  // 作者自己的裁切照算：裁掉上下各 1/8（看得見的是 300×300），正方形的框就是對的
  await put(pic("rId2", 0, 0, 2000000, 2000000, '<a:srcRect t="12500" b="12500"/>'));
  assert.equal(await deck.fixPictureAspect(slide), 0);

  // 實際回報：照比例縮回去之後「上下都被截斷了」——母簡報裡那一張本來就被裁掉上下一大塊（看得見的只剩 300×200），
  // 被拉長到 3:4 的框裡時看不出來。原圖本身就是 3:4：拿掉裁切就剛好填滿原本的框，框不動
  await put(pic("rId2", 1000000, 1000000, 1500000, 2000000, '<a:srcRect t="25000" b="25000"/>'));
  assert.equal(await deck.fixPictureAspect(slide), 1);
  assert.deepEqual(await frame(), [1000000, 1000000, 1500000, 2000000], "原圖跟框同比例：框不動");
  assert.ok(!/<a:srcRect/.test(await deck.text(slide)), "裁切拿掉，整張照片都看得到");
  assert.equal(await deck.fixPictureAspect(slide), 0, "整張放回去之後就對了");

  // 原圖跟框也不同比例：一樣拿掉裁切，整張照原比例放進框裡、置中（正方形的框 → 寬度 0.75 倍）
  await put(pic("rId2", 1000000, 1000000, 2000000, 2000000, '<a:srcRect t="25000" b="25000"/>'));
  assert.equal(await deck.fixPictureAspect(slide), 1);
  assert.deepEqual(await frame(), [1250000, 1000000, 1500000, 2000000]);
  assert.ok(!/<a:srcRect/.test(await deck.text(slide)));

  // 群組裡的圖：群組橫向縮了一半（ext 是 chExt 的一半），子座標 2:1 的框實際是 1:1——還是被拉寬了
  await put(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="91" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr>${pic("rId2", 0, 0, 4000000, 2000000)}</p:grpSp>`);
  assert.equal(await deck.fixPictureAspect(slide), 1);
  assert.deepEqual(await frame(), [500000, 0, 3000000, 2000000], "子座標的寬照群組的縮放換算（實際 1500000 寬 ÷ 0.5）");

  // 鋪滿整頁的背景：照原比例裁掉多出來的邊（不留白），框不動
  const { cx: W, cy: H } = await deck.slideSize();
  await put(pic("rId2", 0, 0, W, H));
  assert.equal(await deck.fixPictureAspect(slide), 1);
  const bg = await deck.text(slide);
  assert.deepEqual(await frame(), [0, 0, W, H]);
  const crop = /<a:srcRect t="(\d+)" b="(\d+)"\/>/.exec(bg);
  assert.ok(crop && crop[1] === crop[2], `上下各裁一樣多：${/<a:srcRect[^>]*>/.exec(bg)?.[0]}`);
  const visible = (300 / (400 * (1 - 2 * Number(crop[1]) / 100000)));
  assert.ok(Math.abs(visible - W / H) < 0.01, `裁完的比例就是整頁的比例（${visible.toFixed(3)} vs ${(W / H).toFixed(3)}）`);

  // 背景要鋪滿，但先從作者裁掉的地方補回來：原圖跟整頁同比例、只是被裁掉上下各 1/3 → 補回來就是整張，不再裁
  assert.ok(Math.abs(W / H - 16 / 9) < 0.001, "合成母簡報是 16:9");
  deck.set("ppt/media/wide.png", pngBytes(1600, 900));
  const wide = await deck.addRel(slide, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", "../media/wide.png");
  await put(pic(wide, 0, 0, W, H, '<a:srcRect t="33333" b="33333"/>'));
  assert.equal(await deck.fixPictureAspect(slide), 1);
  assert.deepEqual(await frame(), [0, 0, W, H]);
  assert.ok(!/<a:srcRect/.test(await deck.text(slide)), `以前是在裁好的那一條裡面再裁，只剩中間一小塊：${/<a:srcRect[^>]*>/.exec(await deck.text(slide))?.[0]}`);

  // 有透明的圖（疊在照片上的漸層、圖示）本來就是拉伸著用的：不動
  deck.set("ppt/media/overlay.png", pngBytes(64, 64, 6));
  const rid = await deck.addRel(slide, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", "../media/overlay.png");
  await put(pic(rid, 0, 0, 6000000, 1000000));
  assert.equal(await deck.fixPictureAspect(slide), 0);

  // 填了照片的形狀（圓形的老師照片）：形狀不動，照片照比例裁到形狀的比例（直的 300×400 → 上下各裁 1/8）
  await put(`<p:sp><p:nvSpPr><p:cNvPr id="92" name="P"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="2000000" cy="2000000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`);
  assert.equal(await deck.fixPictureAspect(slide), 1);
  const shape = await deck.text(slide);
  assert.deepEqual(await frame(), [100, 200, 2000000, 2000000], "形狀的位置與大小不動");
  assert.ok(shape.includes('<a:srcRect t="12500" b="12500"/>'), /<a:blipFill[\s\S]*?<\/a:blipFill>/.exec(shape)?.[0]);

  // 作者在圓形裡框了臉（左右各裁 1/4、上 10%、下 50%，看得見的 150×160，放進正方形被拉寬了一點）：
  // 作者框的那一塊整個留著，只往左右補到正方形——不是在臉上再裁掉上下
  await put(`<p:sp><p:nvSpPr><p:cNvPr id="93" name="P"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="2000000" cy="2000000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:srcRect l="25000" t="10000" r="25000" b="50000"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`);
  assert.equal(await deck.fixPictureAspect(slide), 1);
  const face = await deck.text(slide);
  assert.ok(face.includes('<a:srcRect l="23333" t="10000" r="23333" b="50000"/>'), /<a:srcRect[^>]*>/.exec(face)?.[0]);
});

test("產檔時照片比例的更正會寫進報告", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const deck = await Deck.load(await readFile(FIXTURE));
  const slide = "ppt/slides/slide9.xml";
  // 第 9 頁那張直的圖（300×400）被拉成正方形
  deck.set(slide, (await deck.text(slide)).replace(/(<p:pic>[\s\S]*?<a:ext cx=")(\d+)(" cy=")(\d+)(")/, (_, a, cx, b, cy, c) => `${a}${cy}${b}${cy}${c}`));
  const { report } = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 9, 10], text_edits: [] }, await deck.save(), { slidesIndex, lang: "zh" });
  assert.equal(report.pictures_fixed, 1);
  assert.deepEqual(report.validation.errors, []);
  // 沒有被拉變形的那一份不會多一行
  const clean = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 9, 10], text_edits: [] }, await readFile(FIXTURE), { slidesIndex, lang: "zh" });
  assert.equal(clean.report.pictures_fixed, undefined);
});

/**
 * 母簡報封面那一塊的樣子（2026-09 版的母簡報）：單位與日期都是「English · 中文」寫在同一段，來賓是「Mr. 姓名　職稱」；
 * 標題上方另有一段只寫「歡迎蒞臨」。名字都是虛構的。三種行各給一個字級，才看得出新寫的每一行沿用哪一種行的格式。
 */
async function masterWithCover() {
  const deck = await Deck.load(await readFile(FIXTURE));
  const slide = "ppt/slides/slide1.xml";
  let xml = await deck.text(slide);
  const p = (text, sz, extra = "") => `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-TW" sz="${sz}"${extra} dirty="0"/><a:t>${text}</a:t></a:r></a:p>`;
  const box = p("Example Agency · 範例機構 範例課", 1600, ' b="1"') + p("Mr. Kim Oldguest　Team Leader, Example Planning", 1400) + p("Ms. Park Formervisit　Senior Researcher", 1400) + p("7 September 2026 · 2026 年 9 月 7 日", 1200);
  const sp = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((x) => x.includes("Visiting Organisation Name"));
  xml = xml.replace(sp, () => sp.replace(/(<p:txBody>[\s\S]*?)<a:p\b[\s\S]*<\/a:p>(<\/p:txBody>)/, (_, a, b) => a + box + b));
  deck.set(slide, xml.replace("歡迎蒞臨綠色健康研究中心", "歡迎蒞臨"));
  return deck.save();
}
const coverVisit = {
  ...spec, visit_id: "2026-10-05-uoe", date: "2026-10-05", slides: [1, 2, 3, 10], text_edits: [],
  org: { name: "University of Example", name_local: "範例大學", type: "university", country: "Australia" },
  // 主賓不一定排在名單第一個：封面上主賓排第一
  guests: [{ name: "Jordan Placeholder", title: "Research Fellow", role: "member", email: "" }, { name: "Dr. Alex Sample", title: "Senior Lecturer", role: "lead", email: "" }],
};
const runAttrs = (xml, text) => new RegExp(`<a:rPr([^>]*?)/?>(?:<a:ea[^>]*/></a:rPr>)?<a:t>${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a:t>`).exec(xml)?.[1] || "";

test("封面換成這一場的單位、來賓、日期：上一次的來賓一行都不留，每一行沿用母簡報那一種行的格式", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 明確指示：「首頁的部分應該要根據本次參訪者，更改首頁的內容，現在內容還是舊的」
  const master = await masterWithCover();
  const en = await buildDeck({ ...coverVisit, language: "en" }, master, { slidesIndex, lang: "en" });
  assert.deepEqual(en.report.cover, ["University of Example", "Dr. Alex Sample　Senior Lecturer", "Jordan Placeholder　Research Fellow", "5 October 2026"]);
  let deck = await Deck.load(en.pptx);
  let xml = await deck.text((await deck.slides())[0].path);
  const paras = await deck.paragraphs((await deck.slides())[0].path);
  assert.ok(!/Oldguest|Formervisit|Example Agency|September/.test(xml), `上一次的來賓不能留在封面上：${paras.join(" | ")}`);
  assert.ok(paras.includes("Welcome"), "英文版的「歡迎蒞臨」換成 Welcome（不然會整行被刪掉，封面就沒有歡迎的字）");
  assert.ok(!/<a:t>[^<]*\p{Script=Han}/u.test(xml), "英文版封面沒有中文");
  assert.match(runAttrs(xml, "University of Example"), /sz="1600" b="1"/, "單位那一行照母簡報單位那一行的格式");
  assert.match(runAttrs(xml, "Dr. Alex Sample　Senior Lecturer"), /sz="1400"/);
  assert.match(runAttrs(xml, "5 October 2026"), /sz="1200"/, "日期那一行照母簡報日期那一行的格式");

  // 中文版：單位與日期跟母簡報一樣是「English · 中文」
  const zh = await buildDeck({ ...coverVisit, language: "zh" }, master, { slidesIndex, lang: "zh" });
  assert.deepEqual(zh.report.cover, ["University of Example · 範例大學", "Dr. Alex Sample　Senior Lecturer", "Jordan Placeholder　Research Fellow", "5 October 2026 · 2026 年 10 月 5 日"]);
  deck = await Deck.load(zh.pptx);
  assert.ok((await deck.paragraphs((await deck.slides())[0].path)).includes("歡迎蒞臨"), "中文版的歡迎蒞臨照舊");

  // 韓文版：換完語言才寫（不會被拿去翻譯），韓文的行換成韓文字型（不然會掉成方框）
  const ko = await buildDeck({ ...coverVisit, language: "ko", guests: [{ name: "김가상", title: "교수", role: "lead", email: "" }] }, master, { slidesIndex, lang: "ko", translate });
  assert.deepEqual(ko.report.cover, ["University of Example · 範例大學", "김가상　교수", "5 October 2026 · 2026년 10월 5일"]);
  deck = await Deck.load(ko.pptx);
  xml = await deck.text((await deck.slides())[0].path);
  assert.match(xml, /<a:rPr lang="ko-KR" sz="1400" dirty="0"><a:ea typeface="Malgun Gothic"\/><\/a:rPr><a:t>김가상　교수<\/a:t>/);
  assert.ok(!xml.includes("[ko] University"), "新寫的行不會被拿去翻譯");
  assert.deepEqual(ko.report.validation.errors, []);
});

test("封面的字：主賓排第一，四位以上只寫前兩位＋「and N colleagues」，日期各語言的寫法", () => {
  const guests = ["A", "B", "C", "D", "E"].map((name, i) => ({ name, title: "T", role: i === 2 ? "lead" : "member" }));
  assert.deepEqual(coverLines({ org: { name: "Org" }, guests, date: "2026-10-05" }, "en"), { org: "Org", guests: ["C　T", "A　T", "and 3 colleagues"], date: "5 October 2026" });
  assert.deepEqual(coverLines({ org: { name: "Org", name_local: "단체" }, guests, date: "2026-01-09" }, "ko").guests[2], "and 3 colleagues · 외 3명");
  assert.equal(coverLines({ date: "2026-01-09" }, "ja").date, "9 January 2026 · 2026年1月9日");
  assert.equal(coverLines({ org: { name: "Org", name_local: "単体" } }, "en").org, "Org", "英文版只有英文");
  assert.equal(coverLines({ org: { name: "", name_local: "範例大學" } }, "en").org, "範例大學", "沒有英文名稱就寫當地的");
  assert.deepEqual(coverLines({ guests: [{ name: "A", title: "" }, { name: " ", title: "x" }] }, "zh").guests, ["A"], "沒有名字的不寫，沒有職稱就只寫名字");
  assert.equal(coverLines({ date: "" }, "zh").date, "");
});

test("封面找不到寫來賓的那一塊：報告說一聲，照樣產檔", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const deck = await Deck.load(await readFile(FIXTURE));
  const slide = "ppt/slides/slide1.xml";
  deck.set(slide, (await deck.text(slide)).replace("Guest Name, Title", "Making nature measurable").replace("來賓姓名 職稱", "讓自然可量測").replace("1 January 2026 · 2026年1月1日", "A tagline"));
  const { report } = await buildDeck({ ...coverVisit, language: "zh" }, await deck.save(), { slidesIndex, lang: "zh" });
  assert.equal(report.cover, undefined);
  assert.ok(report.warnings.some((w) => w.includes("封面找不到寫來賓的那一塊")), report.warnings.join(" | "));
  assert.deepEqual(report.validation.errors, []);
});

/** 目錄頁上每一張卡片（底、圓圈、文字框）的位置與文字。 */
async function contentsCardsOf(deck, slidePath) {
  const xml = await deck.text(slidePath);
  return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).map((sp) => ({ off: /<a:off x="(\d+)" y="(\d+)"/.exec(sp)?.slice(1).map(Number), text: [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join("|") }));
}

test("目錄頁只留這一份講到的章節，留下來的卡片往前補位；「09 提問回覆」那一句也拿掉", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 明確指示：「第 3 頁目錄跟著選頁改」——目錄還寫著上一次韓國團的「對六項提問的回覆」「09 Responses to Your Questions」
  const master = await readFile(FIXTURE);
  const before = await contentsCardsOf(await Deck.load(master), "ppt/slides/slide3.xml");
  const at = (cards, text) => cards.find((c) => c.text === text)?.off;
  // 第 6 頁是第 01 章的分隔頁（「01」下一行就是目錄上的「Why Now」），第 9 頁的頁眉是「03 · FOUR LABORATORIES」
  const { pptx, report } = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 3, 6, 9, 10], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.deepEqual(report.contents, { all: ["01", "02", "03", "04", "08", "09"], kept: ["01", "03"] });
  const deck = await Deck.load(pptx);
  const after = await contentsCardsOf(deck, (await deck.slides())[2].path);
  const words = after.map((c) => c.text).join(" ");
  assert.ok(!/Core Proposition|Research Outcomes|The Next Three Years|Responses to Your Questions|提問回覆/.test(words), words);
  assert.deepEqual(at(after, "Why Now|為什麼是現在"), at(before, "Why Now|為什麼是現在"), "01 留在第一個位置");
  assert.deepEqual(at(after, "Four Laboratories|四間研究室"), at(before, "Core Proposition|核心主張"), "03 搬到原本 02 的位置，不留空洞");
  assert.deepEqual(at(after, "03"), at(before, "02"), "圓圈跟著整張卡片一起搬");
  assert.ok(after.some((c) => c.text === "要解決什麼問題、用什麼解決、未來三年"), "副標題裡「以及對六項提問的回覆」拿掉");
  assert.deepEqual(report.validation.errors, []);

  // 組織架構那一頁的頁眉誤標成「08 · THE NEXT THREE YEARS」：不能因為它就把 08 留在目錄上
  const org = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 3, 5, 9, 10], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.deepEqual(org.report.contents.kept, ["03"]);

  // 選到的頁看不出屬於哪一章：目錄照母簡報，報告說一聲
  const bare = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 3, 10], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.equal(bare.report.contents, undefined);
  assert.ok(bare.report.warnings.some((w) => w.includes("目錄頁照母簡報")), bare.report.warnings.join(" | "));

  // 目錄不在索引寫的那一頁（站台上的母簡報就是：目錄在第 2 頁）也認得出來
  const moved = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 3, 6, 9, 10], text_edits: [] }, master, { slidesIndex: { slides: [{ n: 1, role: "cover" }, { n: 2, role: "contents" }] }, lang: "zh" });
  assert.deepEqual(moved.report.contents.kept, ["01", "03"]);
});

test("目錄頁的卡片是一張一個群組、或沒有底的排法也認得；認不出來就不動", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const xfrm = (x, y, cx, cy) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const sp = (id, x, y, cx, cy, ...paras) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, cx, cy)}</p:spPr><p:txBody><a:bodyPr/>${(paras.length ? paras : [""]).map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  const page = (body) => `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
  const zipOf = async (xml) => {
    const base = await Deck.load(await readFile(FIXTURE));
    base.set("ppt/slides/slide3.xml", xml);
    return base;
  };
  // 一張卡片一個群組（底、圓圈、文字都在群組裡），三張排成一欄
  const card = (i, no, en) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${10 + i}" name="G${i}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(0, i * 1000000, 5000000, 900000).replace("</a:xfrm>", '<a:chOff x="0" y="0"/><a:chExt cx="5000000" cy="900000"/></a:xfrm>')}</p:grpSpPr>${sp(100 + i, 0, 0, 5000000, 900000)}${sp(200 + i, 100000, 200000, 400000, 400000, no)}${sp(300 + i, 700000, 100000, 4000000, 700000, en)}</p:grpSp>`;
  let d = await zipOf(page(sp(2, 0, 0, 9000000, 500000, "CONTENTS · 簡報架構") + card(0, "01", "Why Now") + card(1, "02", "Core Proposition") + card(2, "03", "Five Laboratories")));
  assert.deepEqual(await d.contentsItems("ppt/slides/slide3.xml"), [{ no: "01", title: "Why Now" }, { no: "02", title: "Core Proposition" }, { no: "03", title: "Five Laboratories" }]);
  assert.deepEqual(await d.keepContents("ppt/slides/slide3.xml", new Set(["03"])), { all: ["01", "02", "03"], kept: ["03"] });
  let xml = await d.text("ppt/slides/slide3.xml");
  assert.ok(!/Why Now|Core Proposition/.test(xml));
  assert.match(xml, /name="G2"\/>[\s\S]*?<p:grpSpPr><a:xfrm><a:off x="0" y="0"\/>/, "03 那一整個群組搬到第一個位置");

  // 沒有底：圓圈右邊、同一列的文字就是那一章的標題（兩欄）
  d = await zipOf(page(sp(2, 0, 0, 9000000, 500000, "Contents") + sp(3, 0, 1000000, 400000, 400000, "01") + sp(4, 600000, 1000000, 3000000, 400000, "Why Now") + sp(5, 5000000, 1000000, 400000, 400000, "02") + sp(6, 5600000, 1000000, 3000000, 400000, "Core Proposition")));
  assert.deepEqual(await d.keepContents("ppt/slides/slide3.xml", new Set(["02"])), { all: ["01", "02"], kept: ["02"] });
  xml = await d.text("ppt/slides/slide3.xml");
  assert.match(xml, /<a:off x="0" y="1000000"\/>[\s\S]*?<a:t>02<\/a:t>/);
  assert.match(xml, /<a:off x="600000" y="1000000"\/>[\s\S]*?<a:t>Core Proposition<\/a:t>/);

  // 沒有底、章節號底下墊一個圓圈（沒有字的形狀）：圓圈跟著章節號一起搬，拿掉的那一章圓圈也一起拿掉
  d = await zipOf(page(sp(2, 0, 0, 9000000, 500000, "Contents") + sp(7, 0, 1000000, 500000, 500000) + sp(3, 50000, 1050000, 400000, 400000, "01") + sp(4, 700000, 1050000, 3000000, 400000, "Why Now") + sp(8, 5000000, 1000000, 500000, 500000) + sp(5, 5050000, 1050000, 400000, 400000, "02") + sp(6, 5700000, 1050000, 3000000, 400000, "Core Proposition")));
  assert.deepEqual(await d.keepContents("ppt/slides/slide3.xml", new Set(["02"])), { all: ["01", "02"], kept: ["02"] });
  xml = await d.text("ppt/slides/slide3.xml");
  assert.ok(!/name="S7"/.test(xml), "01 的圓圈一起拿掉");
  assert.match(xml, /name="S8"\/>[\s\S]*?<a:off x="0" y="1000000"\/>/, "02 的圓圈搬到第一個位置");

  // 一個文字框寫了好幾個章節號：認不出來，不動
  d = await zipOf(page(sp(2, 0, 0, 9000000, 500000, "Contents") + sp(3, 0, 1000000, 4000000, 3000000, "01", "Why Now", "02", "Core Proposition")));
  assert.equal(await d.keepContents("ppt/slides/slide3.xml", new Set(["02"])), null);
});

test("產出的簡報不帶母簡報的講稿（寫給上一次來賓的），母簡報本身不動", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 明確指示：「講稿：產檔時拿掉」。母簡報第 2 頁、第 7 頁有講稿
  const master = await readFile(FIXTURE);
  assert.ok((await Deck.load(master)).files().some((f) => /notesSlide\d+\.xml$/.test(f)));
  const { pptx, report } = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 7, 10], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  const deck = await Deck.load(pptx);
  assert.equal(report.notes_removed, 2);
  assert.ok(!deck.files().some((f) => /notesSlide/.test(f)), deck.files().filter((f) => /notes/.test(f)).join(", "));
  for (const s of await deck.slides()) assert.ok(!(await deck.rels(s.path)).some((r) => /notesSlide$/.test(r.type)), `${s.path} 還連著講稿`);
  assert.deepEqual(report.validation.errors, []);
});

test("母簡報各頁頁眉寫的「FOUR LABORATORIES」也更正成五間", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  const { pptx, report } = await buildDeck({ ...spec, language: "zh", slides: [1, 2, 9, 10], text_edits: [] }, await readFile(FIXTURE), { slidesIndex, masterFixes, lang: "zh" });
  const text = (await (await Deck.load(pptx)).paragraphs("ppt/slides/slide9.xml")).join(" ");
  assert.ok(text.includes("03 · FIVE LABORATORIES") && !text.includes("FOUR"), text);
  assert.ok(report.fixes.some((f) => f.find === "FOUR LABORATORIES"));
});

test("照內容認一頁屬於哪一區：頁眉、標題、分隔頁（站台上那一份母簡報的寫法）", () => {
  // 字是從產出的簡報裡抄來的（2026-09 的母簡報）
  const cases = [
    [["08 · THE NEXT THREE YEARS · 未來三年", "Organisation", "組織架構"], "org"],
    [["01", "Why Now", "為什麼是現在"], "ch01"],
    [["01 · WHY NOW · 2024.04.10", "Opening Ceremony and International Forum"], "ch01"],
    [["02 · CORE PROPOSITION · 核心主張", "Five Laboratories, One Closed Evidence Loop", "01", "Measure"], "ch02"],
    [["03", "Five Laboratories"], "lab301"],
    [["03 · FOUR LABORATORIES · 01 MEASURE · 方法論", "A Landscape-Planning Journey in Seven Stations"], "lab301"],
    [["03 · FOUR LABORATORIES · 01 MEASURE · 量測", "HealthCloud — An In-house Platform Built at Lab 301"], "lab301"],
    [["03 · FOUR LABORATORIES · 02 DESIGN · 設計", "Lab 302 — Facility"], "lab302"],
    [["03 · FOUR LABORATORIES · 03 VALIDATE · 驗證", "360 VR for Public Environmental Education"], "lab303"],
    [["04 · RESEARCH OUTCOMES · PATIENT CARE · 病患照護", "When the Patient Cannot Reach the Forest"], "lab303"],
    [["04 · RESEARCH OUTCOMES · FIELD IMPLEMENTATION · 場域落地", "Four Community Models"], "lab303"],
    [["03 · FOUR LABORATORIES · 04 PRESCRIBE · 處方", "Lab 304 — Panoramic Cinema Lab"], "lab304"],
    [["04 · RESEARCH OUTCOMES · FLAGSHIP STUDY · 旗艦案例", "Film — Slow Jogging in an Immersive CAVE"], "lab304"],
    [["03 · FOUR LABORATORIES · 03 VALIDATE · 驗證", "Lab 305 — Landscape and Place: Selected IVR Studies"], "lab305"],
    [["03 · FOUR LABORATORIES · 03 VALIDATE · 驗證 · IVR STUDY 02", "Spatial Perception — Crowding: Findings"], "lab305"],
    [["05", "Talent and Education"], "ch05"],
    [["04 · RESEARCH OUTCOMES · COMMISSIONED RESEARCH · 委託研究", "Commissioned Research Projects"], "commis"],
    [["06 · INTERNATIONAL PLATFORM · 國際平台", "Signed and Established Partnerships"], "ch06"],
    [["07 · EXTERNAL RECOGNITION · 成果認證", "The Numbers Behind the Award"], "ch07"],
    [["08 · THE NEXT THREE YEARS · 未來三年", "Three Commitments", "01", "Institutionalise services"], "ch08"],
    [["謝謝", "Thank you", "Green Health Research Center"], "closing"],
    [["CONTENTS · 簡報架構", "What This Deck Answers", "01", "Why Now"], "front"],
  ];
  for (const [paras, block] of cases) assert.equal(slideBlock(paras)?.block, block, paras.join(" / "));
  // 「04 · RESEARCH OUTCOMES · 研究成果」沒寫是哪一類：歸到前一頁那一區（它緊跟在旗艦案例後面）
  assert.equal(slideBlock(["04 · RESEARCH OUTCOMES · 研究成果", "Research Projects, Grouped by Target Population"]), null);
  assert.equal(slideBlock(["Programme for Today", "今日流程"], { table: true }).role, "programme");
  assert.equal(slideBlock(["Programme for Today"], { table: false }), null, "沒有表格就不是今日流程那一頁");
  assert.equal(slideBlock(["anything"], { first: true }).role, "cover");
});

/**
 * 跟站台上那一份母簡報同樣的排法：封面、目錄、組織架構、各章……沒有今日流程與核心宣稱那兩頁，
 * 研究成果夾在研究室中間、委託研究在 05 的分隔頁後面（索引寫的頁次全部對不上）。名字都是虛構的。
 */
async function siteLikeMaster() {
  const deck = await Deck.load(await readFile(FIXTURE));
  const page = (paras) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9000000" cy="5000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paras.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const make = async (...paras) => { const p = await deck.cloneSlide("ppt/slides/slide4.xml"); deck.set(p, page(paras)); return p; };
  const order = [
    "ppt/slides/slide1.xml", "ppt/slides/slide3.xml", "ppt/slides/slide5.xml",
    await make("01", "Why Now", "為什麼是現在"), await make("01 · WHY NOW · 為什麼是現在", "Three Policy Currents"),
    await make("02 · CORE PROPOSITION · 核心主張", "Facilities and Funding Sources"),
    await make("03", "Five Laboratories"), await make("03 · FOUR LABORATORIES · 01 MEASURE · 量測", "Lab 301 — Health Landscape Intelligence Lab"),
    await make("03 · FOUR LABORATORIES · 02 DESIGN · 設計", "Lab 302 — Facility"), await make("03 · FOUR LABORATORIES · 02 DESIGN · 設計", "Lab 302 — Simulation Outputs"),
    await make("03 · FOUR LABORATORIES · 03 VALIDATE · 驗證", "Lab 303 — Facility"), await make("04 · RESEARCH OUTCOMES · PATIENT CARE · 病患照護", "When the Patient Cannot Reach the Forest"),
    await make("03 · FOUR LABORATORIES · 04 PRESCRIBE · 處方", "Lab 304 — Facility"), await make("04 · RESEARCH OUTCOMES · FLAGSHIP STUDY · 旗艦案例", "Slow Jogging"),
    await make("04 · RESEARCH OUTCOMES · 研究成果", "Research Projects, Grouped by Target Population"),
    await make("03 · FOUR LABORATORIES · 03 VALIDATE · 驗證 · IVR STUDY 01", "Travel Behavior — Virtual Tour"),
    await make("05", "Talent and Education"), await make("04 · RESEARCH OUTCOMES · COMMISSIONED RESEARCH · 委託研究", "Commissioned Research Projects"),
    await make("05 · TALENT AND EDUCATION · 人才與教育", "Curriculum and Teaching"),
    await make("08 · THE NEXT THREE YEARS · 未來三年", "Three Commitments", "01", "Institutionalise services"),
    "ppt/slides/slide10.xml",
  ];
  await deck.setSlideOrder(order);
  await deck.clean();
  return deck.save();
}

test("照內容對頁：母簡報的頁序跟索引對不上，勾的那幾區照樣拿到那幾區的頁；組織架構、謝謝也照內容找", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // 明確指示：「照內容自動對頁」。實際踩過：站台上的母簡報目錄在第 2 頁、沒有今日流程那一頁，
  // 勾「302」拿到的不是 302 的頁，「您最想看哪一部分」複製到的是政策線那一頁
  const slidesIndex = JSON.parse(await readFile("public/data/slides.json", "utf8"));
  const pick = (...ids) => slidesIndex.groups.filter((g) => g.required || ids.includes(g.id)).flatMap((g) => g.slides);
  const master = await siteLikeMaster();
  const titles = async (pptx) => { const d = await Deck.load(pptx); const out = []; for (const s of await d.slides()) out.push((await d.paragraphs(s.path)).slice(0, 2).join(" / ")); return out; };

  const a = await buildDeck({ ...spec, language: "zh", slides: pick("lab302", "commis"), text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.equal(a.report.matched, "content");
  const got = await titles(a.pptx);
  assert.ok(got[0].startsWith("Welcome") && got[1].startsWith("Contents"), `封面、目錄在最前面：${got.join(" | ")}`);
  assert.deepEqual(got.filter((t) => /Lab 30\d|Commissioned/.test(t)).map((t) => t.split(" / ")[1] || t), ["Lab 302 — Facility", "Lab 302 — Simulation Outputs", "Commissioned Research Projects"], got.join(" | "));
  assert.ok(got.some((t) => t.startsWith("Thank you")), "謝謝那一頁照內容找到（索引寫第 72 頁）");
  assert.ok(got.some((t) => t.startsWith("Which part would you most like to see? / 您最想看哪一部分？")), `「您最想看哪一部分」從組織架構那一頁複製：${got.join(" | ")}`);
  assert.ok(!got.some((t) => /Three Policy Currents/.test(t)), "不是政策線那一頁");
  assert.equal(a.report.programme_table, "missing", "母簡報沒有今日流程那一頁：報告說一聲，不去填目錄頁");
  assert.deepEqual(a.report.validation.errors, []);

  // 304 那一區：研究室的頁＋旗艦案例＋沒寫類別的「研究成果」（跟在旗艦案例後面）
  const b = await buildDeck({ ...spec, language: "zh", slides: pick("lab304"), programme: [], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.deepEqual((await titles(b.pptx)).filter((t) => /304|Slow Jogging|Grouped/.test(t)).map((t) => t.split(" / ")[1]), ["Lab 304 — Facility", "Slow Jogging", "Research Projects, Grouped by Target Population"]);

  // 母簡報裡沒有的那一區：說一聲
  const c = await buildDeck({ ...spec, language: "zh", slides: pick("ch07"), programme: [], text_edits: [] }, master, { slidesIndex, lang: "zh" });
  assert.ok(c.report.warnings.some((w) => /那一區在母簡報裡找不到/.test(w)), c.report.warnings.join(" | "));
});

test("瘦身：縮完的圖換副檔名時不能蓋掉另一張同名的圖；縮完比例不對就維持原檔", { skip: !available && "fixture unavailable (python-pptx)" }, async () => {
  // image3.png（4000×3000，大圖）縮完要變 image3.jpeg——但 image3.jpeg 已經是第 9 頁的另一張圖。
  // 以前直接覆寫：第 9 頁就顯示成 image3.png 那張，還被拉成第 9 頁那個框的比例（照片變形的來源之一）
  const deck = await Deck.load(await readFile(FIXTURE));
  const other = pngBytes(300, 400);
  deck.set("ppt/media/image3.jpeg", other);
  await deck.ensureDefault("jpeg", "image/jpeg");
  deck.set("ppt/slides/_rels/slide9.xml.rels", (await deck.text("ppt/slides/_rels/slide9.xml.rels")).replace("../media/image1.png", "../media/image3.jpeg"));
  const { pptx, report } = await slimDeck(await deck.save(), { resizeImage: async () => ({ bytes: new Uint8Array(pngBytes(400, 300)), ext: "jpeg" }) });
  assert.equal(report.images_resized, 1);
  const out = await Deck.load(pptx);
  assert.deepEqual([...(await out.bytes("ppt/media/image3.jpeg"))].slice(0, 32), [...other].slice(0, 32), "第 9 頁那張原封不動");
  assert.ok((await out.rels("ppt/slides/slide9.xml")).some((r) => r.part === "ppt/media/image3.jpeg"));
  const rel8 = (await out.rels("ppt/slides/slide8.xml")).find((r) => /image3/.test(r.target));
  assert.equal(rel8.part, "ppt/media/image3-2.jpeg", "縮完的那張換一個沒人用的名字");
  assert.equal(imageInfo(await out.bytes(rel8.part)).w, 400);
  assert.deepEqual((await out.validate()).errors, []);

  // 縮完比例不對（瀏覽器解大圖時偷偷縮了一邊之類）：維持原檔、報告說一聲
  const bad = await slimDeck(await readFile(FIXTURE), { resizeImage: async () => ({ bytes: new Uint8Array(pngBytes(400, 400)), ext: "jpeg" }) });
  assert.equal(bad.report.images_resized, 0);
  assert.ok(bad.report.warnings.some((w) => /比例不對/.test(w)), bad.report.warnings.join("；"));
  assert.ok((await Deck.load(bad.pptx)).files().includes("ppt/media/image3.png"));
});
