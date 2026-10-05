#!/usr/bin/env python3
"""網頁版簡報用的圖（scripts/web-deck/build.mjs 叫的）。

  python3 raster.py pdf <render.pdf> <outdir> --width 1920 --thumb 480
      PDF 每一頁 → sNN.webp（寬 width）與縮圖 tNN.webp；印出 {"pages", "width", "height", "bytes"}
  python3 raster.py image <in> <out.webp> --max 1600
      一張圖（影片的海報影格）→ webp，長邊最多 max；維持原比例，不裁切
"""
import argparse
import json
import os
import sys

import pymupdf
from PIL import Image


def pdf_pages(args):
    doc = pymupdf.open(args.src)
    total = 0
    w = h = 0
    for i, page in enumerate(doc, 1):
        zoom = args.width / page.rect.width
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        w, h = img.size
        big = os.path.join(args.out, f"s{i:02d}.webp")
        img.save(big, "WEBP", quality=args.quality, method=6)
        small = img.copy()
        small.thumbnail((args.thumb, args.thumb), Image.LANCZOS)
        thumb = os.path.join(args.out, f"t{i:02d}.webp")
        small.save(thumb, "WEBP", quality=70, method=6)
        total += os.path.getsize(big) + os.path.getsize(thumb)
    print(json.dumps({"pages": doc.page_count, "width": w, "height": h, "bytes": total}))


def one_image(args):
    img = Image.open(args.src)
    img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    img.thumbnail((args.max, args.max), Image.LANCZOS)
    img.save(args.out, "WEBP", quality=82, method=6)
    print(json.dumps({"width": img.size[0], "height": img.size[1]}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pdf")
    p.add_argument("src")
    p.add_argument("out")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--thumb", type=int, default=480)
    p.add_argument("--quality", type=int, default=82)
    p.set_defaults(fn=pdf_pages)
    q = sub.add_parser("image")
    q.add_argument("src")
    q.add_argument("out")
    q.add_argument("--max", type=int, default=1600)
    q.set_defaults(fn=one_image)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
