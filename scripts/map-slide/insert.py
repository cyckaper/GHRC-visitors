#!/usr/bin/env python3
"""母簡報的地圖頁：把 render.mjs 畫好的那張世界地圖放進去，或換成新的一張。

為什麼分成兩支：`/deck` 的地圖頁是**活的**（deck.html 直接掛 /lib/worldmap.mjs，來訪單位一加進系統就跟著變），
.pptx 裡只能放圖，所以簡報這一頁要重跑這一支才會更新。兩邊畫的是同一支 `public/lib/worldmap.mjs`、
同一份 `/api/visitor-map`，所以長得一樣。

形狀的名稱是約定：地圖那張圖叫 **`GHRC_MAP`**（`scripts/web-deck/build.mjs` 的 `mapBox()` 認的就是它，
認出來才會在 `/deck` 疊活的地圖）、底下那一行數字叫 **`GHRC_MAP_STATS`**。改名字兩邊都要改。

    # 平常跑的是這一條：換成新的一張（位置與大小不動）
    python3 scripts/map-slide/insert.py update 母簡報.pptx map.png

    # 第一次放進去：照第 37 頁複製一頁、排成第 40 頁，文字照 --replace 換掉，地圖放在指定的框裡
    python3 scripts/map-slide/insert.py add 母簡報.pptx map.png --like=37 --at=40 \\
        --box=1.0,2.2,11.3,4.5 --replace="舊標題=Where Our Visitors Come From" --drop-pictures

`update` 只照圖的比例把高度算回去（簡報的照片不變形、不裁切是既有標準），框的位置不動——
所以版面排好一次之後，之後每一次更新都不會跑掉。
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import sys

from pptx import Presentation
from pptx.util import Inches

MAP_NAME = "GHRC_MAP"
STATS_NAME = "GHRC_MAP_STATS"


def walk(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == 6:  # GROUP
            yield from walk(sh.shapes)


def find_named(prs, name):
    """(slide, shape)，找不到就是 (None, None)。群組裡的也找。"""
    for slide in prs.slides:
        for sh in walk(slide.shapes):
            if sh.name == name:
                return slide, sh
    return None, None


def png_size(path):
    """只讀檔頭拿寬高（PNG 的 IHDR），不為了兩個數字去裝影像套件。"""
    with open(path, "rb") as f:
        head = f.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} 不是 PNG")
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def set_lines(shape, lines):
    """把一個文字框換成這幾行，**格式照原本每一段的第一個 run**（字型、字級、顏色都不動）。
    原本的段落不夠就複製最後一段，多的就刪掉。"""
    tf = shape.text_frame
    while len(tf.paragraphs) < len(lines):
        tf._txBody.append(copy.deepcopy(tf.paragraphs[-1]._p))
    for p, text in zip(tf.paragraphs, lines):
        runs = p.runs
        if not runs:
            continue
        runs[0].text = text
        for r in runs[1:]:
            r._r.getparent().remove(r._r)
    for p in list(tf.paragraphs)[len(lines):]:
        p._p.getparent().remove(p._p)


def stats_lines(meta):
    """英文為主、中文為輔（雙語簡報的既有標準）。"""
    d = dt.date.today()
    inst, ctry, vis = meta["institutions"], meta["countries"], meta["visits"]
    en = f"{inst} institutions from {ctry} countries · {vis} visits · as of {d.day} {d.strftime('%B %Y')}"
    zh = f"{ctry} 個國家 · {inst} 個單位 · {vis} 場　{d.year} 年 {d.month} 月 {d.day} 日"
    return [en, zh]


def fit(pic, png, box):
    """照圖的真實比例放進框裡（不變形、不裁切），置中。"""
    left, top, width, height = box
    pw, ph = png_size(png)
    w, h = width, int(round(width * ph / pw))
    if h > height:
        w, h = int(round(height * pw / ph)), height
    pic.left, pic.top, pic.width, pic.height = left + (width - w) // 2, top + (height - h) // 2, w, h


def write_stats(prs, png):
    meta_path = png + ".json"
    if not os.path.exists(meta_path):
        return ""
    meta = json.load(open(meta_path, encoding="utf-8"))
    _, stats = find_named(prs, STATS_NAME)
    if stats is None:
        return f"（沒找到 {STATS_NAME}，數字沒改）"
    set_lines(stats, stats_lines(meta))
    return f"、數字改成 {meta['countries']} 國 / {meta['institutions']} 單位 / {meta['visits']} 場"


def do_update(args):
    prs = Presentation(args.pptx)
    slide, pic = find_named(prs, MAP_NAME)
    if pic is None:
        raise SystemExit(f"母簡報裡沒有叫 {MAP_NAME} 的圖——第一次請用 add")
    box = (pic.left, pic.top, pic.width, pic.height)
    _, rId = slide.part.get_or_add_image_part(args.png)
    pic._element.blipFill.blip.rEmbed = rId
    fit(pic, args.png, box)
    note = write_stats(prs, args.png)
    out = args.out or args.pptx
    prs.save(out)
    print(f"地圖換好了{note} → {out}")


def move_to(prs, index):
    """剛加的那一頁（一定在最後）搬到第 index 頁（從 1 數）。"""
    ids = prs.slides._sldIdLst
    el = list(ids)[-1]
    ids.remove(el)
    ids.insert(max(0, min(index - 1, len(list(ids)))), el)


def do_add(args):
    prs = Presentation(args.pptx)
    if find_named(prs, MAP_NAME)[1] is not None:
        raise SystemExit(f"母簡報裡已經有 {MAP_NAME} 了——要換圖請用 update")
    src = prs.slides[args.like - 1]
    new = prs.slides.add_slide(src.slide_layout)
    for sh in list(new.shapes):  # 版面配置帶來的空白佔位框拿掉，整頁照來源頁複製
        sh._element.getparent().remove(sh._element)
    keep = [s.strip() for s in (args.keep or "").split(",") if s.strip()]
    for sh in src.shapes:
        if keep and sh.name not in keep and sh.name != args.stats_from:
            continue  # 只帶頁眉、標題、頁尾那幾個（本文是這一頁自己的）
        if args.drop_pictures and sh.shape_type == 13:  # PICTURE
            continue
        new.shapes._spTree.append(copy.deepcopy(sh._element))
    # 數字那一行：照來源頁某一個文字框的格式（字型、字級、顏色都不動），搬到地圖底下
    if args.stats_from:
        for sh in walk(new.shapes):
            if sh.name == args.stats_from:
                sh.name = STATS_NAME
                if args.stats_box:
                    l, t, w, h = (Inches(float(v)) for v in args.stats_box.split(","))
                    sh.left, sh.top, sh.width, sh.height = l, t, w, h
                break
    for pair in args.replace or []:
        old, _, newtext = pair.partition("=")
        for sh in walk(new.shapes):
            if sh.has_text_frame and old and old in sh.text_frame.text and sh.name != STATS_NAME:
                set_lines(sh, [newtext] if newtext else [])
    box = tuple(Inches(float(v)) for v in args.box.split(","))
    pic = new.shapes.add_picture(args.png, box[0], box[1], width=box[2])
    pic.name = MAP_NAME
    fit(pic, args.png, box)
    note = write_stats(prs, args.png)
    move_to(prs, args.at)
    out = args.out or args.pptx
    prs.save(out)
    print(f"地圖頁加好了（第 {args.at} 頁）{note} → {out}")


def do_renumber(args):
    """角落寫死的頁碼照現在的頁序改回來（插一頁進去，後面每一頁的頁碼都少一號）。"""
    prs = Presentation(args.pptx)
    n = 0
    for i, slide in enumerate(prs.slides, 1):
        for sh in slide.shapes:
            if not sh.has_text_frame or sh.top is None:
                continue
            t = sh.text_frame.text.strip()
            # 頁面最下面、不寬、整個框只寫著一個數字的那一個
            if t.isdigit() and sh.top > prs.slide_height * 0.88 and sh.width < prs.slide_width * 0.15:
                if t != str(i):
                    set_lines(sh, [str(i)])
                    n += 1
                break
    out = args.out or args.pptx
    prs.save(out)
    print(f"頁碼改了 {n} 頁 → {out}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    u = sub.add_parser("update", help="換成新的一張地圖（位置與大小不動）")
    u.add_argument("pptx")
    u.add_argument("png")
    u.add_argument("--out", help="另存成別的檔（預設直接改原檔）")
    u.set_defaults(func=do_update)

    a = sub.add_parser("add", help="第一次把地圖頁放進去")
    a.add_argument("pptx")
    a.add_argument("png")
    a.add_argument("--like", type=int, required=True, help="照第幾頁複製一頁（頁眉、頁碼、底色都跟著走）")
    a.add_argument("--at", type=int, required=True, help="放成第幾頁")
    a.add_argument("--box", required=True, help="地圖的框：left,top,width,height（英吋）")
    a.add_argument("--replace", action="append", help='文字取代「舊=新」，新的留空就是整個拿掉；可以給好幾個')
    a.add_argument("--keep", help="來源頁只帶這幾個形狀過來（名稱，逗號分隔；頁眉、標題、頁尾、頁碼）")
    a.add_argument("--stats-from", help="數字那一行照來源頁哪一個文字框的格式（會改名成 GHRC_MAP_STATS）")
    a.add_argument("--stats-box", help="數字那一行的位置：left,top,width,height（英吋）")
    a.add_argument("--drop-pictures", action="store_true", help="來源頁的照片不要帶過來")
    a.add_argument("--out")
    a.set_defaults(func=do_add)

    r = sub.add_parser("renumber", help="角落寫死的頁碼照現在的頁序改回來")
    r.add_argument("pptx")
    r.add_argument("--out")
    r.set_defaults(func=do_renumber)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
