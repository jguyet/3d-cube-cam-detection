// ============================================================================
// cubePoseFromStickers — exact 3D Rubik's-cube pose from detected 2D sticker quads
//
// SYNTHESIS of five designs (best ideas per the reviewers):
//   * FACE SEPARATION by COPLANARITY / shape gate, never by orientation. Each
//     candidate neighbour's quad is rectified through a reference sticker's local
//     homography; a cube FOLD shears the quad so it fails the "clean unit cell"
//     gate. Separates the (1..3) faces even where they touch at the shared corner
//     and on near-level / equatorial hand-held views where edge-angle clustering
//     collapses.                                               (Designs 2 & 5)
//   * PER-FACE HOMOGRAPHY fit from sticker CENTRES ONLY whenever >=4 centres span
//     both grid axes: a centre maps EXACTLY to (col+0.5,row+0.5) independent of the
//     sticker/gap ratio, so the fit is the exact projective map and extrapolates the
//     face boundary with ZERO gap bias.                        (Design 3)
//   * GRID-ANCHOR offset search resolves the one-cell ambiguity when an entire outer
//     sticker row/column is occluded, by making shared edges between faces coincide
//     (with a no-shift bias so pixel noise cannot flip the choice).  (Design 5)
//   * FUSION by ONE global projective-camera resection (normalised DLT) over all
//     gap-independent correspondences of the 2..3 faces, then reproject the 8 ideal
//     cube corners. JOINTLY constrains the hidden/far corners instead of the fragile
//     per-corner vanishing-point intersection every analytic design admits blows up;
//     symmetry-invariance means only labelling CONSISTENCY is needed. (Design 2)
//   * DUAL self-validation: reprojection-RMS gate (Design 2) AND cube-prior
//     consistency — each of the 3 parallel-edge groups must concur at a vanishing
//     point (Design 3). Return null rather than emit a wrong cube.
//   * SINGLE FACE: recover the 4 face corners exactly, then estimate depth by
//     decomposing the face homography with an assumed pinhole and extruding one cube
//     edge along the face normal. Explicitly approximate, capped low confidence.
//                                                              (Designs 1 & 2)
//
// Pure TypeScript, no external dependencies. Deterministic. ~1-3 ms/frame steady.
// ============================================================================

// ---- Given types (only Point2 / Shape are provided by the caller) ----------
export type Point2 = { x: number; y: number };
export interface Shape {
  corners: [Point2, Point2, Point2, Point2]; // one sticker quad, ordered TL,TR,BR,BL
  center: Point2;
  area: number;
  fill: number;
}
export interface CubePose {
  corners: Point2[];         // 8 cube corners projected to 2D (order documented below)
  edges: [number, number][]; // 12 cube edges as index pairs into corners
  faces: number;             // number of visible faces detected (1..3)
  confidence: number;        // 0..1
  pose?: Pose3D;             // R,t,f of the dominant face → caller can quaternion-filter
}

type Mat = number[][];
type Vec = number[];
type Vec3 = [number, number, number];

// ============================================================================
// OUTPUT CONTRACT — corner order and edge list
// ----------------------------------------------------------------------------
// The 8 corners are the projection of an ideal cube modelled on [0,3]^3 (three
// "sticker units" per edge). Index = the model coordinate triple:
//   0:(0,0,0)  1:(3,0,0)  2:(3,3,0)  3:(0,3,0)   <- the z=0 face ("bottom" ring)
//   4:(0,0,3)  5:(3,0,3)  6:(3,3,3)  7:(0,3,3)   <- the z=3 face ("top" ring)
// Ring 0-1-2-3 and ring 4-5-6-7 are the two opposite faces; verticals 0-4,1-5,
// 2-6,3-7 connect them. A cube is symmetric under its rotation group and the DLT
// fits a FULL projective camera, so which physical face maps to which index does
// not change the reprojected pixels — only the labelling's internal consistency
// matters (this is what makes the pipeline robust). For a 1-face result the ring
// 0-1-2-3 is the exactly-recovered visible face and ring 4-7 is the estimated
// (low-confidence) depth extrusion.
// ============================================================================
const CUBE_CORNERS: Vec[] = [
  [0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0],
  [0, 0, 3], [3, 0, 3], [3, 3, 3], [0, 3, 3],
];
const CUBE_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom ring
  [4, 5], [5, 6], [6, 7], [7, 4], // top ring
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];
// The 12 edges split into 3 groups of 4 PARALLEL cube edges (used by the cube
// consistency prior: each group must concur at one vanishing point).
const EDGE_GROUPS: [number, number][][] = [
  [[0, 1], [3, 2], [4, 5], [7, 6]], // x-direction
  [[0, 3], [1, 2], [4, 7], [5, 6]], // y-direction
  [[0, 4], [1, 5], [2, 6], [3, 7]], // z-direction
];

// ---------------------------------------------------------------- linear algebra
// Symmetric-matrix eigendecomposition (cyclic Jacobi). Compact, no deps.
function jacobiEigen(A0: Mat): { values: Vec; vectors: Mat } {
  const n = A0.length;
  const a = A0.map((r) => r.slice());
  const v: Mat = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-20) continue;
        const phi = 0.5 * Math.atan2(2 * apq, a[q][q] - a[p][p]);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
        for (let k = 0; k < n; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
        for (let k = 0; k < n; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}
// eigenvector of the smallest eigenvalue of a symmetric matrix (= homogeneous LS)
function nullVector(ATA: Mat): Vec {
  const { values, vectors } = jacobiEigen(ATA);
  let mi = 0;
  for (let i = 1; i < values.length; i++) if (values[i] < values[mi]) mi = i;
  return vectors.map((r) => r[mi]);
}
function matMul(A: Mat, B: Mat): Mat {
  const r = A.length, c = B[0].length, k = B.length;
  const out: Mat = Array.from({ length: r }, () => new Array(c).fill(0));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) { let s = 0; for (let t = 0; t < k; t++) s += A[i][t] * B[t][j]; out[i][j] = s; }
  return out;
}
function invert3(m: Mat): Mat | null {
  const a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const id = 1 / det;
  return [
    [A * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [B * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [C * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}
// Hartley isotropic normalisation (2D / 3D) for well-conditioned DLT.
function norm2(pts: Point2[]): { T: Mat; Tinv: Mat; pts: Point2[] } {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return {
    T: [[s, 0, -s * cx], [0, s, -s * cy], [0, 0, 1]],
    Tinv: [[1 / s, 0, cx], [0, 1 / s, cy], [0, 0, 1]],
    pts: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}
function norm3(pts: Vec[]): { U: Mat; pts: Vec[] } {
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= pts.length; cy /= pts.length; cz /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
  d /= pts.length;
  const s = d > 1e-9 ? Math.sqrt(3) / d : 1;
  return {
    U: [[s, 0, 0, -s * cx], [0, s, 0, -s * cy], [0, 0, s, -s * cz], [0, 0, 0, 1]],
    pts: pts.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s, (p[2] - cz) * s]),
  };
}
// homography src(2D) -> dst(2D) by normalised DLT (needs >=4 correspondences)
function homographyDLT(src: Point2[], dst: Point2[]): Mat | null {
  if (src.length < 4) return null;
  const ns = norm2(src), nd = norm2(dst);
  const ATA: Mat = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const add = (row: Vec) => { for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ATA[i][j] += row[i] * row[j]; };
  for (let i = 0; i < src.length; i++) {
    const X = ns.pts[i].x, Y = ns.pts[i].y, x = nd.pts[i].x, y = nd.pts[i].y;
    add([-X, -Y, -1, 0, 0, 0, x * X, x * Y, x]);
    add([0, 0, 0, -X, -Y, -1, y * X, y * Y, y]);
  }
  const h = nullVector(ATA);
  const Hn: Mat = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
  const H = matMul(matMul(nd.Tinv, Hn), ns.T);
  const nrm = H[2][2];
  if (Math.abs(nrm) > 1e-12) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[i][j] /= nrm;
  return H;
}
function applyH(H: Mat, p: Point2): Point2 {
  const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
  return {
    x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
    y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
  };
}
// projective camera resection: 3x4 P with P*[X;1] ~ x (needs >=6 non-coplanar pts)
function cameraDLT(X3: Vec[], x2: Point2[]): Mat | null {
  if (X3.length < 6) return null;
  const n3 = norm3(X3), n2 = norm2(x2);
  const ATA: Mat = Array.from({ length: 12 }, () => new Array(12).fill(0));
  const add = (row: Vec) => { for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) ATA[i][j] += row[i] * row[j]; };
  for (let i = 0; i < X3.length; i++) {
    const X = n3.pts[i][0], Y = n3.pts[i][1], Z = n3.pts[i][2], x = n2.pts[i].x, y = n2.pts[i].y;
    add([-X, -Y, -Z, -1, 0, 0, 0, 0, x * X, x * Y, x * Z, x]);
    add([0, 0, 0, 0, -X, -Y, -Z, -1, y * X, y * Y, y * Z, y]);
  }
  const p = nullVector(ATA);
  const Pn: Mat = [[p[0], p[1], p[2], p[3]], [p[4], p[5], p[6], p[7]], [p[8], p[9], p[10], p[11]]];
  return matMul(matMul(n2.Tinv, Pn), n3.U);
}
function projectP(P: Mat, X: Vec): Point2 {
  const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
  return {
    x: (P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w,
    y: (P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w,
  };
}
function dist(a: Point2, b: Point2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function angleMod180(v: Point2): number { let a = Math.atan2(v.y, v.x); if (a < 0) a += Math.PI; return a; }
function angDiff180(a: number, b: number): number { let d = Math.abs(a - b); if (d > Math.PI / 2) d = Math.PI - d; return d; }
function cross3(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

// least-squares intersection of >=2 homogeneous image lines (graceful at infinity)
function meetLS(lines: Vec3[]): Point2 | null {
  let saa = 0, sab = 0, sbb = 0, sac = 0, sbc = 0;
  for (const l of lines) {
    const nrm = Math.hypot(l[0], l[1]);
    if (nrm < 1e-12) continue;
    const a = l[0] / nrm, b = l[1] / nrm, c = l[2] / nrm;
    saa += a * a; sab += a * b; sbb += b * b; sac += a * c; sbc += b * c;
  }
  const det = saa * sbb - sab * sab;
  if (Math.abs(det) < 1e-12) return null;
  return { x: -(sbb * sac - sab * sbc) / det, y: -(saa * sbc - sab * sac) / det };
}
// Cube-prior consistency: the 3 groups of 4 parallel edges must each concur at a
// vanishing point. Score in [0,1] (1 = perfect). Guards against a mislabelled or
// numerically-blown assembly. (Design 3.)
function cubeConsistency(c: Point2[]): number {
  const lens: number[] = [];
  for (const g of EDGE_GROUPS) for (const [i, j] of g) lens.push(dist(c[i], c[j]));
  lens.sort((a, b) => a - b);
  const scale = lens[lens.length >> 1] || 0;
  if (!(scale > 1e-3)) return 0;
  let worst = 0;
  for (const g of EDGE_GROUPS) {
    const lines: Vec3[] = [];
    for (const [i, j] of g) {
      if (dist(c[i], c[j]) < 1e-6) return 0;
      lines.push(cross3([c[i].x, c[i].y, 1], [c[j].x, c[j].y, 1]));
    }
    const vp = meetLS(lines);
    if (!vp) continue; // near-parallel (VP at infinity) -> treated as consistent
    let m = 0;
    for (const l of lines) {
      const n = Math.hypot(l[0], l[1]) || 1;
      m += Math.abs((l[0] * vp.x + l[1] * vp.y + l[2]) / n);
    }
    worst = Math.max(worst, m / g.length / scale);
  }
  return Math.max(0, 1 - worst / 0.25);
}

// ---------------------------------------------------------------- face grouping
interface FaceSticker { shape: Shape; idx: number; gx: number; gy: number }
interface Face { stickers: FaceSticker[]; H: Mat; cornersImg: Point2[] }
interface Item { s: Shape; i: number; loc: { Hi: Mat; side: number } | null }
interface Edge { v: number; sx: number; sy: number }

// Assumed sticker gap fraction (used only for the face-frame fold gate tolerance).
const GAP = 0.12;
// The per-sticker local homography maps the sticker quad to the unit square (±0.5).
// A same-face neighbour then lands on an axis at distance = pitch/sticker-width, which
// ranges ~1.0 (no gap) .. ~2.0 (fat gap). We therefore accept a 4-neighbour by AXIS
// ALIGNMENT + distance range (gap-agnostic) rather than rounding to exactly 1.
const UNIT_CELL: Point2[] = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }];

// Fit a face's grid->image homography. CENTRES-ONLY when >=4 stickers span both
// axes (Design 3): a centre maps exactly to (gx+0.5,gy+0.5) independent of the
// gap, so the fit is the exact projective map with zero gap bias. For sparse /
// single-line faces fall back to also using the sticker corners (mapped to their
// full cell corners), matched to a reference homography when available.
function fitFaceH(stickers: FaceSticker[], Href: Mat | null): Mat | null {
  const distinctX = new Set(stickers.map((s) => s.gx)).size;
  const distinctY = new Set(stickers.map((s) => s.gy)).size;
  const centresOnly = stickers.length >= 4 && distinctX >= 2 && distinctY >= 2;
  const src: Point2[] = [], dst: Point2[] = [];
  for (const st of stickers) {
    src.push({ x: st.gx + 0.5, y: st.gy + 0.5 }); dst.push(st.shape.center);
    if (centresOnly) continue;
    const gc: Point2[] = [
      { x: st.gx, y: st.gy }, { x: st.gx + 1, y: st.gy },
      { x: st.gx + 1, y: st.gy + 1 }, { x: st.gx, y: st.gy + 1 },
    ];
    const cs = st.shape.corners;
    if (Href) {
      const pred = gc.map((g) => applyH(Href, g));
      const taken = [false, false, false, false];
      for (let ci = 0; ci < 4; ci++) {
        let bj = -1, bd = Infinity;
        for (let j = 0; j < 4; j++) { if (taken[j]) continue; const d = dist(pred[j], cs[ci]); if (d < bd) { bd = d; bj = j; } }
        taken[bj] = true; src.push(gc[bj]); dst.push(cs[ci]);
      }
    } else {
      for (let ci = 0; ci < 4; ci++) { src.push(gc[ci]); dst.push(cs[ci]); }
    }
  }
  return homographyDLT(src, dst);
}
// sticker side length from its corner geometry (robust — does not trust `area`)
function stickerSide(s: Shape): number {
  const c = s.corners;
  const e = (dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]) + dist(c[3], c[0])) * 0.25;
  return e > 1e-6 ? e : Math.sqrt(Math.max(s.area, 1));
}
// per-sticker LOCAL homography (unit cell -> this sticker's image corners)
function stickerLocal(s: Shape): { Hi: Mat; side: number } | null {
  const H = homographyDLT(UNIT_CELL, s.corners);
  if (!H) return null;
  const Hi = invert3(H);
  if (!Hi) return null;
  return { Hi, side: stickerSide(s) };
}
// the four face-boundary corners in the image, grid units 0..3 (cube face corners)
function faceCorners(H: Mat): Point2[] {
  return [
    applyH(H, { x: 0, y: 0 }), applyH(H, { x: 3, y: 0 }),
    applyH(H, { x: 3, y: 3 }), applyH(H, { x: 0, y: 3 }),
  ];
}

// Group stickers into the (1..3) visible faces via a lattice-neighbour graph whose
// edges are validated by a per-sticker LOCAL-homography SHAPE GATE: A-B exists iff,
// in A's local grid, B sits at an axis 4-neighbour cell AND B's whole quad rectifies
// to a clean axis-aligned unit cell there. A cube fold shears B's quad so the gate
// fails — the three faces separate cleanly even where they touch at the shared cube
// edge, and even on near-level views where orientation clustering collapses.
function extractFaces(shapes: Shape[]): Face[] {
  const items: Item[] = shapes.map((s, i) => ({ s, i, loc: stickerLocal(s) }));
  const n = items.length;
  const adj: Edge[][] = Array.from({ length: n }, () => []);

  const testEdge = (a: number, b: number): { gx: number; gy: number } | null => {
    const A = items[a].loc, Bl = items[b].loc;
    if (!A || !Bl) return null;
    const ar = A.side / Bl.side; if (ar < 0.45 || ar > 2.2) return null;
    // B's centre in A's local (sticker=unit) frame.
    const g = applyH(A.Hi, items[b].s.center);
    const ax = Math.abs(g.x), ay = Math.abs(g.y);
    // Must be an AXIS-ALIGNED 4-neighbour: one coordinate dominant & ~one pitch away,
    // the other near zero. Distance range 0.6..2.4 tolerates any realistic gap.
    let gx = 0, gy = 0;
    if (ax >= ay) {
      if (ax < 0.6 || ax > 2.4 || ay > 0.45 * ax) return null;
      gx = g.x > 0 ? 1 : -1;
    } else {
      if (ay < 0.6 || ay > 2.4 || ax > 0.45 * ay) return null;
      gy = g.y > 0 ? 1 : -1;
    }
    // FOLD GATE (gap-agnostic): rectify B's quad through A's local homography. On the
    // same plane it stays an axis-aligned square (~unit size); a cube fold shears/rotates
    // it. Reject if the rectified quad's edges are skewed off-axis or not square.
    const rc = items[b].s.corners.map((c) => applyH(A.Hi, c));
    const top = { x: rc[1].x - rc[0].x, y: rc[1].y - rc[0].y };
    const lft = { x: rc[3].x - rc[0].x, y: rc[3].y - rc[0].y };
    const wl = Math.hypot(top.x, top.y), hl = Math.hypot(lft.x, lft.y);
    if (wl < 1e-6 || hl < 1e-6) return null;
    const topSkew = Math.abs(top.y) / wl, lftSkew = Math.abs(lft.x) / hl; // 0 = axis-aligned
    if (topSkew > 0.32 || lftSkew > 0.32) return null;      // sheared -> fold
    if (wl < 0.45 || wl > 2.0 || hl < 0.45 || hl > 2.0) return null;
    if (Math.min(wl, hl) / Math.max(wl, hl) < 0.5) return null; // not square -> fold
    return { gx, gy };
  };

  for (let a = 0; a < n; a++) {
    if (!items[a].loc) continue;
    for (let b = a + 1; b < n; b++) {
      if (!items[b].loc) continue;
      const ab = testEdge(a, b), ba = testEdge(b, a);
      if (ab && ba) { adj[a].push({ v: b, sx: ab.gx, sy: ab.gy }); adj[b].push({ v: a, sx: ba.gx, sy: ba.gy }); }
    }
  }

  // connected components -> seed groups
  const comp = new Array(n).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1 || !items[i].loc) continue;
    const stack = [i]; comp[i] = groups.length; const g: number[] = [];
    while (stack.length) { const u = stack.pop() as number; g.push(u); for (const e of adj[u]) if (comp[e.v] === -1) { comp[e.v] = groups.length; stack.push(e.v); } }
    groups.push(g);
  }

  // ITERATIVE extraction: pull the densest 3×3 face out of a (possibly merged 2-3
  // face) cluster, remove its stickers, repeat → separates faces on equatorial views
  // where the fold/orientation cues collapse. This is what enables multi-face pose.
  let faces: Face[] = [];
  let iterativeMulti = false;
  for (const g of groups) {
    if (g.length < 2) continue;
    let remaining = g.slice();
    const nBefore = faces.length;
    for (let iter = 0; iter < 3 && remaining.length >= 4; iter++) {
      const face = assignGrid(remaining, items, adj);
      if (!face || face.stickers.length < 4) break;
      faces.push(face);
      const usedIds = new Set(face.stickers.map((s) => s.idx));
      const next = remaining.filter((u) => !usedIds.has(u));
      if (next.length === remaining.length) break;   // no progress
      remaining = next;
    }
    if (faces.length - nBefore >= 2) iterativeMulti = true;
  }
  if (faces.length === 0) {
    const big = groups.filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0];
    if (big) { const f = assignGrid(big, items, adj); if (f) faces.push(f); }
  }
  // when iterative extraction already SEPARATED faces, return them directly — the
  // re-collection/dedupe below re-absorbs them under near-equatorial homographies.
  if (iterativeMulti) { faces.sort((a, b) => b.stickers.length - a.stickers.length); return faces.slice(0, 3); }
  faces.sort((a, b) => b.stickers.length - a.stickers.length);
  faces = faces.slice(0, 6); // keep extra seeds; re-collection + dedupe prune them

  // Re-collect: the face-level homographies are noise-averaged and far more accurate
  // than any single-sticker frame. Reassign EVERY sticker to its best face+cell —
  // recovers stickers the strict graph dropped, while the shape gate still blocks folds.
  for (let iter = 0; iter < 2 && faces.length > 0; iter++) {
    const His = faces.map((f) => invert3(f.H));
    const buckets: Map<string, { item: Item; err: number; gx: number; gy: number }>[] = faces.map(() => new Map());
    for (const it of items) {
      let best: { fi: number; gx: number; gy: number; tot: number } | null = null;
      for (let fi = 0; fi < faces.length; fi++) {
        const Hi = His[fi]; if (!Hi) continue;
        const gp = applyH(Hi, it.s.center);
        const gx = Math.round(gp.x - 0.5), gy = Math.round(gp.y - 0.5);
        if (gx < 0 || gx > 2 || gy < 0 || gy > 2) continue;
        const pe = Math.hypot(gp.x - (gx + 0.5), gp.y - (gy + 0.5));
        if (pe > 0.42) continue;
        // inner cell corners in the face grid frame (sticker inset by the gap)
        const exp: Point2[] = [
          { x: gx + GAP, y: gy + GAP }, { x: gx + 1 - GAP, y: gy + GAP },
          { x: gx + 1 - GAP, y: gy + 1 - GAP }, { x: gx + GAP, y: gy + 1 - GAP },
        ];
        let se = 0;
        for (const c of it.s.corners) { const lc = applyH(Hi, c); let bd = Infinity; for (const e of exp) bd = Math.min(bd, Math.hypot(lc.x - e.x, lc.y - e.y)); se = Math.max(se, bd); }
        if (se > 0.4) continue;
        const tot = pe + se;
        if (!best || tot < best.tot) best = { fi, gx, gy, tot };
      }
      if (best) {
        const key = best.gx + ',' + best.gy;
        const prev = buckets[best.fi].get(key);
        if (!prev || best.tot < prev.err) buckets[best.fi].set(key, { item: it, err: best.tot, gx: best.gx, gy: best.gy });
      }
    }
    const newFaces: Face[] = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const st: FaceSticker[] = Array.from(buckets[fi].values()).map((bkt) => ({ shape: bkt.item.s, idx: bkt.item.i, gx: bkt.gx, gy: bkt.gy }));
      if (st.length < 3) continue;
      const H = fitFaceH(st, faces[fi].H); if (!H) continue;
      newFaces.push({ stickers: st, H, cornersImg: faceCorners(H) });
    }
    newFaces.sort((a, b) => b.stickers.length - a.stickers.length);
    faces = newFaces;
  }

  // dedupe: a split face re-collected twice (same plane) shares stickers
  const kept: Face[] = [];
  for (const f of faces) {
    const ids = new Set(f.stickers.map((s) => s.idx));
    let dup = false;
    for (const k of kept) {
      let ov = 0; for (const s of k.stickers) if (ids.has(s.idx)) ov++;
      if (ov / Math.min(k.stickers.length, f.stickers.length) > 0.4) { dup = true; break; }
    }
    if (!dup) kept.push(f);
  }
  return kept.slice(0, 3);
}

// assign integer (gx,gy) to a seed group via BFS over stored lattice steps
function assignGrid(groupIdx: number[], items: Item[], adj: Edge[][]): Face | null {
  const coord = new Map<number, { gx: number; gy: number }>();
  coord.set(groupIdx[0], { gx: 0, gy: 0 });
  const q = [groupIdx[0]];
  const inGroup = new Set(groupIdx);
  while (q.length) {
    const u = q.shift() as number;
    const cu = coord.get(u)!;
    for (const e of adj[u]) {
      if (!inGroup.has(e.v) || coord.has(e.v)) continue;
      coord.set(e.v, { gx: cu.gx + e.sx, gy: cu.gy + e.sy });
      q.push(e.v);
    }
  }
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const c of coord.values()) { mnx = Math.min(mnx, c.gx); mny = Math.min(mny, c.gy); mxx = Math.max(mxx, c.gx); mxy = Math.max(mxy, c.gy); }
  // A merged 2-3 face cluster spans >3 cells; extract the DENSEST 3×3 window = one
  // clean face (robust on near-equatorial views where orientation/fold cues fail).
  let bestOx = mnx, bestOy = mny, bestN = -1;
  for (let ox = mnx; ox <= mxx; ox++) for (let oy = mny; oy <= mxy; oy++) {
    let cnt = 0; for (const c of coord.values()) if (c.gx >= ox && c.gx <= ox + 2 && c.gy >= oy && c.gy <= oy + 2) cnt++;
    if (cnt > bestN) { bestN = cnt; bestOx = ox; bestOy = oy; }
  }
  const seen = new Set<string>();
  const stickers: FaceSticker[] = [];
  for (const [u, c] of coord) {
    if (c.gx < bestOx || c.gx > bestOx + 2 || c.gy < bestOy || c.gy > bestOy + 2) continue;
    const gx = c.gx - bestOx, gy = c.gy - bestOy, key = gx + ',' + gy;
    if (seen.has(key)) continue; seen.add(key);
    stickers.push({ shape: items[u].s, idx: items[u].i, gx, gy });
  }
  if (stickers.length < 2) return null;
  const H = fitFaceH(stickers, null);
  if (!H) return null;
  const H2 = fitFaceH(stickers, H) || H; // refine corner assignment
  return { stickers, H: H2, cornersImg: faceCorners(H2) };
}

// GRID-ANCHOR resolution (Design 5). After normalisation each face has gx,gy in
// {0,1,2} with min 0; if an entire outer sticker line was occluded the face spans
// <3 cells and its absolute position is ambiguous by up to a full cell. The
// homography SHAPE is still exact, so for each face we enumerate the few integer
// offsets and pick the global combination whose shared edges between adjacent faces
// best COINCIDE, with a small no-shift bias so pixel noise cannot flip the choice
// but a genuine one-cell misalignment still wins. The chosen offset is baked into
// each sticker's (gx,gy) and the face homography is refit.
function resolveAnchors(faces: Face[], cell: number): void {
  if (faces.length < 2) return;
  const bias = 0.18 * cell;
  // candidate boundary quads per face (grid TRUE coord = current - offset)
  const cand = faces.map((f) => {
    let sx = 0, sy = 0;
    for (const st of f.stickers) { sx = Math.max(sx, st.gx); sy = Math.max(sy, st.gy); }
    const list: { dx: number; dy: number; Q: Point2[]; pen: number }[] = [];
    for (let dx = 0; dx <= 2 - sx; dx++) for (let dy = 0; dy <= 2 - sy; dy++) {
      const Q = [
        applyH(f.H, { x: -dx, y: -dy }), applyH(f.H, { x: 3 - dx, y: -dy }),
        applyH(f.H, { x: 3 - dx, y: 3 - dy }), applyH(f.H, { x: -dx, y: 3 - dy }),
      ];
      list.push({ dx, dy, Q, pen: (dx + dy) * bias });
    }
    return list;
  });
  if (cand.every((l) => l.length === 1)) return; // no ambiguity anywhere
  // best-of-two shared-corner distance between two boundary quads
  const pairDis = (A: Point2[], B: Point2[]): number => {
    const ds: { d: number; a: number; b: number }[] = [];
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) ds.push({ d: dist(A[a], B[b]), a, b });
    ds.sort((x, y) => x.d - y.d);
    const ua = new Set<number>(), ub = new Set<number>();
    let sum = 0, cnt = 0;
    for (const e of ds) { if (ua.has(e.a) || ub.has(e.b)) continue; ua.add(e.a); ub.add(e.b); sum += e.d; if (++cnt >= 2) break; }
    return sum;
  };
  const idx = new Array(faces.length).fill(0);
  let best = Infinity; const bestSel = idx.slice();
  const rec = (fi: number): void => {
    if (fi === faces.length) {
      let sc = 0;
      for (let a = 0; a < faces.length; a++) {
        sc += cand[a][idx[a]].pen;
        for (let b = a + 1; b < faces.length; b++) sc += pairDis(cand[a][idx[a]].Q, cand[b][idx[b]].Q);
      }
      if (sc < best) { best = sc; for (let k = 0; k < idx.length; k++) bestSel[k] = idx[k]; }
      return;
    }
    for (let k = 0; k < cand[fi].length; k++) { idx[fi] = k; rec(fi + 1); }
  };
  rec(0);
  for (let f = 0; f < faces.length; f++) {
    const ch = cand[f][bestSel[f]];
    if (ch.dx === 0 && ch.dy === 0) continue;
    for (const st of faces[f].stickers) { st.gx += ch.dx; st.gy += ch.dy; }
    const H = fitFaceH(faces[f].stickers, faces[f].H);
    if (H) { faces[f].H = H; faces[f].cornersImg = faceCorners(H); }
  }
}

// median sticker side (from corner geometry, gap/area independent)
function medianDiag(shapes: Shape[]): number {
  const d = shapes.map((s) => stickerSide(s)).sort((a, b) => a - b);
  return d[d.length >> 1] || 10;
}

// GLOBAL face separation: each sticker's local homography is a face hypothesis;
// collect the stickers that rectify through it to integer grid cells as clean unit
// squares. Take the biggest such set = one face, remove it, repeat. Robust on the
// merged/equatorial views where the pairwise graph collapses the faces together.
function extractFacesV2(shapes: Shape[]): Face[] {
  const items: Item[] = shapes.map((s, i) => ({ s, i, loc: stickerLocal(s) }));
  const remaining = new Set(items.filter((it) => it.loc).map((it) => it.i));
  const faces: Face[] = [];
  const skewOK = (Hi: Mat, s: Shape): boolean => {
    const rc = s.corners.map((c) => applyH(Hi, c));
    const top = { x: rc[1].x - rc[0].x, y: rc[1].y - rc[0].y };
    const lft = { x: rc[3].x - rc[0].x, y: rc[3].y - rc[0].y };
    const wl = Math.hypot(top.x, top.y), hl = Math.hypot(lft.x, lft.y);
    if (wl < 1e-6 || hl < 1e-6) return false;
    if (Math.abs(top.y) / wl > 0.30 || Math.abs(lft.x) / hl > 0.30) return false;
    return wl >= 0.5 && wl <= 2 && hl >= 0.5 && hl <= 2;
  };
  for (let pass = 0; pass < 3 && remaining.size >= 4; pass++) {
    let best: { i: number; gx: number; gy: number }[] = [];
    for (const seed of remaining) {
      const loc = items[seed].loc; if (!loc) continue;
      const coll: { i: number; gx: number; gy: number }[] = [];
      for (const o of remaining) {
        const g = applyH(loc.Hi, items[o].s.center);
        const gx = Math.round(g.x), gy = Math.round(g.y);
        if (Math.abs(gx) > 2 || Math.abs(gy) > 2) continue;
        if (Math.abs(g.x - gx) > 0.35 || Math.abs(g.y - gy) > 0.35) continue;
        if (o !== seed && !skewOK(loc.Hi, items[o].s)) continue;
        coll.push({ i: o, gx, gy });
      }
      // clip to the densest 3×3 window (dedupe cell collisions)
      let bo = { ox: -2, oy: -2, n: -1 };
      for (let ox = -2; ox <= 0; ox++) for (let oy = -2; oy <= 0; oy++) {
        let c = 0; for (const it of coll) if (it.gx >= ox && it.gx <= ox + 2 && it.gy >= oy && it.gy <= oy + 2) c++;
        if (c > bo.n) bo = { ox, oy, n: c };
      }
      const seen = new Set<string>(); const set: { i: number; gx: number; gy: number }[] = [];
      for (const it of coll) {
        if (it.gx < bo.ox || it.gx > bo.ox + 2 || it.gy < bo.oy || it.gy > bo.oy + 2) continue;
        const key = (it.gx - bo.ox) + ',' + (it.gy - bo.oy); if (seen.has(key)) continue; seen.add(key);
        set.push({ i: it.i, gx: it.gx - bo.ox, gy: it.gy - bo.oy });
      }
      if (set.length > best.length) best = set;
    }
    if (best.length < 4) break;
    const st: FaceSticker[] = best.map((e) => ({ shape: items[e.i].s, idx: e.i, gx: e.gx, gy: e.gy }));
    const Hf = fitFaceH(st, null); if (!Hf) break;
    faces.push({ stickers: st, H: Hf, cornersImg: faceCorners(Hf) });
    for (const e of best) remaining.delete(e.i);
  }
  return faces.slice(0, 3);
}

// ---- pose export for temporal (quaternion) filtering in the caller ----------
// f = fx; fy/cx/cy/s optional full intrinsics (from the multi-face DLT camera
// decomposition); when absent projectPose assumes fy=f, principal at image centre.
export interface Pose3D { R: Mat; t: Vec; f: number; fy?: number; cx?: number; cy?: number; s?: number }

// Clean R,t,f from ONE face's homography (grid[0..3] -> image), so the caller can
// SLERP-filter the pose across frames and reproject a rigid cube (no pixel swim).
function poseFromFaceH(faceH: Mat, W: number, Himg: number): Pose3D | null {
  const f = 1.3 * Math.max(W, Himg), cx = W / 2, cy = Himg / 2;
  const Kinv: Mat = [[1 / f, 0, -cx / f], [0, 1 / f, -cy / f], [0, 0, 1]];
  const Hn = matMul(Kinv, faceH);
  const h1 = [Hn[0][0], Hn[1][0], Hn[2][0]], h2 = [Hn[0][1], Hn[1][1], Hn[2][1]], h3 = [Hn[0][2], Hn[1][2], Hn[2][2]];
  const lam = 2 / (Math.hypot(h1[0], h1[1], h1[2]) + Math.hypot(h2[0], h2[1], h2[2]) + 1e-12);
  let r1 = h1.map((v) => v * lam), r2 = h2.map((v) => v * lam);
  let t = h3.map((v) => v * lam);
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = [r2[0] - d * r1[0], r2[1] - d * r1[1], r2[2] - d * r1[2]];
  const n1 = Math.hypot(r1[0], r1[1], r1[2]) || 1, n2 = Math.hypot(r2[0], r2[1], r2[2]) || 1;
  r1 = r1.map((v) => v / n1); r2 = r2.map((v) => v / n2);
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  if (t[2] < 0) t = t.map((v) => -v);
  if (r3[2] < 0) r3 = r3.map((v) => -v);
  if (!isFinite(t[2]) || t[2] < 1e-6) return null;
  return { R: [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]], t, f };
}

// project the ideal [0,3]^3 cube with a Pose3D → 8 image corners (same order as CubePose)
export function projectPose(p: Pose3D, W: number, Himg: number): Point2[] {
  const fx = p.f, fy = p.fy ?? p.f, cx = p.cx ?? W / 2, cy = p.cy ?? Himg / 2, sk = p.s ?? 0;
  const R = p.R, t = p.t;
  return CUBE_CORNERS.map((X) => {
    const xc = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0];
    const yc = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1];
    const zc = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2] || 1e-9;
    return { x: (fx * xc + sk * yc + cx * zc) / zc, y: (fy * yc + cy * zc) / zc };
  });
}

// Decompose a 3×4 projective camera P = K[R|t] (RQ on the left 3×3 via Givens),
// so the MULTI-FACE resection also yields a filterable {R,t,K} pose that
// reprojects the cube exactly.
function decomposeP(P0: Mat, retried = false): Pose3D | null {
  // Euclidean interpretation needs det(M) > 0 — P is projective (defined up to
  // scale), so flip its sign first if needed. K's diagonal is forced positive
  // below, hence det(R) = det(M)/det(K) = +1 automatically.
  const det3 = (A: Mat) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const P = det3([[P0[0][0], P0[0][1], P0[0][2]], [P0[1][0], P0[1][1], P0[1][2]], [P0[2][0], P0[2][1], P0[2][2]]]) < 0
    ? P0.map((row) => row.map((v) => -v)) : P0;
  const M: Mat = [[P[0][0], P[0][1], P[0][2]], [P[1][0], P[1][1], P[1][2]], [P[2][0], P[2][1], P[2][2]]];
  // Givens 1 (about x): zero M[2][1]
  let d = Math.hypot(M[2][2], M[2][1]); if (d < 1e-12) return null;
  let c = M[2][2] / d, s = M[2][1] / d;
  const Qx: Mat = [[1, 0, 0], [0, c, s], [0, -s, c]];
  const B = matMul(M, Qx);
  // Givens 2 (about y): zero B[2][0]
  d = Math.hypot(B[2][2], B[2][0]); if (d < 1e-12) return null;
  c = B[2][2] / d; s = B[2][0] / d;
  const Qy: Mat = [[c, 0, -s], [0, 1, 0], [s, 0, c]];
  const C = matMul(B, Qy);
  // Givens 3 (about z): zero C[1][0]
  d = Math.hypot(C[1][1], C[1][0]); if (d < 1e-12) return null;
  c = C[1][1] / d; s = C[1][0] / d;
  const Qz: Mat = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  const K = matMul(C, Qz);                       // upper triangular
  // R = Qz^T Qy^T Qx^T
  const tr = (A: Mat): Mat => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  let R = matMul(matMul(tr(Qz), tr(Qy)), tr(Qx));
  // make K diagonal positive (flip matching R rows)
  for (let i = 0; i < 3; i++) if (K[i][i] < 0) { for (let r = 0; r < 3; r++) K[r][i] = -K[r][i]; for (let cc = 0; cc < 3; cc++) R[i][cc] = -R[i][cc]; }
  // normalise K so K[2][2] = 1
  const k22 = K[2][2]; if (Math.abs(k22) < 1e-12) return null;
  for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) K[r][cc] /= k22;
  // t = K^-1 · p4  (K now unit-normalised; account for the k22 scale on p4)
  const Ki = invert3(K); if (!Ki) return null;
  const p4 = [P[0][3] / k22, P[1][3] / k22, P[2][3] / k22];
  let t = [Ki[0][0] * p4[0] + Ki[0][1] * p4[1] + Ki[0][2] * p4[2],
    Ki[1][0] * p4[0] + Ki[1][1] * p4[1] + Ki[1][2] * p4[2],
    Ki[2][0] * p4[0] + Ki[2][1] * p4[1] + Ki[2][2] * p4[2]];
  // If the scene decodes BEHIND the camera (t_z<0), apply D=diag(-1,1,-1): a
  // det=+1 similarity that flips z. R stays a proper rotation; K absorbs the
  // flip as fy→−fy (numerically harmless — projectPose just multiplies).
  if (t[2] < 0) {
    R = [[-R[0][0], -R[0][1], -R[0][2]], [R[1][0], R[1][1], R[1][2]], [-R[2][0], -R[2][1], -R[2][2]]];
    t = [-t[0], t[1], -t[2]];
    K[0][1] = -K[0][1]; K[1][1] = -K[1][1];   // s→−s, fy→−fy (fx, cx, cy unchanged)
  }
  const fx = K[0][0], fy = K[1][1];
  if (!isFinite(fx) || !isFinite(fy) || fx <= 0 || Math.abs(fy) < 1e-6) return null;
  return { R, t, f: fx, fy, cx: K[0][2], cy: K[1][2], s: K[0][1] };
}

export type Quat = [number, number, number, number];
export function matToQuat(R: Mat): Quat {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (R[2][1] - R[1][2]) / s; y = (R[0][2] - R[2][0]) / s; z = (R[1][0] - R[0][1]) / s; }
  else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2; w = (R[2][1] - R[1][2]) / s; x = 0.25 * s; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s; }
  else if (R[1][1] > R[2][2]) { const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2; w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = 0.25 * s; z = (R[1][2] + R[2][1]) / s; }
  else { const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2; w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = 0.25 * s; }
  const n = Math.hypot(w, x, y, z) || 1;
  return [w / n, x / n, y / n, z / n];
}
export function quatToMat(q: Quat): Mat {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}
export function slerp(a: Quat, b: Quat, tt: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b.slice() as Quat;
  if (dot < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) { const r: Quat = [a[0] + (bb[0] - a[0]) * tt, a[1] + (bb[1] - a[1]) * tt, a[2] + (bb[2] - a[2]) * tt, a[3] + (bb[3] - a[3]) * tt]; const n = Math.hypot(...r) || 1; return [r[0] / n, r[1] / n, r[2] / n, r[3] / n]; }
  const th0 = Math.acos(dot), th = th0 * tt, s0 = Math.cos(th) - dot * Math.sin(th) / Math.sin(th0), s1 = Math.sin(th) / Math.sin(th0);
  return [s0 * a[0] + s1 * bb[0], s0 * a[1] + s1 * bb[1], s0 * a[2] + s1 * bb[2], s0 * a[3] + s1 * bb[3]];
}

// ---------------------------------------------------------------- main entry
export function cubePoseFromStickers(shapes: Shape[], W: number, H: number): CubePose | null {
  try {
    if (!shapes || shapes.length < 1) return null;
    let good = shapes.filter(
      (s) => s && s.corners && s.corners.length === 4 && s.center && isFinite(s.area) && s.area > 0,
    );
    if (good.length < 1) return null;

    // Robust area median filter — reject gross spurious quads. (Design 1.)
    if (good.length >= 4) {
      const areas = good.map((s) => s.area).sort((a, b) => a - b);
      const medA = areas[areas.length >> 1];
      if (medA > 0) {
        // wide band: only reject GROSS outliers (blobs / specks); perspective alone
        // can make a near sticker several times a far one, so never clip legit ones.
        const filt = good.filter((s) => s.area > 0.15 * medA && s.area < 6.5 * medA);
        if (filt.length >= 3) good = filt;
      }
    }

    const faces = extractFacesV2(good);
    if (faces.length === 0) return null;
    const diag = Math.hypot(W, H);
    const mDiag = medianDiag(good);

    // single visible face -> exact 4 corners + estimated (low-confidence) depth
    if (faces.length === 1) return singleFacePose(faces[0], W, H, good.length);

    // resolve the one-cell grid-anchor ambiguity before the joint solve
    resolveAnchors(faces, mDiag);

    // -------- 2..3 visible faces: full projective camera resection (PnP) --------
    const nfaces = Math.min(faces.length, 3);
    const F = faces.slice(0, nfaces);

    let gcx = 0, gcy = 0, cnt = 0;
    for (const f of F) for (const st of f.stickers) { gcx += st.shape.center.x; gcy += st.shape.center.y; cnt++; }
    const globalCen: Point2 = { x: gcx / cnt, y: gcy / cnt };

    // Common front corner C where the visible faces meet: per face take the boundary
    // corner nearest the sticker centroid, average across faces.
    const gridCornerCoord = [[0, 0], [3, 0], [3, 3], [0, 3]];
    const frontPts = F.map((f) => {
      let k = 0; for (let j = 1; j < 4; j++) if (dist(f.cornersImg[j], globalCen) < dist(f.cornersImg[k], globalCen)) k = j;
      return f.cornersImg[k];
    });
    const C: Point2 = {
      x: frontPts.reduce((s, p) => s + p.x, 0) / frontPts.length,
      y: frontPts.reduce((s, p) => s + p.y, 0) / frontPts.length,
    };

    // Per face: front-corner index, grid-line tangent per axis at C, and the far
    // C-adjacent corners. Adjacent faces share exactly one cube edge along which both
    // tangent and far endpoint coincide -> a pose-independent axis match.
    const faceInfo = F.map((f, i) => {
      let k = 0; for (let j = 1; j < 4; j++) if (dist(f.cornersImg[j], C) < dist(f.cornersImg[k], C)) k = j;
      const cx = gridCornerCoord[k][0], cy = gridCornerCoord[k][1];
      const nbrs = [(k + 1) % 4, (k + 3) % 4];
      let xNbr = 0, yNbr = 0;
      for (const nb of nbrs) { if (gridCornerCoord[nb][0] !== cx) xNbr = nb; else yNbr = nb; }
      const sgnx = cx > 1.5 ? -1 : 1, sgny = cy > 1.5 ? -1 : 1;
      const e = 0.3;
      const pxp = applyH(f.H, { x: cx + sgnx * e, y: cy }), pxm = applyH(f.H, { x: cx - sgnx * e, y: cy });
      const pyp = applyH(f.H, { x: cx, y: cy + sgny * e }), pym = applyH(f.H, { x: cx, y: cy - sgny * e });
      return {
        f, i, cx, cy,
        aX: angleMod180({ x: pxp.x - pxm.x, y: pxp.y - pxm.y }),
        aY: angleMod180({ x: pyp.x - pym.x, y: pyp.y - pym.y }),
        xFar: f.cornersImg[xNbr], yFar: f.cornersImg[yNbr],
      };
    });

    // Union shared edges across face pairs -> exactly 3 global cube axes.
    const nodes: { fi: number; which: string; ang: number; far: Point2 }[] = [];
    for (const fi of faceInfo) {
      nodes.push({ fi: fi.i, which: 'gx', ang: fi.aX, far: fi.xFar });
      nodes.push({ fi: fi.i, which: 'gy', ang: fi.aY, far: fi.yFar });
    }
    const parent = nodes.map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const nodeIdx = (fiIdx: number, which: string) => nodes.findIndex((nd) => nd.fi === fiIdx && nd.which === which);
    for (let a = 0; a < F.length; a++) for (let b = a + 1; b < F.length; b++) {
      let bestS = Infinity, bp: [number, number] | null = null;
      for (const wa of ['gx', 'gy']) for (const wb of ['gx', 'gy']) {
        const na = nodes[nodeIdx(a, wa)], nb = nodes[nodeIdx(b, wb)];
        const s = angDiff180(na.ang, nb.ang) + 0.2 * dist(na.far, nb.far) / mDiag;
        if (s < bestS) { bestS = s; bp = [nodeIdx(a, wa), nodeIdx(b, wb)]; }
      }
      if (bp && bestS < 0.9) parent[find(bp[0])] = find(bp[1]);
    }
    const roots = Array.from(new Set(nodes.map((_, i) => find(i))));
    if (roots.length !== 3) return singleFacePose(F[0], W, H, good.length);
    const axisId = (fiIdx: number, which: string) => roots.indexOf(find(nodeIdx(fiIdx, which)));

    // Build gap-INDEPENDENT 2D<->3D correspondences: each sticker CENTRE (exact
    // lattice sample) plus each face's 4 boundary corners (exact extrapolations of
    // the centres-only homography). No sticker-corner gap bias enters the solve.
    // Model: the visible faces are the three "=3" faces meeting at (3,3,3); "toward
    // C" = higher coordinate. By cube symmetry any consistent labelling reprojects
    // the corners identically.
    const X3: Vec[] = [], x2: Point2[] = [];
    faceInfo.forEach((fi, i) => {
      const gxAxis = axisId(i, 'gx'), gyAxis = axisId(i, 'gy');
      const normalAxis = 3 - gxAxis - gyAxis;
      // Coordinate that is 3 AT the shared corner and decreases away from it, so the
      // three visible faces meet consistently at model corner (3,3,3) with normal=3.
      const toModel = (uu: number, vv: number): Vec => {
        const vX = fi.cx > 1.5 ? uu : 3 - uu;
        const vY = fi.cy > 1.5 ? vv : 3 - vv;
        const m: Vec = [0, 0, 0]; m[gxAxis] = vX; m[gyAxis] = vY; m[normalAxis] = 3;
        return m;
      };
      for (const st of fi.f.stickers) {
        X3.push(toModel(st.gx + 0.5, st.gy + 0.5)); x2.push(st.shape.center);
      }
      // face boundary corners (grid 0/3) -> exact cube-face corners
      const bnd: [number, number][] = [[0, 0], [3, 0], [3, 3], [0, 3]];
      for (let bi = 0; bi < 4; bi++) {
        X3.push(toModel(bnd[bi][0], bnd[bi][1])); x2.push(fi.f.cornersImg[bi]);
      }
    });

    const P = cameraDLT(X3, x2);
    if (!P) return singleFacePose(F[0], W, H, good.length);

    let se = 0;
    for (let i = 0; i < X3.length; i++) {
      const pr = projectP(P, X3[i]);
      if (!isFinite(pr.x) || !isFinite(pr.y)) return null;
      se += (pr.x - x2[i].x) ** 2 + (pr.y - x2[i].y) ** 2;
    }
    const rms = Math.sqrt(se / X3.length);

    const corners = CUBE_CORNERS.map((c) => projectP(P, c));
    for (const c of corners) if (!isFinite(c.x) || !isFinite(c.y) || Math.abs(c.x) > 8 * W || Math.abs(c.y) > 8 * H) return null;
    const consist0 = cubeConsistency(corners);
    if (rms > 0.15 * diag) return null;               // reprojection gate  (Design 2)
    const consist = consist0;
    if (consist < 0.2) return null;                   // cube-prior gate     (Design 3)

    const coverage = Math.min(1, cnt / (9 * nfaces));
    const base = nfaces >= 3 ? 0.92 : 0.82;
    let conf = base;
    conf *= Math.max(0.2, 1 - rms / (0.09 * diag));
    conf *= 0.5 + 0.5 * coverage;
    conf *= 0.6 + 0.4 * consist;
    conf = Math.max(0.05, Math.min(1, conf));
    // exact filterable pose from the resection camera itself (RQ decomposition)
    return { corners, edges: CUBE_EDGES, faces: nfaces, confidence: conf, pose: decomposeP(P) || poseFromFaceH(F[0].H, W, H) || undefined };
  } catch {
    return null;
  }
}

// Single visible face: the 4 face corners are recovered exactly from its homography;
// depth (hidden 4 corners) is only weakly constrained, so we decompose the face
// homography with an assumed pinhole (focal ~ 1.3*max(W,H), principal point at image
// centre) and extrude one cube edge along the face normal. Approximate, low confidence.
function singleFacePose(face: Face, W: number, H: number, nDetected: number): CubePose {
  const front = face.cornersImg;
  const f = 1.3 * Math.max(W, H), cx = W / 2, cy = H / 2;
  const Kinv: Mat = [[1 / f, 0, -cx / f], [0, 1 / f, -cy / f], [0, 0, 1]];
  // face.H maps grid(0..3) -> image; build K^-1 H and decompose columns as [r1 r2 t]
  const Hn = matMul(Kinv, face.H);
  const h1 = [Hn[0][0], Hn[1][0], Hn[2][0]];
  const h2 = [Hn[0][1], Hn[1][1], Hn[2][1]];
  const h3 = [Hn[0][2], Hn[1][2], Hn[2][2]];
  const lam = 2 / (Math.hypot(h1[0], h1[1], h1[2]) + Math.hypot(h2[0], h2[1], h2[2]) + 1e-12);
  let r1 = h1.map((v) => v * lam), r2 = h2.map((v) => v * lam);
  let t = h3.map((v) => v * lam);
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = [r2[0] - d * r1[0], r2[1] - d * r1[1], r2[2] - d * r1[2]];
  const nr1 = Math.hypot(r1[0], r1[1], r1[2]) || 1, nr2 = Math.hypot(r2[0], r2[1], r2[2]) || 1;
  r1 = r1.map((v) => v / nr1); r2 = r2.map((v) => v / nr2);
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  if (t[2] < 0) t = t.map((v) => -v);
  if (r3[2] < 0) r3 = r3.map((v) => -v);
  const depth = 3; // one cube edge in grid (sticker) units
  const projGrid = (gx: number, gy: number, back: boolean): Point2 => {
    const Xc = [r1[0] * gx + r2[0] * gy + t[0], r1[1] * gx + r2[1] * gy + t[1], r1[2] * gx + r2[2] * gy + t[2]];
    if (back) { Xc[0] += r3[0] * depth; Xc[1] += r3[1] * depth; Xc[2] += r3[2] * depth; }
    const z = Xc[2] || 1e-9;
    return { x: (f * Xc[0] + cx * Xc[2]) / z, y: (f * Xc[1] + cy * Xc[2]) / z };
  };
  const gc = [[0, 0], [3, 0], [3, 3], [0, 3]];
  const ring0 = gc.map(([a, b]) => projGrid(a, b, false)); // exact visible face
  const ring1 = gc.map(([a, b]) => projGrid(a, b, true));  // estimated depth side
  const ok = ring0.every((c) => isFinite(c.x) && isFinite(c.y)) &&
    ring1.every((c) => isFinite(c.x) && isFinite(c.y));
  if (!ok) {
    return { corners: [...front, ...front], edges: CUBE_EDGES, faces: 1, confidence: 0.12 };
  }
  const coverage = Math.min(1, face.stickers.length / 9) * Math.min(1, face.stickers.length / Math.max(1, nDetected));
  const conf = Math.max(0.1, Math.min(0.4, 0.28 + 0.12 * coverage));
  return { corners: [...ring0, ...ring1], edges: CUBE_EDGES, faces: 1, confidence: conf, pose: poseFromFaceH(face.H, W, H) || undefined };
}

// OPTIONAL: exposed for offline validation / debugging only (safe to delete).
export function __debugFaces(shapes: Shape[]): { count: number }[] {
  const good = shapes.filter((s) => s && s.corners && s.corners.length === 4 && s.center && isFinite(s.area) && s.area > 0);
  return extractFaces(good).map((f) => ({ count: f.stickers.length }));
}