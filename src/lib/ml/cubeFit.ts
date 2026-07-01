// Fit a cube to the (noisy, possibly incomplete) 2D corner predictions and
// reproject ALL 8 corners, so the overlay is a COMPLETE, geometrically-consistent
// cube — even when some corners are hidden or a bit off. Weak-perspective (affine
// 2x4) least-squares fit: [x,y] = M · [X,Y,Z,1], solved from the confident corners.

// 8 cube corners in model index order (i*4+j*2+k for x,y,z ∈ {-0.5,0.5}).
const CUBE3D: [number, number, number][] = [];
for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) CUBE3D.push([x, y, z]);

// Gauss-Jordan solve of an n×n system (returns null if singular).
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export interface FitCube { corners: { x: number; y: number }[]; residual: number }

// Returns 8 reprojected corners forming a consistent cube, or null if the
// confident corners don't constrain a good fit (too few / degenerate / bad).
export function fitCube(pts: { x: number; y: number; on: boolean }[]): FitCube | null {
  const idx: number[] = [];
  for (let i = 0; i < 8; i++) if (pts[i].on) idx.push(i);
  if (idx.length < 5) return null;   // need enough non-coplanar points

  // normal equations for m=[m0..m7]:  m0..3·[X,Y,Z,1]=x ,  m4..7·[X,Y,Z,1]=y
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  for (const i of idx) {
    const [X, Y, Z] = CUBE3D[i]; const v = [X, Y, Z, 1];
    const x = pts[i].x, y = pts[i].y;
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) { AtA[a][b] += v[a] * v[b]; AtA[a + 4][b + 4] += v[a] * v[b]; }
      Atb[a] += v[a] * x; Atb[a + 4] += v[a] * y;
    }
  }
  for (let d = 0; d < 8; d++) AtA[d][d] += 1e-3;   // ridge → stabilise
  const m = solve(AtA, Atb);
  if (!m) return null;

  const corners = CUBE3D.map(([X, Y, Z]) => ({
    x: m[0] * X + m[1] * Y + m[2] * Z + m[3],
    y: m[4] * X + m[5] * Y + m[6] * Z + m[7],
  }));

  // reject a bad/degenerate fit: mean reprojection error on the confident corners
  let err = 0;
  for (const i of idx) err += Math.hypot(corners[i].x - pts[i].x, corners[i].y - pts[i].y);
  const residual = err / idx.length;
  if (residual > 0.06) return null;   // fit doesn't explain the detections → fall back

  return { corners, residual };
}
