// Temporal face tracker — kills SHIFT (frame-to-frame jumping of the 3×3). It keeps 9
// persistent slots and, each frame: (1) rigidly pre-aligns them to the new detection by
// the centroid delta so bulk motion doesn't relabel, (2) matches each detected/predicted
// cell to its nearest slot (stable gx,gy — no BFS-origin flips), (3) EMA-smooths the slot
// position/corners (snappier under fast motion), (4) votes each slot's colour over a short
// history (no flicker), (5) persists a briefly-missing slot instead of dropping it.

import type { DetectedFace } from "@/lib/ml/shapeGraph";
import type { CubeColour } from "@/lib/ml/stickerColor";

export interface Slot {
  gx: number; gy: number; cx: number; cy: number; corners: { x: number; y: number }[];
  hist: CubeColour[]; miss: number; detected: boolean;
}

const d2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
function mode(h: CubeColour[]): CubeColour {
  const m = new Map<CubeColour, number>(); let best: CubeColour = "unknown", bc = 0;
  for (const c of h) { const n = (m.get(c) ?? 0) + 1; m.set(c, n); if (n > bc) { bc = n; best = c; } }
  return best;
}

export class FaceTracker {
  slots: Slot[] | null = null;
  private maxMiss = 6;
  private histLen = 6;
  private jumpMiss = 0;         // consecutive far-detection frames (anti-teleport)
  private reacquireK = 4;       // a jump must persist this many frames before it's accepted

  private centroid(): { x: number; y: number } {
    const s = this.slots!; let x = 0, y = 0; for (const p of s) { x += p.cx; y += p.cy; } return { x: x / s.length, y: y / s.length };
  }

  update(face: DetectedFace | null): Slot[] {
    if (!face) {
      if (!this.slots) return [];
      for (const s of this.slots) s.miss++;
      this.slots = this.slots.filter((s) => s.miss <= this.maxMiss);
      if (!this.slots.length) this.slots = null;
      return this.slots ?? [];
    }
    const cells = face.cells, pitch = face.pitch || 30;
    let cx = 0, cy = 0; for (const c of cells) { cx += c.center.x; cy += c.center.y; } cx /= cells.length; cy /= cells.length;
    const acquire = () => (this.slots = cells.map((c) => ({ gx: c.gx, gy: c.gy, cx: c.center.x, cy: c.center.y, corners: c.corners.map((p) => ({ ...p })), hist: [c.colour], miss: 0, detected: c.detected })));

    if (!this.slots) { this.jumpMiss = 0; return acquire(); }

    // ANTI-TELEPORT: a real move is continuous (small per-frame step); a far detection in
    // ONE frame is almost always a misdetection elsewhere. Don't snap to it — COAST the
    // existing track and only re-acquire if the far position PERSISTS for reacquireK frames.
    if (d2(cx, cy, this.centroid().x, this.centroid().y) > pitch * 2.2) {
      if (++this.jumpMiss < this.reacquireK) {
        for (const s of this.slots) s.miss++;
        this.slots = this.slots.filter((s) => s.miss <= this.maxMiss);
        if (this.slots.length) return this.slots;              // HOLD the last good pose (no teleport)
      }
      this.jumpMiss = 0; return acquire();                     // sustained → accept the new position
    }
    this.jumpMiss = 0;

    // rigid pre-align: remove bulk translation so matching sees only per-cell residual
    const sc = this.centroid(); const dx = cx - sc.x, dy = cy - sc.y;
    for (const s of this.slots) { s.cx += dx; s.cy += dy; for (const p of s.corners) { p.x += dx; p.y += dy; } }
    const moved = Math.hypot(dx, dy);
    const a = moved > pitch * 0.5 ? 0.75 : 0.35;   // snappier when the cube moves fast

    const used = new Set<number>();
    for (const c of cells) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < this.slots.length; i++) { if (used.has(i)) continue; const dd = d2(c.center.x, c.center.y, this.slots[i].cx, this.slots[i].cy); if (dd < bd) { bd = dd; bi = i; } }
      if (bi < 0 || bd > pitch * 0.7) continue;
      used.add(bi); const s = this.slots[bi];
      s.cx += a * (c.center.x - s.cx); s.cy += a * (c.center.y - s.cy);
      for (let k = 0; k < 4 && k < c.corners.length; k++) { s.corners[k].x += a * (c.corners[k].x - s.corners[k].x); s.corners[k].y += a * (c.corners[k].y - s.corners[k].y); }
      s.hist.push(c.colour); if (s.hist.length > this.histLen) s.hist.shift();
      s.miss = 0; s.detected = c.detected;
    }
    for (let i = 0; i < this.slots.length; i++) if (!used.has(i)) this.slots[i].miss++;
    this.slots = this.slots.filter((s) => s.miss <= this.maxMiss);
    if (!this.slots.length) this.slots = null;
    return this.slots ?? [];
  }

  colourOf(s: Slot): CubeColour { return mode(s.hist); }
  reset(): void { this.slots = null; }
}
