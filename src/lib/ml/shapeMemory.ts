// Learned SHAPE signature of this cube's stickers, to reject out-of-cube false
// positives. Analogous to ColourMemory. We learn ONLY from stickers confirmed
// inside a coherent 3×3 grid (guaranteed real), then a candidate quad that is
// geometrically inconsistent with that learned profile is dropped.
//
// Features are pose-robust (invariant to distance; tolerant to moderate tilt):
//   fill  = area / min-area-rect area  (solidity: a real facelet ~fills its rect)
//   aspect= long side / short side     (near-square)
//   skew  = worst corner-angle deviation from 90° (a facelet is a parallelogram-ish
//           quad; a random blob has irregular angles)

export interface QuadLike { corners: { x: number; y: number }[]; area: number; fill: number }

function feats(s: QuadLike): { fill: number; aspect: number; skew: number } | null {
  const c = s.corners;
  if (!c || c.length < 4) return null;
  const side = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const s1 = side(c[0], c[1]), s2 = side(c[1], c[2]), s3 = side(c[2], c[3]), s4 = side(c[3], c[0]);
  const lo = Math.min(s1, s2, s3, s4), hi = Math.max(s1, s2, s3, s4);
  if (lo < 1e-3) return null;
  // corner angles
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const p = c[(i + 3) % 4], q = c[i], r = c[(i + 1) % 4];
    const a = { x: p.x - q.x, y: p.y - q.y }, b = { x: r.x - q.x, y: r.y - q.y };
    const dot = a.x * b.x + a.y * b.y, mag = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    worst = Math.max(worst, Math.abs(ang - 90));
  }
  return { fill: s.fill, aspect: hi / lo, skew: worst };
}

interface Stat { m: number; v: number; n: number }   // running mean / variance (EMA)

export class ShapeMemory {
  fill: Stat = { m: 0.85, v: 0.01, n: 0 };
  aspect: Stat = { m: 1.1, v: 0.02, n: 0 };
  skew: Stat = { m: 12, v: 60, n: 0 };
  private a = 0.05;

  private upd(st: Stat, x: number) {
    if (st.n === 0) { st.m = x; st.v = st === this.skew ? 60 : 0.02; }
    else { const d = x - st.m; st.m += this.a * d; st.v = (1 - this.a) * (st.v + this.a * d * d); }
    st.n++;
  }

  // Feed a sticker CONFIRMED to be on the cube (part of a coherent grid).
  learn(s: QuadLike): void {
    const f = feats(s); if (!f) return;
    this.upd(this.fill, f.fill); this.upd(this.aspect, f.aspect); this.upd(this.skew, f.skew);
  }

  ready(): boolean { return this.fill.n >= 12; }

  // Is this candidate quad geometrically consistent with the learned stickers?
  // Loose (±k·σ, with floors) so it only drops CLEAR outliers — real stickers vary.
  plausible(s: QuadLike): boolean {
    if (!this.ready()) return true;   // bootstrap: accept until we've learned enough
    const f = feats(s); if (!f) return true;
    const sd = (st: Stat, floor: number) => Math.max(floor, Math.sqrt(Math.max(0, st.v)));
    // Lenient — perspective shears stickers (aspect↑, corner-skew↑) and shading
    // varies fill, so only reject CLEAR outliers (a background L-shape / thin sliver
    // / very hollow blob), never a foreshortened facelet.
    if (f.fill < this.fill.m - 4 * sd(this.fill, 0.1) && f.fill < 0.55) return false;   // genuinely hollow
    if (f.aspect > this.aspect.m + 4 * sd(this.aspect, 0.2) + 0.5) return false;         // clearly elongated
    if (f.skew > this.skew.m + 4 * sd(this.skew, 10) + 15) return false;                 // corners very irregular
    return true;
  }

  load(key = "rubix-shape"): void {
    try { const s = typeof localStorage !== "undefined" && localStorage.getItem(key); if (s) Object.assign(this, JSON.parse(s)); } catch { /* ignore */ }
  }
  save(key = "rubix-shape"): void {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify({ fill: this.fill, aspect: this.aspect, skew: this.skew })); } catch { /* ignore */ }
  }
}
