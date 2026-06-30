# Cube detector — training

End-to-end: generate a synthetic dataset in the browser, train a small net on your
PC, export ONNX, run it live in the browser.

## 1. Generate the dataset (browser)

- `npm run dev`, open **`/dataset`**.
- The 988 real backgrounds (`public/backgrounds/`) load automatically; the cube is
  placed **on the blurred zone** of each. Add your own home/office wallpapers with
  **« Charger des fonds »** if you want more.
- Régénère quelques échantillons → vérifie que les coins (verts/rouges) tombent bien
  sur le cube et que les mains/fond sont crédibles.
- Set the size (e.g. **20000**) → **« Générer + exporter »** → pick an empty folder.
  It writes `cube_00000.png … ` + `labels.jsonl`.

Tip: generate in 2–3 batches into the **same** folder if 50k at once is heavy
(append mode — just keep the same folder; rename files between batches if needed).

## 2. Train (your PC)

```bash
cd training
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python train.py --data /path/to/exported_dataset --epochs 30 --batch 64
```

- Auto-detects CUDA / Apple MPS / CPU.
- Model: MobileNetV3-small (ImageNet-pretrained) + a head → **30 outputs** in 0..1:
  `[ 8 corners ×(x,y)=16 | 8 corner-visibility | 6 face-visibility ]`.
- Saves `best.pt` and exports **`cube_detector.onnx`** on every improvement.
- ~2M params → trains fast even on a mid GPU; 20–50k images is plenty.

## 3. Output format (for the browser)

Input: RGB image resized to **256×256**, normalised with ImageNet mean/std.
Output `pred[30]` (all sigmoid, 0..1):

| index | meaning |
|---|---|
| 0..15 | corner positions: `(x0,y0, x1,y1, …, x7,y7)` in 0..1 image coords |
| 16..23 | corner visibility (≥0.5 = visible) |
| 24..29 | face visibility (≥0.5 = visible), face order = +X,−X,+Y,−Y,+Z,−Z |

Corner index `c = i*4 + j*2 + k` with `i,j,k ∈ {0,1}` mapping to `(x,y,z) = ±0.5`
(same as `cubeModel.ts` / `engine.ts`). The visible corners + their cube-edge
connectivity give the 3D pose; from there a cube wireframe overlays exactly.

## 4. Next: browser inference

Load `cube_detector.onnx` with **onnxruntime-web**, run on each camera frame
(256×256), read `pred`, draw the cube from the predicted corners. The existing
pure-JS detector stays as a fast fallback / sanity check.
