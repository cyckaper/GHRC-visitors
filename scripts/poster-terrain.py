"""GHRC 歡迎海報：等高線底紋產生器（選用）。
用法：python3 scripts/poster-terrain.py [seed] > terrain.json（需要 numpy、matplotlib）
輸出 viewBox 600 x 600 的兩組路徑（minor／index），換進 public/assets/brand/poster-terrain.svg 那兩個 path。
主峰在右、山脊往左下，左上留白給 Welcome；改 seed 只會改變細部起伏。
"""
import json, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def smooth_path(pts):
    # quadratic smoothing through segment midpoints
    if len(pts) < 3:
        return "M" + " L".join(f"{p[0]:.1f} {p[1]:.1f}" for p in pts)
    mids = (pts[:-1] + pts[1:]) / 2
    d = [f"M{pts[0][0]:.1f} {pts[0][1]:.1f} L{mids[0][0]:.1f} {mids[0][1]:.1f}"]
    for i in range(1, len(mids)):
        c = pts[i]; m = mids[i]
        d.append(f"Q{c[0]:.1f} {c[1]:.1f} {m[0]:.1f} {m[1]:.1f}")
    d.append(f"L{pts[-1][0]:.1f} {pts[-1][1]:.1f}")
    return "".join(d)

def decimate(pts, step=2.2):
    out = [pts[0]]
    for p in pts[1:]:
        if np.hypot(*(p - out[-1])) >= step:
            out.append(p)
    if len(out) > 1 and np.hypot(*(pts[-1]-out[-1])) > 0: out.append(pts[-1])
    return np.array(out)

def field(W=600, H=600, n=560, seed=11):
    rng = np.random.default_rng(seed)
    x = np.linspace(0, W, n); y = np.linspace(0, H, n)
    X, Y = np.meshgrid(x, y)
    # gentle domain warp so lines read as ground, not geometry
    wx = sum(9*np.sin(X/rng.uniform(55,95)+rng.uniform(0,6)) * np.cos(Y/rng.uniform(60,110)+rng.uniform(0,6)) for _ in range(3))
    wy = sum(9*np.cos(X/rng.uniform(60,100)+rng.uniform(0,6)) * np.sin(Y/rng.uniform(55,95)+rng.uniform(0,6)) for _ in range(3))
    Xw, Yw = X + wx, Y + wy
    def g(cx, cy, rx, ry, a, ang=0.0):
        c, s = np.cos(ang), np.sin(ang)
        u = (Xw-cx)*c + (Yw-cy)*s; v = -(Xw-cx)*s + (Yw-cy)*c
        return a*np.exp(-(u*u/(2*rx*rx) + v*v/(2*ry*ry)))
    Z  = g(505, 345, 150, 135, 1.00)              # summit, right-middle
    Z += g(390, 470, 260, 85, 0.55, ang=-0.62)    # spur running down to the lower left
    Z += g(615, 60, 120, 120, 0.50)               # second rise off the top-right corner
    Z += g(330, 610, 200, 70, 0.30, ang=0.15)     # low terrace along the bottom
    return X, Y, Z


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 11
    X, Y, Z = field(seed=seed)
    q = np.quantile(Z, [0.42, 0.999])
    cs = plt.contour(X, Y, Z, levels=np.linspace(q[0], q[1], 19))
    minor, index = [], []
    for i, segs in enumerate(cs.allsegs):
        for seg in segs:
            if len(seg) < 6: continue
            p = decimate(np.asarray(seg), 2.0)
            if len(p) < 3: continue
            (index if i % 5 == 2 else minor).append(smooth_path(p))
    json.dump({"minor": " ".join(minor), "index": " ".join(index)}, sys.stdout)
