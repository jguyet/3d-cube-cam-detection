// Cube pose from the sticker shapes — face-segmented by orientation.
//
// Stickers on the SAME cube face share the same quad orientation, so grouping
// the shapes by angle segments them into faces (1, 2 or 3 groups). The dominant
// face's stickers form a clean 3×3 lattice; its two grid edges are two cube
// edges, and the orthographic third (depth) edge completes a true cube — sized
// exactly from the stickers (no silhouette/hull rescaling) and placed on the
// detected face. Smoothed across frames so it settles instead of jittering.

import type { Point2 } from "../types";
import type { Shape } from "./ShapeDetector";

export interface ShapePose {
  corners: Point2[];          // 8 cube corners: front 0-3, back 4-7
  edges: [number, number][];  // 12 edges
  faces: number;              // number of orientation groups (≈ visible faces)
}

const EDGES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point2, b: Point2, t: number): Point2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a: Point2, b: Point2): Point2 => ({ x: a.x - b.x, y: a.y - b.y });

const MAX_HOLD = 10; // frames to keep showing the last pose through detection gaps

export class CubePoseFromShapes {
  private smoothed: Point2[] | null = null;
  private misses = 0;

  fit(shapes: Shape[], _hull?: Point2[]): ShapePose | null {
    void _hull;
    if (shapes.length < 2) return this.hold();

    // 1) group shapes by orientation angle → faces
    const groups = this.groupByAngle(shapes);
    if (!groups.length) return this.hold();
    const face = groups.reduce((a, b) => (b.length > a.length ? b : a));

    // 2) the dominant face's stickers → its grid edges u, v
    const cells = this.subdivide(face);
    const lat = this.fitFaceLattice(cells);
    if (!lat) return this.hold();

    // 3) build the face quad (3×3, sized from the stickers) + orthographic depth
    const u = lat.u, v = lat.v;
    const TL = { x: lat.Oc.x - 0.5 * u.x - 0.5 * v.x, y: lat.Oc.y - 0.5 * u.y - 0.5 * v.y };
    const U = { x: 3 * u.x, y: 3 * u.y }, V = { x: 3 * v.x, y: 3 * v.y };
    const EC = this.depthEdge(U, V);
    if (!EC) return this.hold();

    const f0 = TL, f1 = { x: TL.x + U.x, y: TL.y + U.y }, f2 = { x: TL.x + U.x + V.x, y: TL.y + U.y + V.y }, f3 = { x: TL.x + V.x, y: TL.y + V.y };
    const bk = (p: Point2): Point2 => ({ x: p.x + EC.x, y: p.y + EC.y });
    const corners = [f0, f1, f2, f3, bk(f0), bk(f1), bk(f2), bk(f3)];

    // 4) temporal smoothing + memory
    this.misses = 0;
    if (!this.smoothed || this.smoothed.length !== 8) this.smoothed = corners;
    else this.smoothed = this.smoothed.map((p, i) => lerp(p, corners[i], 0.35));

    return { corners: this.smoothed, edges: EDGES, faces: groups.length };
  }

  reset(): void { this.smoothed = null; this.misses = 0; }

  // Keep showing the last good pose through brief detection gaps, then fade.
  private hold(): ShapePose | null {
    if (this.smoothed && this.misses < MAX_HOLD) {
      this.misses++;
      return { corners: this.smoothed, edges: EDGES, faces: 0 };
    }
    this.smoothed = null;
    return null;
  }

  // Group shapes whose quad orientation (edge angle mod 90°) matches.
  private groupByAngle(shapes: Shape[]): Shape[][] {
    const ang = (s: Shape) => {
      const e = sub(s.corners[1], s.corners[0]);
      let a = (Math.atan2(e.y, e.x) * 180) / Math.PI;
      a = ((a % 90) + 90) % 90;
      return a;
    };
    const groups: { a: number; items: Shape[] }[] = [];
    for (const s of shapes) {
      const a = ang(s);
      let placed = false;
      for (const g of groups) {
        let dd = Math.abs(g.a - a); dd = Math.min(dd, 90 - dd);
        if (dd < 12) { g.items.push(s); g.a = (g.a * (g.items.length - 1) + a) / g.items.length; placed = true; break; }
      }
      if (!placed) groups.push({ a, items: [s] });
    }
    return groups.map((g) => g.items);
  }

  // Single-face lattice: 2 grid edges u,v + the (0,0) cell centre.
  private fitFaceLattice(centers: Point2[]) {
    const n = centers.length;
    if (n < 3) return null;
    const nn: number[] = [];
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = 0; j < n; j++) if (i !== j) m = Math.min(m, dist(centers[i], centers[j]));
      nn.push(m === Infinity ? 0 : m);
    }
    const cell = nn.slice().sort((a, b) => a - b)[nn.length >> 1] || 1;
    const steps: { ang: number; len: number }[] = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = centers[j].x - centers[i].x, dy = centers[j].y - centers[i].y;
        const len = Math.hypot(dx, dy);
        if (len < 0.7 * cell || len > 1.25 * cell) continue;
        let a = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (a < 0) a += 180;
        steps.push({ ang: a, len });
      }
    if (steps.length < 2) return null;
    const fams: { ang: number; n: number; lens: number[]; angs: number[] }[] = [];
    for (const s of steps) {
      let placed = false;
      for (const f of fams) {
        let dd = Math.abs(f.ang - s.ang); dd = Math.min(dd, 180 - dd);
        if (dd < 14) { f.lens.push(s.len); f.angs.push(s.ang); f.n++; f.ang = (f.ang * (f.n - 1) + s.ang) / f.n; placed = true; break; }
      }
      if (!placed) fams.push({ ang: s.ang, n: 1, lens: [s.len], angs: [s.ang] });
    }
    fams.sort((a, b) => b.n - a.n);
    if (fams.length < 2) return null;
    const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const toVec = (f: { lens: number[]; angs: number[] }) => {
      const L = med(f.lens), A = (med(f.angs) * Math.PI) / 180;
      return { x: L * Math.cos(A), y: L * Math.sin(A) };
    };
    const two = [toVec(fams[0]), toVec(fams[1])].sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    const [u, v] = two;
    const det = u.x * v.y - u.y * v.x;
    if (Math.abs(det) < 1e-3) return null;
    let cx = 0, cy = 0; for (const c of centers) { cx += c.x; cy += c.y; } cx /= n; cy /= n;
    const coords = centers.map((c) => {
      const dx = c.x - cx, dy = c.y - cy;
      return { i: Math.round((dx * v.y - dy * v.x) / det), j: Math.round((u.x * dy - u.y * dx) / det) };
    });
    let mi = Infinity, mj = Infinity;
    for (const k of coords) { mi = Math.min(mi, k.i); mj = Math.min(mj, k.j); }
    let sumI = 0, sumJ = 0;
    for (const k of coords) { k.i -= mi; k.j -= mj; sumI += k.i; sumJ += k.j; }
    const meanI = sumI / n, meanJ = sumJ / n;
    const Oc = { x: cx - meanI * u.x - meanJ * v.x, y: cy - meanI * u.y - meanJ * v.y };
    return { u, v, Oc };
  }

  private depthEdge(U: Point2, V: Point2): Point2 | null {
    const uu = U.x * U.x + U.y * U.y, vv = V.x * V.x + V.y * V.y;
    const cross = U.x * V.y - U.y * V.x;
    const A = cross * cross, B = -(uu + vv), C = 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A < 1e-9) return null;
    const lim = 1 / Math.max(uu, vv) + 1e-9;
    const x1 = (-B - Math.sqrt(disc)) / (2 * A), x2 = (-B + Math.sqrt(disc)) / (2 * A);
    const x = (x1 > 0 && x1 <= lim) ? x1 : x2;
    if (!(x > 0)) return null;
    const L = 1 / Math.sqrt(x);
    const ax = U.x / L, ay = U.y / L, bx = V.x / L, by = V.y / L;
    const uz = Math.sqrt(Math.max(0, 1 - (ax * ax + ay * ay)));
    let vz = Math.sqrt(Math.max(0, 1 - (bx * bx + by * by)));
    if (ax * bx + ay * by > 0) vz = -vz;
    return { x: L * (ay * vz - uz * by), y: L * (uz * bx - ax * vz) };
  }

  private subdivide(shapes: Shape[]): Point2[] {
    const sides: number[] = [];
    for (const s of shapes) {
      const [tl, tr, br, bl] = s.corners;
      sides.push((dist(tl, tr) + dist(bl, br)) / 2, (dist(tl, bl) + dist(tr, br)) / 2);
    }
    if (!sides.length) return [];
    const sorted = sides.slice().sort((a, b) => a - b);
    const unit = sorted[Math.floor(sorted.length * 0.15)] || 1;
    const cells: Point2[] = [];
    for (const s of shapes) {
      const [tl, tr, br, bl] = s.corners;
      const wSide = (dist(tl, tr) + dist(bl, br)) / 2;
      const hSide = (dist(tl, bl) + dist(tr, br)) / 2;
      const nc = Math.max(1, Math.round(wSide / unit));
      const nr = Math.max(1, Math.round(hSide / unit));
      for (let a = 0; a < nc; a++)
        for (let b = 0; b < nr; b++) {
          const top = lerp(tl, tr, (a + 0.5) / nc), bot = lerp(bl, br, (a + 0.5) / nc);
          cells.push(lerp(top, bot, (b + 0.5) / nr));
        }
    }
    return cells;
  }
}
