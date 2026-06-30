// Browser inference for the trained cube detector (ONNX). Mirrors training:
// RGB 256×256, ImageNet-normalised → pred[30] = [16 coords | 8 vis | 6 faces].

import * as ort from "onnxruntime-web";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

const SIZE = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface MLResult {
  corners: { x: number; y: number; v: number }[]; // 8, x/y in 0..1
  faces: number[];                                 // 6 probabilities
  edges: [number, number][];                       // 12 cube edges
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
  private outputName = "pred";

  async load(url = "/models/cube_detector.onnx"): Promise<void> {
    this.session = await ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
    this.inputName = this.session.inputNames[0] ?? "image";
    this.outputName = this.session.outputNames[0] ?? "pred";
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.tmp = document.createElement("canvas");
  }

  get ready() { return !!this.session; }

  async predict(frame: ImageData): Promise<MLResult | null> {
    if (!this.session || !this.ctx || !this.tmp) return null;
    // put the frame on a temp canvas, then draw scaled into 256×256
    this.tmp.width = frame.width; this.tmp.height = frame.height;
    this.tmp.getContext("2d")!.putImageData(frame, 0, 0);
    this.ctx.drawImage(this.tmp, 0, 0, SIZE, SIZE);
    const px = this.ctx.getImageData(0, 0, SIZE, SIZE).data;

    // CHW, normalised
    const data = new Float32Array(3 * SIZE * SIZE);
    const plane = SIZE * SIZE;
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      data[p] = (px[i] / 255 - MEAN[0]) / STD[0];
      data[plane + p] = (px[i + 1] / 255 - MEAN[1]) / STD[1];
      data[2 * plane + p] = (px[i + 2] / 255 - MEAN[2]) / STD[2];
    }
    const tensor = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
    const out = await this.session.run({ [this.inputName]: tensor });
    const pred = out[this.outputName].data as Float32Array; // [30]

    const corners = [];
    for (let i = 0; i < 8; i++) corners.push({ x: pred[i * 2], y: pred[i * 2 + 1], v: pred[16 + i] });
    const faces = Array.from(pred.slice(24, 30));
    return { corners, faces, edges: EDGES };
  }
}
