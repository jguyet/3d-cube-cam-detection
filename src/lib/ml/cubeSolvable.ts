// Physical SOLVABILITY of a scanned cube — the three deep laws beyond "9 of each colour".
// A colouring is reachable from a solved cube iff:
//   1. corners & edges are a valid permutation (each of the 8 corner / 12 edge cubies once),
//   2. Σ corner orientations ≡ 0 (mod 3)   — no single twisted corner,
//   3. Σ edge orientations   ≡ 0 (mod 2)   — no single flipped edge,
//   4. permutation parity(corners) == parity(edges)  — no single 2-piece swap.
// Facelets are the standard Kociemba layout: U(0-8) R(9-17) F(18-26) D(27-35) L(36-44)
// B(45-53), each row-major with the centre at local index 4.

import type { CubeColour } from "@/lib/ml/stickerColor";

// per-cubie facelet indices; the FIRST facelet is the orientation reference
// (U/D facelet for corners & U/D-layer edges, F/B facelet for middle-layer edges).
const CORNERS = [
  [8, 9, 20], [6, 18, 38], [0, 36, 47], [2, 45, 11],
  [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51],
];
const EDGES = [
  [5, 10], [7, 19], [3, 37], [1, 46], [32, 16], [28, 25],
  [30, 43], [34, 52], [23, 12], [21, 41], [50, 39], [48, 14],
];
// centre facelet of each face
const C = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };

export interface Solvable { ok: boolean; reasons: string[] }

function parity(perm: number[]): number {
  const seen = new Array(perm.length).fill(false); let cyc = 0;
  for (let i = 0; i < perm.length; i++) { if (seen[i]) continue; cyc++; let j = i; while (!seen[j]) { seen[j] = true; j = perm[j]; } }
  return (perm.length - cyc) & 1;
}

export function checkSolvable(f: (CubeColour | null)[]): Solvable {
  const reasons: string[] = [];
  if (f.length !== 54 || f.some((x) => !x)) return { ok: false, reasons: ["scan incomplet"] };
  const g = f as CubeColour[];
  const U = g[C.U], R = g[C.R], F = g[C.F], D = g[C.D], L = g[C.L], B = g[C.B];
  const UD = new Set([U, D]);

  // ---- colour counts ----
  const cnt: Record<string, number> = {};
  for (const c of g) cnt[c] = (cnt[c] ?? 0) + 1;
  for (const c of [U, R, F, D, L, B]) if (cnt[c] !== 9) reasons.push(`${cnt[c] ?? 0}× ${c} (≠9)`);

  // ---- corners → permutation + orientation ----
  const cornerId = new Map<string, number>();
  const CC = [[U, R, F], [U, F, L], [U, L, B], [U, B, R], [D, F, R], [D, L, F], [D, B, L], [D, R, B]];
  CC.forEach((cols, i) => cornerId.set([...cols].sort().join(""), i));
  const cp: number[] = [], co: number[] = [];
  for (const slot of CORNERS) {
    const cols = slot.map((i) => g[i]);
    const ori = cols.findIndex((c) => UD.has(c));
    if (ori < 0) { reasons.push("coin sans facette U/D"); cp.push(-1); co.push(0); continue; }
    const id = cornerId.get([...cols].sort().join(""));
    cp.push(id ?? -1); co.push(ori);
  }

  // ---- edges → permutation + orientation ----
  const edgeId = new Map<string, number>();
  const EC = [[U, R], [U, F], [U, L], [U, B], [D, R], [D, F], [D, L], [D, B], [F, R], [F, L], [B, L], [B, R]];
  EC.forEach((cols, i) => edgeId.set([...cols].sort().join(""), i));
  const ep: number[] = [], eo: number[] = [];
  for (const slot of EDGES) {
    const [a, b] = slot.map((i) => g[i]);
    let ori: number;
    if (UD.has(a)) ori = 0; else if (UD.has(b)) ori = 1; else ori = (a === F || a === B) ? 0 : 1;
    ep.push(edgeId.get([a, b].sort().join("")) ?? -1); eo.push(ori);
  }

  // ---- valid permutations? ----
  const cpOk = cp.every((x) => x >= 0) && new Set(cp).size === 8;
  const epOk = ep.every((x) => x >= 0) && new Set(ep).size === 12;
  if (!cpOk) reasons.push("coins invalides (pièce manquante/en double)");
  if (!epOk) reasons.push("arêtes invalides (pièce manquante/en double)");

  // ---- the three parity laws (only meaningful on valid permutations) ----
  if (cpOk && epOk) {
    if (co.reduce((a, b) => a + b, 0) % 3 !== 0) reasons.push("orientation des coins impossible (Σ ≢ 0 mod 3)");
    if (eo.reduce((a, b) => a + b, 0) % 2 !== 0) reasons.push("orientation des arêtes impossible (Σ ≢ 0 mod 2)");
    if (parity(cp) !== parity(ep)) reasons.push("parité des permutations impossible (échange de 2 pièces)");
  }
  return { ok: reasons.length === 0, reasons };
}
