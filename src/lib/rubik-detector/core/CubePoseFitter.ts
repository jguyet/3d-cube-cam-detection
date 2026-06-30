// Fits a rigid 3D cube to the detected silhouette and scores the match.
//
// We search cube orientations, project the cube (orthographic), scale it to the
// silhouette and measure how well the projected cube silhouette overlaps the
// detected one (IoU). When the best overlap clears a threshold, the caller can
// draw the 3D cube wireframe at that pose — "the 3D targeter". A warm start
// from the previous frame keeps it cheap in real time.

import type { Point2 } from "../types";
import { convexHull } from "../utils/geometry";

export interface CubePose {
  corners2d: Point2[];          // 8 projected cube corners
  edges: [number, number][];    // 12 cube edges (indices into corners2d)
  visibleEdge: boolean[];       // per edge: borders a camera-facing face
  score: number;                // silhouette IoU in [0,1]
  azimuth: number;
  elevation: number;
  roll: number;
}

// unit cube corners (±1) and the 12 edges / 6 faces
const CORNERS: number[][] = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push([x, y, z]);
const EDGES: [number, number][] = [];
for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
  let diff = 0;
  for (let k = 0; k < 3; k++) if (CORNERS[i][k] !== CORNERS[j][k]) diff++;
  if (diff === 1) EDGES.push([i, j]);
}
const FACES: { n: number[]; idx: number[] }[] = ([
  [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0],
] as number[][]).map((n) => ({
  n,
  idx: CORNERS.map((c, i) => (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] > 0 ? i : -1)).filter((i) => i >= 0),
}));

function rot(a: number, e: number, r: number): number[][] {
  const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e), cr = Math.cos(r), sr = Math.sin(r);
  const Ry = [[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]];
  const Rx = [[1, 0, 0], [0, ce, -se], [0, se, ce]];
  const Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  const mul = (A: number[][], B: number[][]) =>
    A.map((row) => B[0].map((_, j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  return mul(Rz, mul(Rx, Ry));
}

const DEG = Math.PI / 180;

export class CubePoseFitter {
  private prev: { a: number; e: number; r: number } | null = null;

  fit(hull: Point2[], w: number, h: number): CubePose | null {
    if (!hull || hull.length < 3) { this.prev = null; return null; }

    // centroid + radius of the detected silhouette
    let cx = 0, cy = 0;
    for (const p of hull) { cx += p.x; cy += p.y; }
    cx /= hull.length; cy /= hull.length;
    let rad = 0;
    for (const p of hull) rad = Math.max(rad, Math.hypot(p.x - cx, p.y - cy));

    // low-res raster of the detected silhouette (fixed grid for IoU)
    const GW = 64, GH = Math.max(8, Math.round((GW * h) / w));
    const sx = GW / w, sy = GH / h;
    const target = fillConvex(hull.map((p) => ({ x: p.x * sx, y: p.y * sy })), GW, GH);

    const evalAngles = (a: number, e: number, r: number) => {
      const R = rot(a * DEG, e * DEG, r * DEG);
      const pr = CORNERS.map((c) => ({
        x: R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2],
        y: R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2],
      }));
      let prad = 0;
      for (const p of pr) prad = Math.max(prad, Math.hypot(p.x, p.y));
      const s = rad / (prad || 1);
      const proj2d = pr.map((p) => ({ x: cx + p.x * s, y: cy + p.y * s }));
      const sil = convexHull(proj2d.slice());
      const grid = fillConvex(sil.map((p) => ({ x: p.x * sx, y: p.y * sy })), GW, GH);
      return { iou: iou(grid, target), proj2d };
    };

    // coarse search (or local refine around the previous pose), then refine
    let best = { a: 0, e: 0, r: 0, iou: -1, proj2d: [] as Point2[] };
    const tryAngles = (a: number, e: number, r: number) => {
      const aa = ((a % 90) + 90) % 90, ee = Math.max(0, Math.min(75, e)), rr = ((r % 90) + 90) % 90;
      const res = evalAngles(aa, ee, rr);
      if (res.iou > best.iou) best = { a: aa, e: ee, r: rr, iou: res.iou, proj2d: res.proj2d };
    };

    if (this.prev) {
      for (let da = -16; da <= 16; da += 8)
        for (let de = -16; de <= 16; de += 8)
          for (let dr = -16; dr <= 16; dr += 8)
            tryAngles(this.prev.a + da, this.prev.e + de, this.prev.r + dr);
    }
    if (!this.prev || best.iou < 0.6) {
      for (let a = 0; a < 90; a += 15)
        for (let e = 0; e <= 70; e += 14)
          for (let r = 0; r < 90; r += 15)
            tryAngles(a, e, r);
    }
    // fine refine around the best
    const a0 = best.a, e0 = best.e, r0 = best.r;
    for (let da = -6; da <= 6; da += 3)
      for (let de = -6; de <= 6; de += 3)
        for (let dr = -6; dr <= 6; dr += 3)
          tryAngles(a0 + da, e0 + de, r0 + dr);

    this.prev = { a: best.a, e: best.e, r: best.r };

    const R = rot(best.a * DEG, best.e * DEG, best.r * DEG);
    const visibleFace = FACES.map((f) => R[2][0] * f.n[0] + R[2][1] * f.n[1] + R[2][2] * f.n[2] > 0.02);
    const visibleEdge = EDGES.map(([i, j]) =>
      FACES.some((f, fi) => visibleFace[fi] && f.idx.includes(i) && f.idx.includes(j)),
    );

    return {
      corners2d: best.proj2d,
      edges: EDGES,
      visibleEdge,
      score: best.iou,
      azimuth: best.a,
      elevation: best.e,
      roll: best.r,
    };
  }

  reset(): void { this.prev = null; }
}

// Scanline-fill a convex polygon into a GW×GH binary grid.
function fillConvex(poly: Point2[], GW: number, GH: number): Uint8Array {
  const grid = new Uint8Array(GW * GH);
  if (poly.length < 3) return grid;
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(GH - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    let xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const t = (y - a.y) / (b.y - a.y);
        const x = a.x + t * (b.x - a.x);
        xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      }
    }
    if (xmin > xmax) continue;
    const xa = Math.max(0, Math.floor(xmin)), xb = Math.min(GW - 1, Math.ceil(xmax));
    for (let x = xa; x <= xb; x++) grid[y * GW + x] = 1;
  }
  return grid;
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] | b[i]) uni++; if (a[i] & b[i]) inter++; }
  return uni ? inter / uni : 0;
}
