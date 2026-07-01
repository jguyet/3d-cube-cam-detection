#!/usr/bin/env python3
"""
Extract REAL no-cube crops from the Kaggle archive to use as HARD NEGATIVES for
the presence head (synthetic distractors didn't cut it — real clutter does).

For each real cube photo we crop a 16:9 region AWAY from the cube bbox (real
scene, no cube) and append it to a dataset as a present=0 sample. We SKIP the
first `--skip` images so the eval benchmark (which uses the first 150) stays
held-out — no train/test leakage.

Usage:
  python training/extract_real_negs.py --data dataset-4 --archive ~/Downloads/archive.zip \
      --skip 200 --n 5000
"""
import argparse, json, os, zipfile, io
from PIL import Image


def _overlap(x0, y0, cw, ch, W, H, bbox):
    cx, cy, bw, bh = bbox
    gx1, gy1, gx2, gy2 = cx - bw/2, cy - bh/2, cx + bw/2, cy + bh/2
    rx1, ry1, rx2, ry2 = x0/W, y0/H, (x0+cw)/W, (y0+ch)/H
    return max(0, min(gx2, rx2) - max(gx1, rx1)) * max(0, min(gy2, ry2) - max(gy1, ry1))


def crops_no_cube(im, bbox):
    """Yield several 16:9 crops that don't overlap the cube bbox (real no-cube scenes)."""
    W, H = im.size
    out = []
    for frac in (0.55, 0.4, 0.32):
        cw = int(W * frac); ch = int(cw * 9 / 16)
        if ch > H:
            ch = int(H * 0.95); cw = int(ch * 16 / 9)
        if cw > W:
            continue
        # candidate window origins: 4 corners + 2 mid-edges
        cands = [(0, 0), (W - cw, 0), (0, H - ch), (W - cw, H - ch),
                 ((W - cw) // 2, 0), ((W - cw) // 2, H - ch)]
        for (x0, y0) in cands:
            x0 = max(0, min(W - cw, x0)); y0 = max(0, min(H - ch, y0))
            if _overlap(x0, y0, cw, ch, W, H, bbox) <= 0.01:
                out.append(im.crop((x0, y0, x0 + cw, y0 + ch)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--archive", default="~/Downloads/archive.zip")
    ap.add_argument("--skip", type=int, default=200)
    ap.add_argument("--n", type=int, default=5000)
    a = ap.parse_args()
    archive = os.path.expanduser(a.archive)
    os.makedirs(a.data, exist_ok=True)
    lab = open(os.path.join(a.data, "labels.jsonl"), "a")
    hidden = [{"x": 0.5, "y": 0.5, "v": 0} for _ in range(8)]
    written = 0
    with zipfile.ZipFile(archive) as z:
        imgs = sorted([x for x in z.namelist() if x.startswith("images/") and x.endswith(".jpg")])
        imgs = imgs[a.skip:]
        for ip in imgs:
            if written >= a.n:
                break
            name = os.path.basename(ip); lp = "labels/" + name[:-4] + ".txt"
            try:
                bbox = tuple(map(float, z.read(lp).decode().split()[1:5]))
            except KeyError:
                continue
            im = Image.open(io.BytesIO(z.read(ip))).convert("RGB")
            for crop in crops_no_cube(im, bbox)[:4]:   # up to 4 crops per image
                if written >= a.n:
                    break
                fn = f"realneg_{written:05d}.png"
                crop.resize((480, 270)).save(os.path.join(a.data, fn))
                lab.write(json.dumps({"file": fn, "corners": hidden, "faces": [0]*6, "scheme": "black", "present": 0}) + "\n")
                written += 1
                if written % 1000 == 0:
                    print(f"  {written} real negatives")
    lab.close()
    print(f"done — appended {written} real no-cube negatives to {a.data}")


if __name__ == "__main__":
    main()
