#!/usr/bin/env python3
"""
Train a small cube-pose detector on the synthetic dataset from /dataset.

Input: a folder with cube_XXXXX.png + labels.jsonl  (one JSON per line:
  {"file": "...", "corners": [{"x","y","v"} x8], "faces": [v x6], "scheme": "..."})

Output: cube_detector.onnx  (+ best.pt) — runs in the browser via onnxruntime-web.

Model: MobileNetV3-small backbone (ImageNet-pretrained → helps sim2real) + a head
predicting, per image:
  - 8 corner positions (x,y in 0..1)         -> 16 sigmoids
  - 8 corner visibilities                    -> 8  sigmoids
  - 6 face visibilities                      -> 6  sigmoids
Output tensor: [30] = [16 coords | 8 vis | 6 faces], all in 0..1.

Usage:
  pip install -r requirements.txt
  python train.py --data /path/to/exported_dataset --epochs 30 --batch 64
"""
import argparse, json, os, random
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from PIL import Image
import torchvision.transforms as T
from torchvision.models import (
    mobilenet_v3_small, MobileNet_V3_Small_Weights,
    mobilenet_v3_large, MobileNet_V3_Large_Weights,
)

IMG = 256
N_CORNERS = 8

# ----------------------------- dataset -----------------------------
class CubeDataset(Dataset):
    def __init__(self, root, train=True):
        self.root = Path(root)
        self.items = []
        with open(self.root / "labels.jsonl") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.items.append(json.loads(line))
        self.train = train
        # geometry is fixed (labels are pixel-exact) → only photometric aug
        aug = []
        if train:
            aug = [
                T.ColorJitter(0.3, 0.3, 0.3, 0.05),
                T.RandomApply([T.GaussianBlur(3, (0.1, 1.5))], p=0.3),
                T.RandomAdjustSharpness(2, p=0.2),
                T.RandomAutocontrast(p=0.2),
            ]
        self.tf = T.Compose([
            T.Resize((IMG, IMG)),
            *aug,
            T.ToTensor(),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        it = self.items[i]
        img = Image.open(self.root / it["file"]).convert("RGB")
        x = self.tf(img)
        coords, vis = [], []
        for c in it["corners"]:
            coords += [c["x"], c["y"]]
            vis.append(float(c["v"]))
        faces = [float(v) for v in it["faces"]]
        y = torch.tensor(coords + vis + faces, dtype=torch.float32)  # [30]
        return x, y

# ----------------------------- model -----------------------------
class CubeNet(nn.Module):
    def __init__(self, model="large"):
        super().__init__()
        if model == "large":
            bb = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.DEFAULT)
        else:
            bb = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
        self.features = bb.features
        self.pool = nn.AdaptiveAvgPool2d(1)
        feat = bb.classifier[0].in_features  # small=576, large=960
        self.head = nn.Sequential(
            nn.Linear(feat, 256), nn.Hardswish(), nn.Dropout(0.2),
            nn.Linear(256, 2 * N_CORNERS + N_CORNERS + 6),  # 16 + 8 + 6 = 30
        )

    def forward(self, x):
        f = self.pool(self.features(x)).flatten(1)
        return torch.sigmoid(self.head(f))  # all outputs in 0..1

# ----------------------------- loss -----------------------------
def loss_fn(pred, tgt):
    pc, pv, pf = pred[:, :16], pred[:, 16:24], pred[:, 24:]
    tc, tv, tf = tgt[:, :16], tgt[:, 16:24], tgt[:, 24:]
    # corner position: only penalise VISIBLE corners (mask), hidden lightly
    vmask = tv.repeat_interleave(2, dim=1)  # [B,16]
    w = vmask + 0.1 * (1 - vmask)
    coord = (w * (pc - tc) ** 2).mean()
    bce = nn.functional.binary_cross_entropy
    return 4.0 * coord + bce(pv, tv) + bce(pf, tf), coord.item()

# ----------------------------- train -----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--val", type=float, default=0.1)
    ap.add_argument("--model", choices=["small", "large"], default="large")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--export-only", action="store_true", help="load best.pt and export ONNX, no training")
    a = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    print("device:", dev, "| model:", a.model, "| batch:", a.batch)

    if a.export_only:
        net = CubeNet(a.model).to(dev)
        net.load_state_dict(torch.load("best.pt", map_location=dev))
        export_onnx(net, dev)
        print("exported cube_detector.onnx from best.pt")
        return

    full = CubeDataset(a.data, train=True)
    n_val = max(1, int(len(full) * a.val))
    idx = list(range(len(full))); random.Random(0).shuffle(idx)
    val_idx, tr_idx = set(idx[:n_val]), idx[n_val:]
    tr = torch.utils.data.Subset(full, tr_idx)
    va = torch.utils.data.Subset(CubeDataset(a.data, train=False), sorted(val_idx))
    print(f"train {len(tr)}  val {len(va)}")

    pin = dev == "cuda"
    pw = a.workers > 0
    tl = DataLoader(tr, a.batch, shuffle=True, num_workers=a.workers, pin_memory=pin, persistent_workers=pw)
    vl = DataLoader(va, a.batch, shuffle=False, num_workers=max(2, a.workers // 2), persistent_workers=pw)

    net = CubeNet(a.model).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sch = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.epochs)

    best = 1e9
    for ep in range(a.epochs):
        net.train(); tot = 0
        for x, y in tl:
            x, y = x.to(dev), y.to(dev)
            opt.zero_grad()
            loss, _ = loss_fn(net(x), y)
            loss.backward(); opt.step()
            tot += loss.item() * len(x)
        sch.step()
        # val
        net.eval(); vtot = vcoord = 0
        with torch.no_grad():
            for x, y in vl:
                x, y = x.to(dev), y.to(dev)
                loss, c = loss_fn(net(x), y)
                vtot += loss.item() * len(x); vcoord += c * len(x)
        vtot /= len(va); vcoord /= len(va)
        print(f"ep {ep+1:02d}/{a.epochs}  train {tot/len(tr):.4f}  val {vtot:.4f}  coordMSE {vcoord:.5f}")
        if vtot < best:
            best = vtot
            torch.save(net.state_dict(), "best.pt")
            try:
                export_onnx(net, dev)
            except Exception as e:
                print("  (onnx export skipped:", type(e).__name__, "— `pip install onnx onnxscript`)")
    print("done. best val", best, "-> best.pt / cube_detector.onnx")

def export_onnx(net, dev):
    import os
    import onnx
    net.eval()
    net.to("cpu")  # ONNX export is safest from CPU
    dummy = torch.randn(1, 3, IMG, IMG)
    torch.onnx.export(
        net, dummy, "cube_detector.onnx",
        input_names=["image"], output_names=["pred"],
        dynamic_axes={"image": {0: "batch"}, "pred": {0: "batch"}},
        opset_version=18,
    )
    # Consolidate any external-weights file into ONE self-contained .onnx so it
    # loads in onnxruntime-web (the browser can't fetch cube_detector.onnx.data).
    m = onnx.load("cube_detector.onnx")  # pulls in external data if present
    onnx.save_model(m, "cube_detector.onnx", save_as_external_data=False)
    if os.path.exists("cube_detector.onnx.data"):
        os.remove("cube_detector.onnx.data")
    net.to(dev)
    print("  -> cube_detector.onnx (single self-contained file)")

if __name__ == "__main__":
    main()
