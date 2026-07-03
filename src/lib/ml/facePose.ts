// Absolute cube orientation from the detected faces — the "gyroscope". The KEY is that a
// face's CENTRE colour is its identity on a standard cube, so each visible face gives a
// known cube-space frame (its u,v,n axes). We reconstruct that face's OBSERVED frame in
// camera space (orthographic: foreshortening → tilt depth), and the cube rotation is
// R = O·Cᵀ (maps cube axes → observed). With ≥2 faces (the 50/50 transition) the estimate
// is over-determined and smooth — we average the per-face rotations weighted by how
// complete each face is. No single-view ambiguity: identity anchors it absolutely.

export interface Quat { x: number; y: number; z: number; w: number }
type Pt = { x: number; y: number };
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// cube-space frame (u,v,n) per centre colour — MUST match cubeSim's FACES table
const CANON: Record<string, { u: V3; v: V3; n: V3 }> = {
  white: { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] },
  yellow: { u: [1, 0, 0], v: [0, 0, -1], n: [0, -1, 0] },
  green: { u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
  blue: { u: [-1, 0, 0], v: [0, -1, 0], n: [0, 0, -1] },
  red: { u: [0, 0, -1], v: [0, -1, 0], n: [1, 0, 0] },
  orange: { u: [0, 0, 1], v: [0, -1, 0], n: [-1, 0, 0] },
};

// OBSERVED camera-space frame from a face's corner-cell centres (Y flipped → Y-up world).
// n is forced toward the camera (+z): a face you can see points at you.
function observedFrame(c00: Pt, c20: Pt, c02: Pt): { u: V3; v: V3; n: V3 } {
  const su = Math.hypot(c20.x - c00.x, c20.y - c00.y), sv = Math.hypot(c02.x - c00.x, c02.y - c00.y);
  const frontal = Math.max(su, sv, 1);
  const ux = (c20.x - c00.x) / frontal, uy = -(c20.y - c00.y) / frontal;
  const vx = (c02.x - c00.x) / frontal, vy = -(c02.y - c00.y) / frontal;
  const uz = Math.sqrt(Math.max(0, 1 - ux * ux - uy * uy));
  const vz = Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy));
  const build = (su: number, sv: number) => {
    const u = nrm([ux, uy, su]);
    let v: V3 = [vx, vy, sv];
    v = nrm(sub(v, [u[0] * dot3(u, v), u[1] * dot3(u, v), u[2] * dot3(u, v)]));   // Gram–Schmidt
    // n = v×u to match the LEFT-handed canonical frames (grid-v points down, normal up)
    const n = nrm(cross(v, u));
    return { u, v, n };
  };
  let f = build(uz, vz);
  if (f.n[2] < 0) f = build(-uz, -vz);   // the face we SEE points toward the camera (+z)
  return f;
}

// 3×3 (row-major) → quaternion
function matToQuat(m: number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

// R = O · Cᵀ where O,C have columns (u,v,n). Maps cube axes → observed camera axes.
function rotFor(colour: string, c00: Pt, c20: Pt, c02: Pt): Quat | null {
  const C = CANON[colour]; if (!C) return null;
  const O = observedFrame(c00, c20, c02);
  const Oc = [O.u, O.v, O.n], Cc = [C.u, C.v, C.n];   // columns
  const R: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    // R[i][j] = Σk O[i][k] · Cᵀ[k][j] = Σk O.col_k[i] · C.col_k[j]
    R.push(Oc[0][i] * Cc[0][j] + Oc[1][i] * Cc[1][j] + Oc[2][i] * Cc[2][j]);
  }
  return matToQuat(R);
}

export interface FaceObs { colour: string; c00: Pt; c20: Pt; c02: Pt; weight: number }

// Weighted-average the per-face rotations (quaternion averaging with sign alignment).
export function cubeOrientation(obs: FaceObs[]): Quat | null {
  let ref: Quat | null = null, ax = 0, ay = 0, az = 0, aw = 0;
  for (const o of obs) {
    const q = rotFor(o.colour, o.c00, o.c20, o.c02); if (!q) continue;
    if (!ref) ref = q;
    const s = (q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w) < 0 ? -1 : 1;
    const w = Math.max(1, o.weight);
    ax += s * q.x * w; ay += s * q.y * w; az += s * q.z * w; aw += s * q.w * w;
  }
  const l = Math.hypot(ax, ay, az, aw); if (l < 1e-6) return null;
  return { x: ax / l, y: ay / l, z: az / l, w: aw / l };
}

// kept for back-compat (single face → its observed frame as a quaternion)
export function orientationFromFace(c00: Pt, c20: Pt, c02: Pt): Quat {
  const O = observedFrame(c00, c20, c02);
  return matToQuat([O.u[0], O.v[0], O.n[0], O.u[1], O.v[1], O.n[1], O.u[2], O.v[2], O.n[2]]);
}
