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
export interface FaceOpts { image?: ImageData; mem?: ColourMemory; minDetected?: number }

const side = (s: Shape) => Math.sqrt(Math.max(1, s.area));

export function graphFaces(shapes: Shape[]): GraphResult {
  const N = shapes.length;
  const nodes: GraphNode[] = shapes.map((s) => ({ shape: s, gx: 0, gy: 0, face: -1, deg: 0 }));
  if (N < 2) return { nodes, faces: [], edges: [] };
  const c = shapes.map((s) => s.center);
  const sides = shapes.map(side).sort((a, b) => a - b);
  const med = sides[sides.length >> 1] || 1;

  // Grid PITCH from the actual spacing, NOT the sticker size — a gapped cube has a
  // pitch well above one sticker side, and a size-based threshold would fail to link
  // the (obviously present) grid. Use the median nearest-neighbour distance.
  const nn: number[] = [];
  for (let i = 0; i < N; i++) {
    let best = Infinity;
    for (let j = 0; j < N; j++) if (j !== i) { const d = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y); if (d < best) best = d; }
    if (isFinite(best)) nn.push(best);
  }
  nn.sort((a, b) => a - b);
  const pitch0 = nn[nn.length >> 1] || med * 1.2;   // one grid step
  const thr = 1.6 * pitch0;     // links: orthogonal (~1·pitch) AND diagonals (~1.41·pitch)
  const orthoMax = 1.28 * pitch0;

  // adjacency (orthogonal + diagonal neighbours — diagonals add redundancy so a single
  // missing orthogonal link can't split an obviously-connected face, exactly like the
  // \ and / in a 3×3 sketch).
  const adj: number[][] = Array.from({ length: N }, () => []);
  const edges: [number, number][] = [];       // ortho-only, used for rotation estimate
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const d = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y);
    if (d >= thr) continue;
    adj[i].push(j); adj[j].push(i); nodes[i].deg++; nodes[j].deg++;
    if (d <= orthoMax) edges.push([i, j]);     // keep diagonals OUT of rotation math
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
    let sC = 0, sS = 0, lens: number[] = [];
    for (const [i, j] of edges) {
      if (comp[i] !== f) continue;
      const dx = c[j].x - c[i].x, dy = c[j].y - c[i].y, a = Math.atan2(dy, dx);
      sC += Math.cos(4 * a); sS += Math.sin(4 * a); lens.push(Math.hypot(dx, dy));
    }
    const rot = Math.atan2(sS, sC) / 4;
    lens.sort((a, b) => a - b); const pitch = lens[lens.length >> 1] || pitch0;
    const ux = Math.cos(rot), uy = Math.sin(rot), vx = -Math.sin(rot), vy = Math.cos(rot);

    // BFS grid assignment: each edge is projected onto (u,v) → an integer step.
    const seed = idxs.reduce((best, k) => (nodes[k].deg > nodes[best].deg ? k : best), idxs[0]);
    nodes[seed].gx = 0; nodes[seed].gy = 0; nodes[seed].face = f;
    const seen = new Set<number>([seed]); const q = [seed];
    while (q.length) {
      const n = q.shift()!;
      for (const m of adj[n]) {
        if (seen.has(m)) continue;
        const dx = c[m].x - c[n].x, dy = c[m].y - c[n].y;
        const du = (dx * ux + dy * uy) / pitch, dv = (dx * vx + dy * vy) / pitch;
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
  const { image, mem, minDetected = 4 } = opts;
  const px = image?.data, iw = image?.width ?? 0, ih = image?.height ?? 0;
  const readColour = (corners: { x: number; y: number }[]): { rgb: [number, number, number] | null; colour: CubeColour; black: boolean } => {
    if (!px) return { rgb: null, colour: "unknown", black: false };
    const black = darkFraction(corners, px, iw, ih) > 0.2;
    const rgb = sampleQuadRGB(corners, px, iw, ih);
    if (!rgb) return { rgb: null, colour: "unknown", black };
    const colour = mem ? mem.classify(rgb) : classifyColour(rgb);
    return { rgb, colour, black };
  };
  const { faces } = graphFaces(shapes);
  const out: DetectedFace[] = [];
  for (const face of faces) {
    if (face.nodes.length < minDetected) continue;
    const pts = face.nodes.map((n) => ({ gx: n.gx, gy: n.gy, x: n.shape.center.x, y: n.shape.center.y }));
    const predict = fitAffine(pts); if (!predict) continue;
    const byCell = new Map<string, GraphNode>();
    for (const n of face.nodes) byCell.set(`${n.gx},${n.gy}`, n);

    // choose the 3×3 offset (ox,oy) that contains the most detected cells
    let bestOx = 0, bestOy = 0, bestC = -1;
    for (let oy = Math.min(0, face.h - 3); oy <= Math.max(0, face.h - 3); oy++)
      for (let ox = Math.min(0, face.w - 3); ox <= Math.max(0, face.w - 3); ox++) {
        let cnt = 0;
        for (const n of face.nodes) if (n.gx >= ox && n.gx < ox + 3 && n.gy >= oy && n.gy < oy + 3) cnt++;
        if (cnt > bestC) { bestC = cnt; bestOx = ox; bestOy = oy; }
      }

    const cells: FaceCell[] = [];
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const gx = bestOx + dx, gy = bestOy + dy;
      const hit = byCell.get(`${gx},${gy}`);
      if (hit) {
        // prefer the colour already computed during shape discovery (detect() learned it)
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
  return out.sort((a, b) => b.count - a.count);
}
