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
  - 1 presence ("is a cube in frame?")       -> 1  sigmoid
Output tensor: [31] = [16 coords | 8 vis | 6 faces | 1 present], all in 0..1.

Usage:
  pip install -r requirements.txt
  python train.py --data /path/to/exported_dataset --epochs 30 --batch 64
"""
import argparse, json, os, random
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from PIL import Image
import torchvision.transforms as T
from torchvision.models import (
    mobilenet_v3_small, MobileNet_V3_Small_Weights,
    mobilenet_v3_large, MobileNet_V3_Large_Weights,
)

IMG_W, IMG_H = 320, 180   # model input (16:9, matches the 480×270 dataset ratio)
N_CORNERS = 8


class AddNoise:
    """Gaussian pixel noise on a tensor (prob p) — closes the sim2real gap a bit."""
    def __init__(self, p=0.3, std=0.05):
        self.p, self.std = p, std

    def __call__(self, x):
        if random.random() < self.p:
            x = (x + torch.randn_like(x) * self.std).clamp(0, 1)
        return x

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
        aug, post = [], []
        if train:
            aug = [
                T.ColorJitter(0.4, 0.4, 0.4, 0.08),
                T.RandomApply([T.GaussianBlur(3, (0.1, 2.0))], p=0.4),
                T.RandomAdjustSharpness(2, p=0.2),
                T.RandomAutocontrast(p=0.2),
                T.RandomGrayscale(p=0.05),
                T.RandomPosterize(bits=5, p=0.1),
            ]
            post = [AddNoise(p=0.3, std=0.05)]
        self.tf = T.Compose([
            T.Resize((IMG_H, IMG_W)),
            *aug,
            T.ToTensor(),
            *post,
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
        present = float(it.get("present", 1))  # old datasets had no negatives
        y = torch.tensor(coords + vis + faces + [present], dtype=torch.float32)  # [31]
        return x, y

# ----------------------------- model -----------------------------
HM_H, HM_W = 48, 80   # corner-heatmap grid (16:9-ish) — finer = more precise corners

def soft_argmax(hm):
    """[B,C,H,W] logits → per-channel (x,y) in 0..1 via spatial softmax + the prob maps."""
    B, C, H, W = hm.shape
    p = torch.softmax(hm.reshape(B, C, H * W), dim=2).reshape(B, C, H, W)
    xs = torch.linspace(0, 1, W, device=hm.device).view(1, 1, W)
    ys = torch.linspace(0, 1, H, device=hm.device).view(1, 1, H)
    x = (p.sum(2) * xs).sum(2)   # [B,C]
    y = (p.sum(3) * ys).sum(2)   # [B,C]
    return torch.stack([x, y], dim=2), p

def gaussian_target(coords, H, W, device, sigma=0.05):
    """[B,C,2] in 0..1 → [B,C,H,W] gaussians (sum 1 per channel) centred on each corner."""
    B, C, _ = coords.shape
    xs = torch.linspace(0, 1, W, device=device).view(1, 1, 1, W)
    ys = torch.linspace(0, 1, H, device=device).view(1, 1, H, 1)
    cx = coords[..., 0].view(B, C, 1, 1); cy = coords[..., 1].view(B, C, 1, 1)
    g = torch.exp(-(((xs - cx) ** 2 + (ys - cy) ** 2)) / (2 * sigma * sigma))
    return g / (g.sum(dim=(2, 3), keepdim=True) + 1e-8)

class CubeNet(nn.Module):
    """Corners via a SPATIAL heatmap head (localise by local appearance → robust
    to sim2real). Visibility/faces/presence stay global (they transfer fine)."""
    def __init__(self, model="large"):
        super().__init__()
        if model == "large":
            bb = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.DEFAULT)
        else:
            bb = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
        self.features = bb.features
        self.pool = nn.AdaptiveAvgPool2d(1)
        feat = bb.classifier[0].in_features  # small=576, large=960
        # spatial decoder → one heatmap per corner
        self.decoder = nn.Sequential(
            nn.Conv2d(feat, 128, 3, padding=1), nn.BatchNorm2d(128), nn.Hardswish(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),   # →12×20
            nn.Conv2d(128, 64, 3, padding=1), nn.BatchNorm2d(64), nn.Hardswish(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),   # →24×40
            nn.Conv2d(64, 32, 3, padding=1), nn.BatchNorm2d(32), nn.Hardswish(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),   # →48×80
            nn.Conv2d(32, N_CORNERS, 1),
        )
        # global heads: 8 visibilities + 6 faces + 1 presence
        self.ghead = nn.Sequential(
            nn.Linear(feat, 256), nn.Hardswish(), nn.Dropout(0.2),
            nn.Linear(256, N_CORNERS + 6 + 1),
        )

    def forward(self, x, return_hm: bool = False):
        f = self.features(x)
        hm = F.interpolate(self.decoder(f), size=(HM_H, HM_W), mode="bilinear", align_corners=False)
        coords, prob = soft_argmax(hm)                       # [B,8,2], [B,8,H,W]
        go = torch.sigmoid(self.ghead(self.pool(f).flatten(1)))  # [B,15]
        out = torch.cat([coords.reshape(x.shape[0], 16), go], dim=1)  # [B,31]
        return (out, prob) if return_hm else out

# ----------------------------- loss -----------------------------
def loss_fn(pred, prob, tgt):
    pc, pv, pf, pp = pred[:, :16], pred[:, 16:24], pred[:, 24:30], pred[:, 30:31]
    tc, tv, tf, tp = tgt[:, :16], tgt[:, 16:24], tgt[:, 24:30], tgt[:, 30:31]
    bce = F.binary_cross_entropy
    pres = bce(pp, tp)                                   # presence on every frame
    denom = tp.sum().clamp(min=1.0)
    vmask = tv.repeat_interleave(2, dim=1)
    w = (vmask + 0.1 * (1 - vmask)) * tp
    coord = (w * (pc - tc) ** 2).sum() / w.sum().clamp(min=1.0)         # soft-argmax coords
    vis = (tp * bce(pv, tv, reduction="none").mean(1, keepdim=True)).sum() / denom
    fac = (tp * bce(pf, tf, reduction="none").mean(1, keepdim=True)).sum() / denom
    # heatmap cross-entropy: each visible corner's prob map must peak at the GT corner
    gc = tc.reshape(tgt.shape[0], N_CORNERS, 2)
    tgt_hm = gaussian_target(gc, HM_H, HM_W, prob.device)
    hmw = tv * tp                                        # [B,8] visible & present
    ce = -(tgt_hm * torch.log(prob + 1e-8)).sum(dim=(2, 3))            # [B,8]
    hml = (ce * hmw).sum() / hmw.sum().clamp(min=1.0)
    return 4.0 * coord + 3.0 * hml + vis + fac + pres, coord.item()

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
            out, prob = net(x, return_hm=True)
            loss, _ = loss_fn(out, prob, y)
            loss.backward(); opt.step()
            tot += loss.item() * len(x)
        sch.step()
        # val
        net.eval(); vtot = vcoord = 0
        with torch.no_grad():
            for x, y in vl:
                x, y = x.to(dev), y.to(dev)
                out, prob = net(x, return_hm=True)
                loss, c = loss_fn(out, prob, y)
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
    dummy = torch.randn(1, 3, IMG_H, IMG_W)
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
