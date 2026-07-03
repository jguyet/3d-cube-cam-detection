// V2 face detection: build the NEIGHBOUR GRAPH of detected square shapes and read
// the cube grid straight from it — no homography, no seed, no scale ambiguity. A
// direct neighbour link IS one grid step, so the pitch and axes come for free and
// the assignment is stable. Handles any sticker colour pattern (purely geometric).

import type { Shape } from "@/lib/rubik-detector/core/ShapeDetector";
import { sampleQuadRGB, darkFraction, classifyColour, ColourMemory, type CubeColour } from "@/lib/ml/stickerColor";

export interface GraphNode { shape: Shape; gx: number; gy: number; face: number; deg: number }
export interface GraphFace { nodes: GraphNode[]; rot: number; pitch: number; w: number; h: number }
export interface GraphResult { nodes: GraphNode[]; faces: GraphFace[]; edges: [number, number][] }

export interface FaceCell {
  gx: number; gy: number; center: { x: number; y: number }; corners: { x: number; y: number }[];
  detected: boolean; shape?: Shape;
  rgb: [number, number, number] | null; colour: CubeColour; black: boolean;
}
export interface DetectedFace { cells: FaceCell[]; rot: number; pitch: number; count: number }
export interface FaceOpts { image?: ImageData; mem?: ColourMemory; minDetected?: number; oriTol?: number }

const side = (s: Shape) => Math.sqrt(Math.max(1, s.area));

// DEDUPE overlapping shapes (the same sticker found by detect + detectWhite, or split
// fragments). Duplicates crush the nearest-neighbour PITCH estimate (a spurious close
// pair halves it) and break the grid. Keep the largest of each overlapping cluster.
export function dedupeShapes(shapes: Shape[]): Shape[] {
  const sorted = [...shapes].sort((a, b) => b.area - a.area);
  const keep: Shape[] = [];
  for (const s of sorted) {
    const r = 0.55 * side(s);
    if (!keep.some((k) => Math.hypot(k.center.x - s.center.x, k.center.y - s.center.y) < r)) keep.push(s);
  }
  return keep;
}

// A shape's own quad orientation, folded to [0, π/2). Stickers on ONE face share it;
// across a cube edge (fold) it jumps — so it cuts links that bridge two faces.
const shapeAngle = (s: Shape): number => {
  const dx = s.corners[1].x - s.corners[0].x, dy = s.corners[1].y - s.corners[0].y;
  const a = Math.atan2(dy, dx); return ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
};
const angDiff = (a: number, b: number) => { const d = Math.abs(a - b); return Math.min(d, Math.PI / 2 - d); };

export function graphFaces(shapes: Shape[], oriTol = 0.18): GraphResult {
  const N = shapes.length;
  const nodes: GraphNode[] = shapes.map((s) => ({ shape: s, gx: 0, gy: 0, face: -1, deg: 0 }));
  if (N < 2) return { nodes, faces: [], edges: [] };
  const c = shapes.map((s) => s.center);
  const sides = shapes.map(side).sort((a, b) => a - b);
  const med = sides[sides.length >> 1] || 1;

  // PER-NODE LOCAL PITCH — a single global pitch is WRONG when two visible faces sit at
  // different distances (one near, one far → different projected pitch): the global median
  // lands between them and breaks BOTH. Each node instead gets its own local spacing (the
  // robust median of its 3 nearest non-duplicate neighbours), so a near face links at its
  // big pitch and a far face at its small pitch, and the scale boundary at the fold is a
  // natural cut (min of the two local pitches won't reach across it).
  const localPitch = new Float64Array(N);
  const allLp: number[] = [];
  for (let i = 0; i < N; i++) {
    const ds: number[] = [];
    for (let j = 0; j < N; j++) if (j !== i) { const d = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y); if (d > 0.3 * side(shapes[i])) ds.push(d); }
    ds.sort((a, b) => a - b);
    const k = Math.min(3, ds.length);
    localPitch[i] = k ? ds[(k - 1) >> 1] : med * 1.2;   // median of the 3 nearest
    allLp.push(localPitch[i]);
  }
  allLp.sort((a, b) => a - b);
  const pitch0 = allLp[allLp.length >> 1] || med * 1.2;   // global fallback only

  // adjacency (orthogonal + diagonal neighbours) using each pair's LOCAL pitch. Diagonals
  // (~1.41·pitch) add redundancy so a single missing orthogonal link can't split a face.
  const ang = shapes.map(shapeAngle);
  const adj: number[][] = Array.from({ length: N }, () => []);
  const edges: [number, number][] = [];       // ortho-only, used for rotation estimate
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const d = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y);
    const lp = Math.min(localPitch[i], localPitch[j]);
    if (d >= 1.55 * lp) continue;                     // ortho (~1) + diagonal (~1.41)
    if (angDiff(ang[i], ang[j]) > oriTol) continue;   // FOLD cut: orientation jump = different face
    adj[i].push(j); adj[j].push(i); nodes[i].deg++; nodes[j].deg++;
    if (d <= 1.22 * lp) edges.push([i, j]);           // keep diagonals OUT of rotation math
  }

  // connected components
  const comp = new Int32Array(N).fill(-1); let nc = 0;
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0) continue;
    const st = [i]; comp[i] = nc;
    while (st.length) { const n = st.pop()!; for (const m of adj[n]) if (comp[m] < 0) { comp[m] = nc; st.push(m); } }
    nc++;
  }

  const faces: GraphFace[] = [];
  for (let f = 0; f < nc; f++) {
    const idxs: number[] = []; for (let i = 0; i < N; i++) if (comp[i] === f) idxs.push(i);
    if (idxs.length < 2) continue;   // a lone shape is not a face

    // grid rotation from the component's edge directions (doubled-angle averaging so
    // the two perpendicular axes reinforce instead of cancel: 4·θ folds mod 90).
    let sC = 0, sS = 0; const evecs: [number, number][] = [];
    for (const [i, j] of edges) {
      if (comp[i] !== f) continue;
      const dx = c[j].x - c[i].x, dy = c[j].y - c[i].y, a = Math.atan2(dy, dx);
      sC += Math.cos(4 * a); sS += Math.sin(4 * a); evecs.push([dx, dy]);
    }
    const rot = Math.atan2(sS, sC) / 4;
    const ux = Math.cos(rot), uy = Math.sin(rot), vx = -Math.sin(rot), vy = Math.cos(rot);

    // ANISOTROPIC pitch — a foreshortened (oblique) face is a RECTANGULAR grid in the
    // image: the step along one axis is much shorter than the other. Estimate pitch_u and
    // pitch_v separately by classifying each ortho edge as a u- or v-step, so the BFS grid
    // gate holds on BOTH axes (a single isotropic pitch was silently killing oblique faces).
    const lensU: number[] = [], lensV: number[] = [];
    for (const [dx, dy] of evecs) {
      const pu = Math.abs(dx * ux + dy * uy), pv = Math.abs(dx * vx + dy * vy);
      if (pu >= pv) lensU.push(pu); else lensV.push(pv);
    }
    const medOf = (a: number[]) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const pitchU = medOf(lensU) || medOf(lensV) || pitch0;
    const pitchV = medOf(lensV) || medOf(lensU) || pitch0;
    const pitch = Math.sqrt(pitchU * pitchV);

    // BFS grid assignment: each edge is projected onto (u,v) with its own axis pitch.
    const seed = idxs.reduce((best, k) => (nodes[k].deg > nodes[best].deg ? k : best), idxs[0]);
    nodes[seed].gx = 0; nodes[seed].gy = 0; nodes[seed].face = f;
    const seen = new Set<number>([seed]); const q = [seed];
    while (q.length) {
      const n = q.shift()!;
      for (const m of adj[n]) {
        if (seen.has(m)) continue;
        const dx = c[m].x - c[n].x, dy = c[m].y - c[n].y;
        const du = (dx * ux + dy * uy) / pitchU, dv = (dx * vx + dy * vy) / pitchV;
        const sgx = Math.round(du), sgy = Math.round(dv);
        if (Math.abs(du - sgx) > 0.34 || Math.abs(dv - sgy) > 0.34) continue;   // not a clean grid step
        if (sgx === 0 && sgy === 0) continue;
        nodes[m].gx = nodes[n].gx + sgx; nodes[m].gy = nodes[n].gy + sgy; nodes[m].face = f;
        seen.add(m); q.push(m);
      }
    }
    // normalise this face's coords to start at 0
    const assigned = idxs.filter((i) => nodes[i].face === f);
    const minx = Math.min(...assigned.map((i) => nodes[i].gx)), miny = Math.min(...assigned.map((i) => nodes[i].gy));
    for (const i of assigned) { nodes[i].gx -= minx; nodes[i].gy -= miny; }
    const w = Math.max(...assigned.map((i) => nodes[i].gx)) + 1, h = Math.max(...assigned.map((i) => nodes[i].gy)) + 1;
    faces.push({ nodes: assigned.map((i) => nodes[i]), rot, pitch, w, h });
  }
  return { nodes, faces, edges };
}

// SELF-LOCALISATION (no ML): the cube is ONE cluster of mutually-adjacent faces; a face
// from background clutter sits alone, far from the cube. Keep only the largest connected
// group of faces (adjacent = centroids within ~3.5·pitch, i.e. sharing a cube edge). This
// gives the ML-zone's background rejection for free — no model, no lag, no jittery bbox.
export function keepDominantCluster(faces: DetectedFace[]): DetectedFace[] {
  if (faces.length <= 1) return faces;
  const cen = (f: DetectedFace) => { let x = 0, y = 0; for (const c of f.cells) { x += c.center.x; y += c.center.y; } return { x: x / f.cells.length, y: y / f.cells.length }; };
  const ctr = faces.map(cen);
  const adj: number[][] = faces.map(() => []);
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
    const lim = 3.5 * Math.max(faces[i].pitch, faces[j].pitch);
    if (Math.hypot(ctr[i].x - ctr[j].x, ctr[i].y - ctr[j].y) < lim) { adj[i].push(j); adj[j].push(i); }
  }
  const comp = new Int32Array(faces.length).fill(-1); let nc = 0;
  for (let i = 0; i < faces.length; i++) { if (comp[i] >= 0) continue; const st = [i]; comp[i] = nc; while (st.length) { const n = st.pop()!; for (const m of adj[n]) if (comp[m] < 0) { comp[m] = nc; st.push(m); } } nc++; }
  // pick the component with the most detected cells (the cube), keep 1..3 faces of it
  const score = new Array(nc).fill(0);
  for (let i = 0; i < faces.length; i++) score[comp[i]] += faces[i].count;
  let best = 0; for (let k = 1; k < nc; k++) if (score[k] > score[best]) best = k;
  return faces.filter((_, i) => comp[i] === best);
}

// ---- least-squares affine  (gx,gy,1) -> (px,py) ----
function invert3(m: number[][]): number[][] | null {
  const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(d) < 1e-9) return null;
  const c = (a: number, b: number, cc: number, dd: number) => a * dd - b * cc;
  return [
    [c(m[1][1], m[1][2], m[2][1], m[2][2]) / d, c(m[0][2], m[0][1], m[2][2], m[2][1]) / d, c(m[0][1], m[0][2], m[1][1], m[1][2]) / d],
    [c(m[1][2], m[1][0], m[2][2], m[2][0]) / d, c(m[0][0], m[0][2], m[2][0], m[2][2]) / d, c(m[0][2], m[0][0], m[1][2], m[1][0]) / d],
    [c(m[1][0], m[1][1], m[2][0], m[2][1]) / d, c(m[0][1], m[0][0], m[2][1], m[2][0]) / d, c(m[0][0], m[0][1], m[1][0], m[1][1]) / d],
  ];
}
function fitAffine(pts: { gx: number; gy: number; x: number; y: number }[]): ((gx: number, gy: number) => { x: number; y: number }) | null {
  let Sxx = 0, Sxy = 0, Sx1 = 0, Syy = 0, Sy1 = 0, S11 = 0, bXx = 0, bXy = 0, bX1 = 0, bYx = 0, bYy = 0, bY1 = 0;
  for (const p of pts) {
    Sxx += p.gx * p.gx; Sxy += p.gx * p.gy; Sx1 += p.gx; Syy += p.gy * p.gy; Sy1 += p.gy; S11 += 1;
    bXx += p.x * p.gx; bXy += p.x * p.gy; bX1 += p.x; bYx += p.y * p.gx; bYy += p.y * p.gy; bY1 += p.y;
  }
  const inv = invert3([[Sxx, Sxy, Sx1], [Sxy, Syy, Sy1], [Sx1, Sy1, S11]]); if (!inv) return null;
  const sol = (b0: number, b1: number, b2: number) => [inv[0][0] * b0 + inv[0][1] * b1 + inv[0][2] * b2, inv[1][0] * b0 + inv[1][1] * b1 + inv[1][2] * b2, inv[2][0] * b0 + inv[2][1] * b1 + inv[2][2] * b2];
  const A = sol(bXx, bXy, bX1), B = sol(bYx, bYy, bY1);
  return (gx, gy) => ({ x: A[0] * gx + A[1] * gy + A[2], y: B[0] * gx + B[1] * gy + B[2] });
}

// DETECT CUBE FACES — a face is ALWAYS a full 3×3. From each graph component we fit
// the affine (uniform pitch), pick the 3×3 window covering the most detected cells,
// and emit all 9 cells (detected ones use their real quad; missing ones are predicted
// so the face is always complete). minDetected guards against noise components.
//
// COLOUR is read here, wired straight into shape discovery: every cell is sampled from
// the image — even the COMPLETED (predicted) cells get their colour by looking where the
// sticker should be — classified through the learned palette (ColourMemory, closed-set at
// 6), and flagged black (a black cell is not a real facelet).
export function detectCubeFaces(shapes: Shape[], opts: FaceOpts = {}): DetectedFace[] {
  const { image, mem, minDetected = 4, oriTol = 0.18 } = opts;
  const px = image?.data, iw = image?.width ?? 0, ih = image?.height ?? 0;
  const readColour = (corners: { x: number; y: number }[]): { rgb: [number, number, number] | null; colour: CubeColour; black: boolean } => {
    if (!px) return { rgb: null, colour: "unknown", black: false };
    const black = darkFraction(corners, px, iw, ih) > 0.2;
    const rgb = sampleQuadRGB(corners, px, iw, ih);
    if (!rgb) return { rgb: null, colour: "unknown", black };
    const colour = mem ? mem.classify(rgb) : classifyColour(rgb);
    return { rgb, colour, black };
  };
  const { faces } = graphFaces(dedupeShapes(shapes), oriTol);
  const out: DetectedFace[] = [];
  for (const face of faces) {
    if (face.nodes.length < minDetected) continue;
    const pts = face.nodes.map((n) => ({ gx: n.gx, gy: n.gy, x: n.shape.center.x, y: n.shape.center.y }));
    const predict = fitAffine(pts); if (!predict) continue;
    const byCell = new Map<string, GraphNode>();
    for (const n of face.nodes) byCell.set(`${n.gx},${n.gy}`, n);

    // GREEDILY emit as many non-overlapping 3×3 windows as the component supports: a big
    // component (a fold that survived the orientation cut, or a 3×N strip) yields several
    // faces instead of one. Each round takes the 3×3 window covering the most still-UNUSED
    // detected cells; stop when the best window has fewer than minDetected fresh cells.
    const used = new Set<string>();
    for (let iter = 0; iter < 6; iter++) {
      let bestOx = 0, bestOy = 0, bestC = -1;
      for (let oy = Math.min(0, face.h - 3); oy <= Math.max(0, face.h - 3); oy++)
        for (let ox = Math.min(0, face.w - 3); ox <= Math.max(0, face.w - 3); ox++) {
          let cnt = 0;
          for (const n of face.nodes) if (!used.has(`${n.gx},${n.gy}`) && n.gx >= ox && n.gx < ox + 3 && n.gy >= oy && n.gy < oy + 3) cnt++;
          if (cnt > bestC) { bestC = cnt; bestOx = ox; bestOy = oy; }
        }
      if (bestC < minDetected) break;

      const cells: FaceCell[] = [];
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        const gx = bestOx + dx, gy = bestOy + dy;
        const hit = byCell.get(`${gx},${gy}`);
        if (hit && !used.has(`${gx},${gy}`)) {
          used.add(`${gx},${gy}`);
          const col = hit.shape.colour
            ? { rgb: (hit.shape.rgb ?? null) as [number, number, number] | null, colour: hit.shape.colour, black: false }
            : readColour(hit.shape.corners);
          cells.push({ gx: dx, gy: dy, center: hit.shape.center, corners: hit.shape.corners, detected: true, shape: hit.shape, ...col });
          continue;
        }
        const c0 = predict(gx, gy), cX = predict(gx + 1, gy), cY = predict(gx, gy + 1);
        const ux = (cX.x - c0.x) * 0.5, uy = (cX.y - c0.y) * 0.5, vX = (cY.x - c0.x) * 0.5, vY = (cY.y - c0.y) * 0.5;
        const corners = [
          { x: c0.x - ux - vX, y: c0.y - uy - vY }, { x: c0.x + ux - vX, y: c0.y + uy - vY },
          { x: c0.x + ux + vX, y: c0.y + uy + vY }, { x: c0.x - ux + vX, y: c0.y - uy + vY },
        ];
        cells.push({ gx: dx, gy: dy, center: c0, corners, detected: false, ...readColour(corners) });
      }
      out.push({ cells, rot: face.rot, pitch: face.pitch, count: bestC });
    }
  }
  // GLOBAL DEDUP: greedy multi-window (and folded components) can emit near-duplicate
  // faces. Keep the higher-count face when two centroids sit within ~0.7·pitch.
  out.sort((a, b) => b.count - a.count);
  const kept: DetectedFace[] = [];
  const cen = (f: DetectedFace) => { let x = 0, y = 0; for (const c of f.cells) { x += c.center.x; y += c.center.y; } return { x: x / f.cells.length, y: y / f.cells.length }; };
  for (const f of out) {
    const fc = cen(f);
    if (kept.some((g) => Math.hypot(cen(g).x - fc.x, cen(g).y - fc.y) < 0.7 * f.pitch)) continue;
    kept.push(f);
  }
  return kept;
}
