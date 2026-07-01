#!/usr/bin/env python3
"""
Objective real-world scorecard for the cube detector. Mirrors the browser decode
(argmax on the corner heatmaps) and measures sim->real transfer on REAL photos:

  - Kaggle cube photos (with YOLO bbox): IoU(pred-corner-bbox vs GT), presence
  - No-cube crops (cut away from the cube): presence FALSE-POSITIVE rate

Usage:
  python training/eval_real.py [--onnx public/models/cube_detector.onnx]
                               [--archive ~/Downloads/archive.zip] [--n 150] [--tag ""]
Writes one line per run to .evalcache/history.jsonl and prints a scorecard.
"""
import argparse, glob, json, os, zipfile
import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406]); STD = np.array([0.229, 0.224, 0.225])
IMG_W, IMG_H = 320, 180
CACHE = ".evalcache/kaggle"


def ensure_kaggle(archive, n):
    os.makedirs(f"{CACHE}/images", exist_ok=True); os.makedirs(f"{CACHE}/labels", exist_ok=True)
    have = len(glob.glob(f"{CACHE}/images/*.jpg"))
    if have >= n:
        return
    archive = os.path.expanduser(archive)
    if not os.path.exists(archive):
        print(f"[warn] archive not found: {archive} (using {have} cached images)"); return
    with zipfile.ZipFile(archive) as z:
        imgs = [x for x in z.namelist() if x.startswith("images/") and x.endswith(".jpg")]
        imgs = sorted(imgs)[:n]
        for ip in imgs:
            name = os.path.basename(ip); lp = "labels/" + name[:-4] + ".txt"
            try:
                z.extract(ip, "/tmp/_kag"); os.replace(f"/tmp/_kag/{ip}", f"{CACHE}/images/{name}")
                z.extract(lp, "/tmp/_kag"); os.replace(f"/tmp/_kag/{lp}", f"{CACHE}/labels/{name[:-4]}.txt")
            except KeyError:
                pass
    print(f"[cache] {len(glob.glob(f'{CACHE}/images/*.jpg'))} Kaggle images ready")


def prep(im):
    a = (np.asarray(im.convert("RGB").resize((IMG_W, IMG_H))).astype(np.float32) / 255 - MEAN) / STD
    return a.transpose(2, 0, 1)[None].astype(np.float32)


class Model:
    def __init__(self, path):
        self.s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.inp = self.s.get_inputs()[0].name
        self.outs = [o.name for o in self.s.get_outputs()]

    def predict(self, im):
        r = self.s.run(None, {self.inp: prep(im)})
        od = dict(zip(self.outs, r))
        if "heatmaps" in od:  # new format: argmax decode (mirrors the browser)
            hm = od["heatmaps"][0]           # [8,H,W]
            g = od["globals"][0]             # [15]
            C, H, W = hm.shape
            pts = []
            for c in range(C):
                idx = int(hm[c].argmax()); r0, c0 = idx // W, idx % W
                r1, r2 = max(0, r0 - 2), min(H, r0 + 3); c1, c2 = max(0, c0 - 2), min(W, c0 + 3)
                win = hm[c, r1:r2, c1:c2]; sw = win.sum()
                rr = (win.sum(1) * np.arange(r1, r2)).sum() / sw if sw > 0 else r0
                cc = (win.sum(0) * np.arange(c1, c2)).sum() / sw if sw > 0 else c0
                pts.append([cc / (W - 1), rr / (H - 1)])
            pc = np.array(pts); vis = g[:8]; present = float(g[14])
        else:                                # old format: pred[31]
            p = od[self.outs[0]][0]
            pc = p[:16].reshape(8, 2); vis = p[16:24]; present = float(p[30])
        return pc, vis, present


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1]); x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    i = max(0, x2 - x1) * max(0, y2 - y1); ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - i
    return i / ua if ua > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", default="public/models/cube_detector.onnx")
    ap.add_argument("--archive", default="~/Downloads/archive.zip")
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    ensure_kaggle(a.archive, a.n)
    m = Model(a.onnx)

    ious, cube_p, nocube_p = [], [], []
    for lp in sorted(glob.glob(f"{CACHE}/labels/*.txt")):
        n = os.path.basename(lp)[:-4]; ip = f"{CACHE}/images/{n}.jpg"
        if not os.path.exists(ip):
            continue
        cx, cy, w, h = map(float, open(lp).read().split()[1:5]); gt = [cx-w/2, cy-h/2, cx+w/2, cy+h/2]
        im = Image.open(ip).convert("RGB"); W, H = im.size
        pc, vis, present = m.predict(im)
        pb = [pc[:, 0].min(), pc[:, 1].min(), pc[:, 0].max(), pc[:, 1].max()]
        ious.append(iou(pb, gt)); cube_p.append(present)
        cw = int(W * 0.45); ch = int(cw * 9 / 16); x0 = 0 if cx > 0.5 else W - cw
        y0 = max(0, min(H - ch, int(H * 0.3))); patch = im.crop((x0, y0, x0 + cw, y0 + ch))
        if abs((x0 + cw / 2) / W - cx) > 0.3:
            _, _, pp = m.predict(patch); nocube_p.append(pp)
    ious = np.array(ious); cube_p = np.array(cube_p); nocube_p = np.array(nocube_p)
    card = {
        "tag": a.tag, "onnx": a.onnx, "n_cube": len(ious), "n_nocube": len(nocube_p),
        "iou_mean": round(float(ious.mean()), 3), "iou_median": round(float(np.median(ious)), 3),
        "iou_gt0.3": round(float((ious > 0.3).mean()), 3), "iou_gt0.5": round(float((ious > 0.5).mean()), 3),
        "presence_cube_mean": round(float(cube_p.mean()), 3),
        "presence_cube_gt0.7": round(float((cube_p > 0.7).mean()), 3),
        "presence_nocube_FP_gt0.7": round(float((nocube_p > 0.7).mean()), 3),
        "presence_nocube_mean": round(float(nocube_p.mean()), 3),
    }
    print("=== REAL SCORECARD ===")
    for k, v in card.items():
        print(f"  {k}: {v}")
    os.makedirs(".evalcache", exist_ok=True)
    with open(".evalcache/history.jsonl", "a") as f:
        f.write(json.dumps(card) + "\n")


if __name__ == "__main__":
    main()
