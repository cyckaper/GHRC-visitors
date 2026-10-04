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
import { Deck, slimDeck, hasEmbeddedMedia, imageInfo } from "../cli/lib/pptx.mjs";
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
  assert.equal(files.filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).length, 1, "only the kept slide's notes remain");
  const slides = await deck.slides();
  assert.equal(slides.length, 8);
  const cover = await deck.paragraphs(slides[0].path);
  assert.ok(cover.some((p) => p.includes("University of Western Australia")));
  assert.ok(cover.some((p) => p.includes("Simon Kilbane")));
  const prog = await deck.paragraphs(slides[1].path);
  assert.ok(prog.includes("10:00 – 10:20") && prog.includes("센터 개요") && prog.includes("11:20 – 11:30"), "table filled with 4 rows");
  assert.ok(!prog.includes("研究室參訪 301–305"), "old table rows gone");
  const xml3 = await deck.text(slides[2].path);
  assert.ok(/\[ko\] 為什麼是現在/.test(xml3), "Chinese run replaced by translation");
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
