// Fit a cube to ALL 8 (noisy, uncertain) 2D corner predictions and reproject them
// into a COMPLETE, consistent cube. Robust weighted least-squares (IRLS with a
// Tukey biweight) so wrong/uncertain corners get down-weighted and the good ones
// dominate — the 8 noisy points are averaged into one coherent cube pose.

// 8 cube corners in model index order (i*4+j*2+k for x,y,z ∈ {-0.5,0.5}).
const CUBE3D: [number, number, number][] = [];
for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) CUBE3D.push([x, y, z]);

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

// pts: all 8 corners with a confidence weight w (0..1). Returns the reprojected
// complete cube, or null if the points don't agree on a cube.
export function fitCube(pts: { x: number; y: number; w: number }[]): FitCube | null {
  const w = pts.map((p) => Math.max(0, Math.min(1, p.w)));
  let corners: { x: number; y: number }[] | null = null;
  let residual = 1;

  for (let iter = 0; iter < 4; iter++) {
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    let eff = 0;
    for (let i = 0; i < 8; i++) {
      const wi = w[i];
      if (wi < 1e-3) continue;
      eff += wi;
      const [X, Y, Z] = CUBE3D[i]; const v = [X, Y, Z, 1];
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) { AtA[a][b] += wi * v[a] * v[b]; AtA[a + 4][b + 4] += wi * v[a] * v[b]; }
        Atb[a] += wi * v[a] * pts[i].x; Atb[a + 4] += wi * v[a] * pts[i].y;
      }
    }
    if (eff < 3.0) return null;            // not enough total confidence
    for (let d = 0; d < 8; d++) AtA[d][d] += 1e-3;   // ridge
    const m = solve(AtA, Atb);
    if (!m) return null;
    corners = CUBE3D.map(([X, Y, Z]) => ({
      x: m[0] * X + m[1] * Y + m[2] * Z + m[3],
      y: m[4] * X + m[5] * Y + m[6] * Z + m[7],
    }));
    // IRLS reweight: Tukey biweight on the reprojection residual (scale ~0.06)
    let er = 0, ew = 0;
    for (let i = 0; i < 8; i++) {
      const r = Math.hypot(corners[i].x - pts[i].x, corners[i].y - pts[i].y);
      const rr = Math.min(1, r / 0.07);
      const robust = (1 - rr * rr) ** 2;   // → 0 for outliers, 1 for inliers
      w[i] = Math.max(0, Math.min(1, pts[i].w)) * robust;
      if (pts[i].w > 0.35) { er += r * pts[i].w; ew += pts[i].w; }
    }
    residual = ew > 0 ? er / ew : 1;
  }

  if (!corners || residual > 0.09) return null;   // fit doesn't explain the confident corners
  return { corners, residual };
}
