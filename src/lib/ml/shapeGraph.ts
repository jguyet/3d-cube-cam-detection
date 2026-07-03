// V2 face detection: build the NEIGHBOUR GRAPH of detected square shapes and read
// the cube grid straight from it — no homography, no seed, no scale ambiguity. A
// direct neighbour link IS one grid step, so the pitch and axes come for free and
// the assignment is stable. Handles any sticker colour pattern (purely geometric).

import type { Shape } from "@/lib/rubik-detector/core/ShapeDetector";

export interface GraphNode { shape: Shape; gx: number; gy: number; face: number; deg: number }
export interface GraphFace { nodes: GraphNode[]; rot: number; pitch: number; w: number; h: number }
export interface GraphResult { nodes: GraphNode[]; faces: GraphFace[]; edges: [number, number][] }

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
