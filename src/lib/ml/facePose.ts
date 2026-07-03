// Orientation of a detected face from its 3×3 corner cells — the "gyroscope". A cube
// face is a SQUARE in 3D; its two in-plane axes project to the image as the vectors
// c00→c20 (u) and c00→c02 (v). Under an orthographic approximation, a unit 3D axis that
// projects to image vector (x,y) (scaled by the un-foreshortened face size) has depth
// z = √(1−x²−y²): the foreshortening directly gives the tilt. We reconstruct u,v,n in 3D
// and return a quaternion. Image Y is down → we flip Y for a Y-up (three.js) world.

export interface Quat { x: number; y: number; z: number; w: number }

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// c00,c20,c02 = image centres of the face's corner cells (top-left, top-right, bottom-left)
export function orientationFromFace(c00: { x: number; y: number }, c20: { x: number; y: number }, c02: { x: number; y: number }): Quat {
  // image axis vectors (Y down → negate y for a Y-up world)
  const uimg: [number, number] = [c20.x - c00.x, -(c20.y - c00.y)];
  const vimg: [number, number] = [c02.x - c00.x, -(c02.y - c00.y)];
  const su = Math.hypot(uimg[0], uimg[1]), sv = Math.hypot(vimg[0], vimg[1]);
  const frontal = Math.max(su, sv, 1);            // the un-foreshortened face size
  const ux = uimg[0] / frontal, uy = uimg[1] / frontal;
  const vx = vimg[0] / frontal, vy = vimg[1] / frontal;
  const uz = Math.sqrt(Math.max(0, 1 - ux * ux - uy * uy));   // depth from foreshortening (tilt toward +z)
  const vz = Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy));
  let u: V3 = norm([ux, uy, uz]);
  let v: V3 = [vx, vy, vz];
  // Gram–Schmidt: make v ⟂ u, then n = u×v (outward face normal, toward camera)
  v = norm(sub(v, [u[0] * dot3(u, v), u[1] * dot3(u, v), u[2] * dot3(u, v)]));
  const n = norm(cross(u, v));
  // rotation matrix columns = (u, v, n) → quaternion
  return matToQuat([u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2]]);
}

// row-major 3×3 → quaternion
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
