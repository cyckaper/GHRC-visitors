"""產生 e2e 用的 HEIC 測試檔（不是測試的一部分，改了才重跑）：python3 test/fixtures/make-heic.py

tenbit.heic：320×240、10-bit（跟 iPhone 的 HDR／ProRAW 以外的一般照片一樣是 HEVC，但每個顏色 10 位元）。
左半紅、右半藍——舊的 heic2any（libheif 1.10）轉 10-bit 會轉出一片雜訊、不報錯，所以 e2e 看轉出來的顏色對不對。
要 pillow-heif（pip install pillow-heif；1.8.1 帶 libheif 1.23.6）。內容是自己畫的色塊，沒有任何人的照片。
"""
import pathlib

import numpy as np
import pillow_heif

here = pathlib.Path(__file__).parent
w, h = 320, 240
px = np.zeros((h, w, 3), dtype=np.uint16)
px[:, : w // 2] = (65535, 0, 0)  # 左半紅
px[:, w // 2 :] = (0, 0, 65535)  # 右半藍
img = pillow_heif.from_bytes(mode="RGB;16", size=(w, h), data=px.tobytes())
img.save(str(here / "tenbit.heic"), quality=90, save_to_12bit=False)
print((here / "tenbit.heic").stat().st_size, "bytes")
