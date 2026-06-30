// Turns a cube silhouette (convex hull) into candidate face decompositions and
// the signals used to choose between them. The final 1/2/3 decision is made by
// CubeTracker, which smooths these signals across video frames.
//
// A cube projects to a hexagon. We simplify the hull to its corners, then build:
//   • cand1 — one flat face (min-area rectangle).
//   • cand2 — two parallelograms split along the best-supported internal edge.
//   • cand3 — three parallelograms meeting at a shared near-corner.
// Signals: `balance` (area balance of the 3-way split — high ⇒ 3 faces) and
// `sup2` (image-gradient support of the internal edge — high ⇒ ≥2 faces).

import type { Face, Point2 } from "../types";
import {
  dist, centroid, polygonArea, sub, add, variance, pointInPoly,
  dpClosed, topKCorners, minAreaRect,
} from "../utils/geometry";

export interface GradientMap { mag: Float32Array; w: number; h: number; mx: number; }

export interface FrameAnalysis {
  corners: number;
  balance: number;
  sup2: number;
  cand1: Face[];
  cand2: Face[] | null;
  cand3: { faces: Face[]; center: Point2 } | null;
}

export class FaceDecomposer {
  gradient(img: ImageData): GradientMap {
    const w = img.width, h = img.height, d = img.data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const mag = new Float32Array(w * h);
    let mx = 1;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
        const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
        const m = Math.hypot(gx, gy);
        mag[i] = m;
        if (m > mx) mx = m;
      }
    return { mag, w, h, mx };
  }

  analyze(hull: Point2[], grad: GradientMap): FrameAnalysis {
    const rect = minAreaRect(hull);
    const cand1: Face[] = [rect ? rect.corners : (hull.slice(0, 4) as Face)];

    const peri = hull.reduce((s, p, i) => s + dist(p, hull[(i + 1) % hull.length]), 0);
    let P = dpClosed(hull, (0.045 * peri) / 2);
    if (P.length > 6) P = topKCorners(P, 6);
    if (P.length < 6) {
      return { corners: P.length, balance: 0, sup2: 0, cand1, cand2: null, cand3: null };
    }

    const d3 = this.decompose3(P);
    const areas = d3.faces.map((f) => polygonArea(f)).sort((a, b) => a - b);
    const balance = areas[2] ? areas[0] / areas[2] : 0;

    const diags: [number, number][] = [[0, 3], [1, 4], [2, 5]];
    let sup2 = 0, bestDiag = diags[0];
    for (const [i, j] of diags) {
      const su = this.edgeSupport(P[i], P[j], grad);
      if (su > sup2) { sup2 = su; bestDiag = [i, j]; }
    }
    const [i, j] = bestDiag;
    const q1: Point2[] = [], q2: Point2[] = [];
    for (let k = i; k !== j; k = (k + 1) % 6) q1.push(P[k]);
    q1.push(P[j]);
    for (let k = j; k !== i; k = (k + 1) % 6) q2.push(P[k]);
    q2.push(P[i]);

    return {
      corners: P.length,
      balance,
      sup2,
      cand1,
      cand2: q1.length === 4 && q2.length === 4 ? [q1 as Face, q2 as Face] : null,
      cand3: { faces: d3.faces, center: d3.center },
    };
  }

  private decompose3(V: Point2[]): { faces: Face[]; center: Point2 } {
    const phases: number[][] = [[0, 2, 4], [1, 3, 5]];
    let bestC: Point2 | null = null, bestVar = Infinity, bestFar: number[] = [0, 2, 4];
    for (const far of phases) {
      const ests = far.map((f) => sub(add(V[(f + 1) % 6], V[(f + 5) % 6]), V[f]));
      const v = variance(ests), c = centroid(ests);
      if (pointInPoly(c, V) && v < bestVar) { bestVar = v; bestC = c; bestFar = far; }
    }
    const C = bestC ?? centroid(V);
    const faces = bestFar.map((f) => [V[f], V[(f + 1) % 6], C, V[(f + 5) % 6]] as Face);
    return { faces, center: C };
  }

  private edgeSupport(a: Point2, b: Point2, G: GradientMap, trim = 0.18): number {
    const N = 40;
    let hit = 0, cnt = 0;
    for (let t = trim; t <= 1 - trim; t += (1 - 2 * trim) / N) {
      const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
      let best = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 1 || yy < 1 || xx >= G.w - 1 || yy >= G.h - 1) continue;
          const v = G.mag[yy * G.w + xx];
          if (v > best) best = v;
        }
      cnt++;
      if (best > G.mx * 0.2) hit++;
    }
    return cnt ? hit / cnt : 0;
  }
}
