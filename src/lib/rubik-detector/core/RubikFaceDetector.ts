// Per-frame analysis (pure JS): ImageData → saturation silhouette → candidate
// face decompositions + decision signals. The 1/2/3 decision is left to
// CubeTracker, which smooths these across video frames.

import type { FrameResult } from "../types";
import { Silhouette } from "./Silhouette";
import { FaceDecomposer } from "./FaceDecomposer";

export class RubikFaceDetector {
  private silhouette = new Silhouette();
  private decomposer = new FaceDecomposer();

  process(image: ImageData): FrameResult {
    const sil = this.silhouette.detect(image);
    if (!sil.hull) {
      return { hull: null, fillFrac: 0, corners: 0, balance: 0, sup2: 0, cand1: [], cand2: null, cand3: null };
    }
    const grad = this.decomposer.gradient(image);
    const a = this.decomposer.analyze(sil.hull, grad);
    return {
      hull: sil.hull,
      fillFrac: sil.fillFrac,
      corners: a.corners,
      balance: a.balance,
      sup2: a.sup2,
      cand1: a.cand1,
      cand2: a.cand2,
      cand3: a.cand3,
    };
  }

  dispose(): void {}
}
