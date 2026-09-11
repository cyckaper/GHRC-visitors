#!/usr/bin/env python3
"""slim-master：把 396 MB 的母簡報瘦身成 < 30 MB 的 slim master（CLAUDE.md「動工前必讀」）。

  python3 scripts/slim-master.py "GHRC 介紹簡報2026-9.pptx" --out public/assets/master/slim-master.pptx \
      --video-link 19=https://youtu.be/xxxx --video-link 35=https://drive.google.com/…

做的事：
  1. 抽掉內嵌影片／音訊：保留海報影格當靜態圖，加一行「▶ Video」文字（有給連結就變成可點的超連結），刪掉 media 檔
  2. 超過門檻（預設 3 MB）或長邊超過 2000px 的點陣圖 → 縮到長邊 2000px；不透明的轉 JPEG（品質 85），有透明的留 PNG
  3. 清掉沒有被任何 rels 引用的 media
  4. 重新壓縮，列出前後大小與最大的檔案；超過 --target-mb 會警告
原始母檔不動；請把它留在 Drive 當備份，repo 只放 slim master。
"""
import argparse
import io
import os
import posixpath
import re
import shutil
import sys
import tempfile
import zipfile
from xml.dom import minidom

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(2)

VIDEO_EXT = {".mp4", ".m4v", ".mov", ".avi", ".wmv", ".mpg", ".mpeg", ".webm", ".mkv", ".asf", ".m4a", ".mp3", ".wav", ".wma", ".aac"}
RASTER_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif"}
REL_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
EMU_PER_INCH = 914400


def safe_extract(zf, dest):
    for m in zf.infolist():
        target = os.path.realpath(os.path.join(dest, m.filename))
        if not target.startswith(os.path.realpath(dest) + os.sep):
            raise RuntimeError(f"zip 裡有可疑路徑：{m.filename}")
    zf.extractall(dest)


def resolve(from_part, target):
    if target.startswith("/"):
        return target[1:]
    return posixpath.normpath(posixpath.join(posixpath.dirname(from_part), target))


def rels_path(part):
    d, n = posixpath.split(part)
    return posixpath.join(d, "_rels", n + ".rels")


def read(root, part):
    with open(os.path.join(root, part), encoding="utf-8") as f:
        return f.read()


def write(root, part, text):
    with open(os.path.join(root, part), "w", encoding="utf-8") as f:
        f.write(text)


def all_parts(root):
    out = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            out.append(posixpath.join(*os.path.relpath(os.path.join(dp, fn), root).split(os.sep)))
    return out


def slide_order(root):
    """依 sldIdLst 順序回傳投影片 part 名稱。"""
    pres = read(root, "ppt/presentation.xml")
    rels = minidom.parse(os.path.join(root, rels_path("ppt/presentation.xml")))
    by_id = {r.getAttribute("Id"): resolve("ppt/presentation.xml", r.getAttribute("Target")) for r in rels.getElementsByTagName("Relationship")}
    return [by_id[m.group(1)] for m in re.finditer(r'<p:sldId\b[^>]*\br:id="([^"]+)"', pres) if m.group(1) in by_id]


def next_rid(rels_dom):
    ids = [int(m) for r in rels_dom.getElementsByTagName("Relationship") for m in re.findall(r"\d+", r.getAttribute("Id"))]
    return f"rId{(max(ids) if ids else 0) + 1}"


def next_shape_id(xml):
    ids = [int(x) for x in re.findall(r'<p:cNvPr\b[^>]*\bid="(\d+)"', xml)]
    return (max(ids) if ids else 1) + 1


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def strip_media_from_slide(root, slide, link, report):
    """把該頁的影片／音訊物件改成靜態海報圖 ＋ 一行文字；回傳被移除的 media part。"""
    rp = rels_path(slide)
    if not os.path.exists(os.path.join(root, rp)):
        return []
    dom = minidom.parse(os.path.join(root, rp))
    removed = []
    media_rids = {}
    for r in list(dom.getElementsByTagName("Relationship")):
        target = r.getAttribute("Target")
        ext = posixpath.splitext(target)[1].lower()
        typ = r.getAttribute("Type").rsplit("/", 1)[-1]
        if r.getAttribute("TargetMode") == "External":
            if typ in ("video", "audio", "media"):
                media_rids[r.getAttribute("Id")] = None
                r.parentNode.removeChild(r)
            continue
        if typ in ("video", "audio", "media") or ext in VIDEO_EXT:
            media_rids[r.getAttribute("Id")] = resolve(slide, target)
            r.parentNode.removeChild(r)
    if not media_rids:
        return []
    xml = read(root, slide)
    pics = re.findall(r"<p:pic>[\s\S]*?</p:pic>", xml)
    label_boxes = []
    for pic in pics:
        if not re.search(r"<a:videoFile\b|<a:audioFile\b|p14:media\b|ppaction://media", pic):
            continue
        new = re.sub(r"<a:videoFile\b[^>]*/>|<a:audioFile\b[^>]*/>|<a:quickTimeFile\b[^>]*/>", "", pic)
        new = re.sub(r"<p:extLst>(?:(?!</p:extLst>)[\s\S])*p14:media(?:(?!</p:extLst>)[\s\S])*</p:extLst>", "", new)
        new = re.sub(r"<a:hlinkClick\b[^>]*ppaction://media[^>]*/>", "", new)
        xml = xml.replace(pic, new)
        m = re.search(r'<a:off x="(\d+)" y="(\d+)"/><a:ext cx="(\d+)" cy="(\d+)"/>', new)
        if m:
            x, y, cx, cy = (int(v) for v in m.groups())
            label_boxes.append((x, y + cy + int(EMU_PER_INCH * 0.08), cx, int(EMU_PER_INCH * 0.45)))
    # 移除自動播放的 timing（只針對含媒體節點的）
    xml = re.sub(r"<p:timing>(?:(?!</p:timing>)[\s\S])*(?:<p:video\b|<p:audio\b|p14:media)(?:(?!</p:timing>)[\s\S])*</p:timing>", "", xml)
    # 加文字：有連結就做成超連結
    for (x, y, cx, cy) in label_boxes:
        sid = next_shape_id(xml)
        if link:
            rid = next_rid(dom)
            rel = dom.createElement("Relationship")
            rel.setAttribute("Id", rid)
            rel.setAttribute("Type", REL_HYPERLINK)
            rel.setAttribute("Target", link)
            rel.setAttribute("TargetMode", "External")
            dom.documentElement.appendChild(rel)
            text = f"▶ Video · 影片：{link}"
            rpr = f'<a:rPr lang="en-US" sz="1400" dirty="0"><a:hlinkClick r:id="{rid}"/></a:rPr>'
        else:
            text = "▶ Video · 影片（另附連結）"
            rpr = '<a:rPr lang="en-US" sz="1400" dirty="0"/>'
        sp = (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="Video link {sid}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
              f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
              f'<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p><a:r>{rpr}<a:t>{esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>')
        xml = xml.replace("</p:spTree>", sp + "</p:spTree>", 1)
    write(root, slide, xml)
    with open(os.path.join(root, rp), "w", encoding="utf-8") as f:
        dom.writexml(f, encoding="UTF-8")
    for rid, part in media_rids.items():
        if part:
            removed.append(part)
    report.append(f"  {slide}: 移除 {len(media_rids)} 個媒體物件" + (f"，連結 {link}" if link else ""))
    return removed


def referenced_targets(root):
    """所有 rels 指到的內部 part → 引用它的 rels 檔清單。"""
    refs = {}
    for part in all_parts(root):
        if not part.endswith(".rels"):
            continue
        owner = re.sub(r"_rels/([^/]+)\.rels$", r"\1", part)
        if owner == "_rels/.rels" or part == "_rels/.rels":
            owner = ""
        dom = minidom.parse(os.path.join(root, part))
        for r in dom.getElementsByTagName("Relationship"):
            if r.getAttribute("TargetMode") == "External":
                continue
            refs.setdefault(resolve(owner, r.getAttribute("Target")) if owner else r.getAttribute("Target").lstrip("/"), []).append(part)
    return refs


def retarget(root, old_part, new_part):
    """把所有指到 old_part 的 rels 改成 new_part。"""
    old_name = posixpath.basename(old_part)
    new_name = posixpath.basename(new_part)
    for part in all_parts(root):
        if not part.endswith(".rels"):
            continue
        text = read(root, part)
        if old_name not in text:
            continue
        new_text = re.sub(r'(Target="[^"]*?)' + re.escape(old_name) + '"', lambda m: m.group(1) + new_name + '"', text)
        if new_text != text:
            write(root, part, new_text)


def ensure_default(root, ext, content_type):
    ct = read(root, "[Content_Types].xml")
    if re.search(r'<Default\b[^>]*Extension="' + re.escape(ext) + '"', ct, flags=re.I):
        return
    write(root, "[Content_Types].xml", ct.replace("<Default", f'<Default Extension="{ext}" ContentType="{content_type}"/><Default', 1))


def shrink_images(root, threshold, max_edge, quality, all_images, report):
    media_dir = os.path.join(root, "ppt", "media")
    if not os.path.isdir(media_dir):
        return
    saved = 0
    for fn in sorted(os.listdir(media_dir)):
        ext = posixpath.splitext(fn)[1].lower()
        if ext not in RASTER_EXT:
            continue
        p = os.path.join(media_dir, fn)
        size = os.path.getsize(p)
        try:
            img = Image.open(p)
            img.load()
        except Exception as e:  # noqa: BLE001
            report.append(f"  略過無法讀取的圖片 {fn}: {e}")
            continue
        w, h = img.size
        needs = size > threshold or (all_images and max(w, h) > max_edge)
        if not needs:
            continue
        has_alpha = img.mode in ("RGBA", "LA", "P") and (img.mode != "P" or "transparency" in img.info)
        if has_alpha and img.mode == "P":
            img = img.convert("RGBA")
        if has_alpha and img.mode == "RGBA":
            alpha = img.getchannel("A")
            has_alpha = alpha.getextrema()[0] < 255
        scale = min(1.0, max_edge / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        if has_alpha:
            img.save(buf, format="PNG", optimize=True)
            new_fn = posixpath.splitext(fn)[0] + ".png"
        else:
            img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
            new_fn = posixpath.splitext(fn)[0] + ".jpeg"
        data = buf.getvalue()
        if len(data) >= size:
            report.append(f"  {fn}: 壓不小（{size/1e6:.1f} MB → {len(data)/1e6:.1f} MB），維持原檔")
            continue
        with open(os.path.join(media_dir, new_fn), "wb") as f:
            f.write(data)
        if new_fn != fn:
            os.remove(p)
            retarget(root, f"ppt/media/{fn}", f"ppt/media/{new_fn}")
            ensure_default(root, "jpeg", "image/jpeg") if new_fn.endswith(".jpeg") else ensure_default(root, "png", "image/png")
        saved += size - len(data)
        report.append(f"  {fn} → {new_fn}: {w}×{h} {size/1e6:.1f} MB → {img.size[0]}×{img.size[1]} {len(data)/1e6:.1f} MB")
    report.append(f"  圖片共省下 {saved/1e6:.1f} MB")


def remove_unreferenced_media(root, report):
    refs = referenced_targets(root)
    removed = 0
    freed = 0
    media_dir = os.path.join(root, "ppt", "media")
    if os.path.isdir(media_dir):
        for fn in os.listdir(media_dir):
            part = f"ppt/media/{fn}"
            if part not in refs:
                freed += os.path.getsize(os.path.join(media_dir, fn))
                os.remove(os.path.join(media_dir, fn))
                removed += 1
    report.append(f"  刪除未被引用的 media {removed} 個（{freed/1e6:.1f} MB）")


def validate(root):
    problems = []
    parts = set(all_parts(root))
    for part, owners in referenced_targets(root).items():
        if part not in parts:
            problems.append(f"{owners[0]} 指到不存在的 {part}")
    for part in parts:
        if part.endswith((".xml", ".rels")):
            try:
                minidom.parse(os.path.join(root, part))
            except Exception as e:  # noqa: BLE001
                problems.append(f"XML 壞掉 {part}: {e}")
    return problems


def rezip(root, out):
    parts = all_parts(root)
    parts.sort(key=lambda p: (p != "[Content_Types].xml", p))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in parts:
            z.write(os.path.join(root, p), p)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--out", default="public/assets/master/slim-master.pptx")
    ap.add_argument("--max-edge", type=int, default=2000)
    ap.add_argument("--jpeg-quality", type=int, default=85)
    ap.add_argument("--image-threshold", type=int, default=3_000_000, help="超過幾 bytes 的圖片才處理")
    ap.add_argument("--all-images", action="store_true", help="長邊超過 --max-edge 的圖片一律縮，不看門檻")
    ap.add_argument("--video-link", action="append", default=[], metavar="N=URL", help="第 N 頁（依頁序）的影片連結")
    ap.add_argument("--keep-video", action="store_true", help="不抽影片（只縮圖）")
    ap.add_argument("--target-mb", type=float, default=30)
    args = ap.parse_args()

    links = {}
    for item in args.video_link:
        n, _, url = item.partition("=")
        links[int(n)] = url
    before = os.path.getsize(args.src)
    report = [f"來源 {args.src}：{before/1e6:.1f} MB"]
    tmp = tempfile.mkdtemp(prefix="slim-")
    try:
        with zipfile.ZipFile(args.src) as z:
            safe_extract(z, tmp)
        slides = slide_order(tmp)
        if not args.keep_video:
            report.append("影片／音訊：")
            removed = []
            for i, slide in enumerate(slides, start=1):
                removed += strip_media_from_slide(tmp, slide, links.get(i), report)
            if not removed:
                report.append("  沒有內嵌媒體")
        report.append("圖片：")
        shrink_images(tmp, args.image_threshold, args.max_edge, args.jpeg_quality, args.all_images, report)
        report.append("清理：")
        remove_unreferenced_media(tmp, report)
        problems = validate(tmp)
        if problems:
            print("\n".join(report))
            print("✘ 驗證失敗：\n  " + "\n  ".join(problems), file=sys.stderr)
            sys.exit(1)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        rezip(tmp, args.out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    after = os.path.getsize(args.out)
    report.append(f"輸出 {args.out}：{after/1e6:.1f} MB（{100*after/before:.0f}%）")
    with zipfile.ZipFile(args.out) as z:
        biggest = sorted(z.infolist(), key=lambda i: -i.file_size)[:8]
        report.append("最大的檔案：" + ", ".join(f"{i.filename.split('/')[-1]} {i.file_size/1e6:.1f} MB" for i in biggest))
    print("\n".join(report))
    if after > args.target_mb * 1e6:
        print(f"⚠ 仍超過 {args.target_mb} MB：試試 --all-images、--max-edge 1600 或 --jpeg-quality 75", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
