// Predictive motion model for the cube — from past frames we estimate position, scale,
// velocity and angular velocity, so when the cube is LOST for a while we can extrapolate
// where it is, and so we can REJECT detections far from where the cube must be (out-of-cube
// clutter) silently. Frame-based with EMA smoothing + friction damping.

export interface Quat { x: number; y: number; z: number; w: number }
export interface Pt { x: number; y: number }

const qmul = (a: Quat, b: Quat): Quat => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const qconj = (a: Quat): Quat => ({ w: a.w, x: -a.x, y: -a.y, z: -a.z });
const qnorm = (a: Quat): Quat => { const l = Math.hypot(a.x, a.y, a.z, a.w) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l, w: a.w / l }; };
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qdamp = (q: Quat, k: number): Quat => qnorm({ x: q.x * k, y: q.y * k, z: q.z * k, w: q.w + (1 - q.w) * (1 - k) });

export class CubeMotion {
  pos: Pt | null = null;
  vel: Pt = { x: 0, y: 0 };
  pitch = 0;
  quat: Quat = { ...ID };
  private dQuat: Quat = { ...ID };
  lost = 0;
  private maxCoast = 45;

  observe(pos: Pt, pitch: number, quat: Quat) {
    if (this.pos && this.lost <= 3) {
      const nvx = pos.x - this.pos.x, nvy = pos.y - this.pos.y;
      const lim = 2.5 * (pitch || 30);
      const cvx = Math.max(-lim, Math.min(lim, nvx)), cvy = Math.max(-lim, Math.min(lim, nvy));
      this.vel.x = 0.5 * this.vel.x + 0.5 * cvx; this.vel.y = 0.5 * this.vel.y + 0.5 * cvy;
      this.dQuat = qdamp(qmul(quat, qconj(this.quat)), 0.6);
    } else { this.vel.x = 0; this.vel.y = 0; this.dQuat = { ...ID }; }
    this.pos = { ...pos }; this.pitch = pitch; this.quat = qnorm(quat); this.lost = 0;
  }

  predict(): Pt | null {
    if (!this.pos || this.lost >= this.maxCoast) { if (this.lost >= this.maxCoast) this.pos = null; this.lost++; return null; }
    this.pos = { x: this.pos.x + this.vel.x, y: this.pos.y + this.vel.y };
    this.vel.x *= 0.9; this.vel.y *= 0.9;
    this.dQuat = qdamp(this.dQuat, 0.9);
    this.quat = qnorm(qmul(this.dQuat, this.quat));
    this.lost++;
    return this.pos;
  }

  // is a point plausibly ON the tracked cube? (used to reject out-of-cube clutter — silent)
  contains(p: Pt): boolean {
    if (!this.pos) return true;                         // no track yet → accept everything
    const r = 3 * (this.pitch || 30) + this.speed() * 3 + 70;   // generous; grows with speed
    return Math.hypot(p.x - this.pos.x, p.y - this.pos.y) < r;
  }

  speed(): number { return Math.hypot(this.vel.x, this.vel.y); }
  confidence(): number { return Math.max(0, 1 - this.lost / this.maxCoast); }
  reset() { this.pos = null; this.vel = { x: 0, y: 0 }; this.quat = { ...ID }; this.dQuat = { ...ID }; this.lost = 0; }
}
