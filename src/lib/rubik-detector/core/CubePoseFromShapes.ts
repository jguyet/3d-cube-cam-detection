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

    // 1) group shapes by orientation angle → face candidates
    const groups = this.groupByAngle(shapes);
    if (!groups.length) return this.hold();

    // 2) score every group as a face; the most face-like (compact filled 3×3,
    //    stray quads rejected) wins — NOT merely the group with the most quads.
    let best: ReturnType<CubePoseFromShapes["buildFace"]> = null;
    for (const g of groups) {
      const cand = this.buildFace(g);
      if (cand && (!best || cand.score > best.score)) best = cand;
    }
    if (!best) return this.hold();

    // 3) build the face quad (3×3, sized from the stickers) + orthographic depth
    const u = best.u, v = best.v;
    const TL = { x: best.Oc.x - 0.5 * u.x - 0.5 * v.x, y: best.Oc.y - 0.5 * u.y - 0.5 * v.y };
    const U = { x: 3 * u.x, y: 3 * u.y }, V = { x: 3 * v.x, y: 3 * v.y };
    const EC = this.depthEdge(U, V);
    if (!EC) return this.hold();

    // sanity gate: reject a frame whose face size jumps wildly vs the held pose
    if (this.smoothed) {
      const w = Math.hypot(U.x, U.y), pw = dist(this.smoothed[0], this.smoothed[1]);
      if (pw > 1 && (w < 0.4 * pw || w > 2.5 * pw)) return this.hold();
    }

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
      return { i: Math.round((dx * v.y - dy * v.x) / det), j: Math.round((u.x * dy - u.y * dx) / det), p: c };
    });
    let mi = Infinity, mj = Infinity;
    for (const k of coords) { mi = Math.min(mi, k.i); mj = Math.min(mj, k.j); }
    for (const k of coords) { k.i -= mi; k.j -= mj; }
    return { u, v, coords };
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

  // One angle-group → a scored face candidate. Robust unit = median of each
  // quad's SHORTER side (one sticker). Reject strays (edge slivers, blocks
  // bigger than 3 cells), subdivide survivors into unit cells, fit the lattice,
  // snap to the most-filled compact 3×3 window, and take the origin from the
  // in-window cells only — so a stray quad can neither size nor move the face.
  private buildFace(shapes: Shape[]): { u: Point2; v: Point2; Oc: Point2; score: number } | null {
    const mins: number[] = [];
    for (const s of shapes) {
      const [tl, tr, br, bl] = s.corners;
      const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2;
      mins.push(Math.min(w, h));
    }
    if (!mins.length) return null;
    const unit = mins.slice().sort((a, b) => a - b)[mins.length >> 1] || 1; // one sticker

    const cells: Point2[] = [];
    for (const s of shapes) {
      const [tl, tr, br, bl] = s.corners;
      const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2;
      const lo = Math.min(w, h), hi = Math.max(w, h);
      if (hi / lo > 3.4) continue;       // stray: aspect beyond a 3×1 merge (edge sliver)
      if (lo < 0.6 * unit) continue;     // stray: thinner than a cell
      const nc = Math.max(1, Math.round(w / unit)), nr = Math.max(1, Math.round(h / unit));
      if (nc > 3 || nr > 3) continue;    // stray: a face block spans ≤ 3 cells
      for (let a = 0; a < nc; a++)
        for (let b = 0; b < nr; b++) {
          const top = lerp(tl, tr, (a + 0.5) / nc), bot = lerp(bl, br, (a + 0.5) / nc);
          cells.push(lerp(top, bot, (b + 0.5) / nr));
        }
    }
    if (cells.length < 3) return null;

    const lat = this.fitFaceLattice(cells);
    if (!lat) return null;
    const { u, v, coords } = lat;

    // slide a 3×3 window to maximise distinct filled cells
    let oi = 0, oj = 0, filled = 0;
    const maxI = Math.max(...coords.map((c) => c.i)), maxJ = Math.max(...coords.map((c) => c.j));
    for (let i = 0; i <= Math.max(0, maxI - 2); i++)
      for (let j = 0; j <= Math.max(0, maxJ - 2); j++) {
        const seen = new Set<number>();
        for (const c of coords)
          if (c.i >= i && c.i <= i + 2 && c.j >= j && c.j <= j + 2) seen.add((c.i - i) * 3 + (c.j - j));
        if (seen.size > filled) { filled = seen.size; oi = i; oj = j; }
      }

    // origin from in-window cells only (least-squares of TL cell centre)
    let n = 0, sx = 0, sy = 0;
    for (const c of coords)
      if (c.i >= oi && c.i <= oi + 2 && c.j >= oj && c.j <= oj + 2) {
        sx += c.p.x - (c.i - oi) * u.x - (c.j - oj) * v.x;
        sy += c.p.y - (c.i - oi) * u.y - (c.j - oj) * v.y; n++;
      }
    if (n < 3) return null;
    const Oc = { x: sx / n, y: sy / n };
    const score = filled / 9 - 0.5 * (coords.length - n) / 9; // full grid, few strays
    return { u, v, Oc, score };
  }
}
