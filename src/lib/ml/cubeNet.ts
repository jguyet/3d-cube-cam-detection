// Browser inference for the trained cube detector (ONNX). Input: RGB 320×180,
// ImageNet-normalised. Outputs: "heatmaps" [1,8,Hh,Ww] (per-corner spatial prob)
// and "globals" [1,15] = [8 vis | 6 faces | 1 present]. Each corner is decoded by
// its heatmap PEAK (argmax + sub-pixel refine) — no centre bias.

import * as ort from "onnxruntime-web";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

const W = 320, H = 180;   // model input (16:9) — must match training IMG_W/IMG_H
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface MLResult {
  corners: { x: number; y: number; v: number; conf: number }[]; // 8, x/y in 0..1
  faces: number[];                                 // 6 probabilities
  edges: [number, number][];                       // 12 cube edges
  present: number;                                 // 0..1 "a cube is in frame"
}

// cube edges: corner index i*4+j*2+k, edge = differ in exactly one bit
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) { const d = a ^ b; if (d === 1 || d === 2 || d === 4) EDGES.push([a, b]); }

export class CubeNet {
  private session: ort.InferenceSession | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private tmp: HTMLCanvasElement | null = null;
  private inputName = "image";

  async load(url = "/models/cube_detector.onnx"): Promise<void> {
    this.session = await ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
    this.inputName = this.session.inputNames[0] ?? "image";
    this.canvas = document.createElement("canvas");
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.tmp = document.createElement("canvas");
  }

  get ready() { return !!this.session; }

  async predict(frame: ImageData): Promise<MLResult | null> {
    if (!this.session || !this.ctx || !this.tmp) return null;
    // put the frame on a temp canvas, then draw scaled into the model input (16:9)
    this.tmp.width = frame.width; this.tmp.height = frame.height;
    this.tmp.getContext("2d")!.putImageData(frame, 0, 0);
    this.ctx.drawImage(this.tmp, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;

    // CHW, normalised
    const data = new Float32Array(3 * W * H);
    const plane = W * H;
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      data[p] = (px[i] / 255 - MEAN[0]) / STD[0];
      data[plane + p] = (px[i + 1] / 255 - MEAN[1]) / STD[1];
      data[2 * plane + p] = (px[i + 2] / 255 - MEAN[2]) / STD[2];
    }
    const tensor = new ort.Tensor("float32", data, [1, 3, H, W]);
    const out = await this.session.run({ [this.inputName]: tensor });
    const hmT = out["heatmaps"], gT = out["globals"];
    const hm = hmT.data as Float32Array;               // [1,8,Hh,Ww]
    const g = gT.data as Float32Array;                 // [1,15]
    const Hh = hmT.dims[2] as number, Ww = hmT.dims[3] as number;
    const hmPlane = Hh * Ww;

    // decode each corner by the PEAK of its heatmap (argmax + sub-pixel refine)
    const corners = [];
    for (let c = 0; c < 8; c++) {
      const base = c * hmPlane;
      let peak = -1, pr = 0, pc = 0;
      for (let r = 0; r < Hh; r++) for (let k = 0; k < Ww; k++) {
        const val = hm[base + r * Ww + k];
        if (val > peak) { peak = val; pr = r; pc = k; }
      }
      // weighted centroid in a ±2 window around the peak → sub-cell precision
      let sw = 0, sr = 0, sc = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dk = -2; dk <= 2; dk++) {
        const r = pr + dr, k = pc + dk;
        if (r < 0 || r >= Hh || k < 0 || k >= Ww) continue;
        const w = hm[base + r * Ww + k];
        sw += w; sr += w * r; sc += w * k;
      }
      const rr = sw > 0 ? sr / sw : pr, kk = sw > 0 ? sc / sw : pc;
      corners.push({ x: kk / (Ww - 1), y: rr / (Hh - 1), v: g[c], conf: peak });
    }
    const faces = Array.from(g.slice(8, 14));
    const present = g[14];
    return { corners, faces, edges: EDGES, present };
  }
}
