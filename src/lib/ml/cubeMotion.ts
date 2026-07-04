// Predictive motion model for the cube — from past frames we estimate position, scale,
// velocity and angular velocity, so when the cube is momentarily LOST (out of frame,
// occluded, motion-blurred) we EXTRAPOLATE where it is instead of dropping it. Also speeds
// up re-acquisition: the reappearing cube is matched near the predicted position.
// Frame-based (constant-frame-rate assumption) with EMA smoothing + friction damping.

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
// nudge a delta-rotation toward identity (damp angular velocity while coasting)
const qdamp = (q: Quat, k: number): Quat => qnorm({ x: q.x * k, y: q.y * k, z: q.z * k, w: q.w + (1 - q.w) * (1 - k) });

export class CubeMotion {
  pos: Pt | null = null;
  vel: Pt = { x: 0, y: 0 };
  pitch = 0;
  quat: Quat = { ...ID };
  private dQuat: Quat = { ...ID };   // per-frame rotation delta (angular velocity)
  lost = 0;                          // consecutive predicted (unseen) frames
  private maxCoast = 45;             // ~1.5 s at 30 fps before we give up

  // a real observation this frame
  observe(pos: Pt, pitch: number, quat: Quat) {
    if (this.pos && this.lost <= 3) {
      const nvx = pos.x - this.pos.x, nvy = pos.y - this.pos.y;
      // clamp a single-frame jump so a teleport-misdetection can't spike the velocity
      const lim = 2.5 * (pitch || 30);
      const cvx = Math.max(-lim, Math.min(lim, nvx)), cvy = Math.max(-lim, Math.min(lim, nvy));
      this.vel.x = 0.5 * this.vel.x + 0.5 * cvx; this.vel.y = 0.5 * this.vel.y + 0.5 * cvy;
      this.dQuat = qdamp(qmul(quat, qconj(this.quat)), 0.6);
    } else { this.vel.x = 0; this.vel.y = 0; this.dQuat = { ...ID }; }
    this.pos = { ...pos }; this.pitch = pitch; this.quat = qnorm(quat); this.lost = 0;
  }

  // no detection this frame → coast forward on the motion model. Returns the predicted
  // position (may be off-screen), or null once we've coasted too long.
  predict(): Pt | null {
    if (!this.pos || this.lost >= this.maxCoast) { if (this.lost >= this.maxCoast) this.pos = null; this.lost++; return null; }
    this.pos = { x: this.pos.x + this.vel.x, y: this.pos.y + this.vel.y };
    this.vel.x *= 0.9; this.vel.y *= 0.9;                 // friction
    this.dQuat = qdamp(this.dQuat, 0.9);
    this.quat = qnorm(qmul(this.dQuat, this.quat));         // extrapolate orientation
    this.lost++;
    return this.pos;
  }

  speed(): number { return Math.hypot(this.vel.x, this.vel.y); }               // px / frame
  confidence(): number { return Math.max(0, 1 - this.lost / this.maxCoast); }  // 1 → 0 as it coasts
  reset() { this.pos = null; this.vel = { x: 0, y: 0 }; this.quat = { ...ID }; this.dQuat = { ...ID }; this.lost = 0; }
}
