// Temporal tracking of the geometric shapes across video frames. Each shape is
// matched to the nearest one in the previous frame (centroid + size), smoothed,
// and kept alive across brief misses. Only shapes seen for a few frames are
// reported as stable — this rejects per-frame flicker.

import type { Point2 } from "../types";
import { dist } from "../utils/geometry";
import type { Shape } from "./ShapeDetector";

export interface TrackedShape {
  id: number;
  corners: Point2[];
  center: Point2;
  area: number;
  age: number;
  misses: number;
  vx: number;
  vy: number;
}

export class ShapeTracker {
  private tracks: TrackedShape[] = [];
  private nextId = 1;
  private maxMisses: number;
  private minAge: number;
  private holdFrames: number;

  constructor(maxMisses = 6, minAge = 2, holdFrames = 3) {
    this.maxMisses = maxMisses;
    this.minAge = minAge;
    this.holdFrames = holdFrames;
  }

  update(shapes: Shape[]): TrackedShape[] {
    const usedTracks = new Set<number>();
    const usedShapes = new Set<number>();

    // greedy nearest-match: shape ↔ track, gated by size and distance
    while (true) {
      let bestTrack = -1, bestShape = -1, bestScore = Infinity;
      for (let ti = 0; ti < this.tracks.length; ti++) {
        if (usedTracks.has(ti)) continue;
        const tr = this.tracks[ti];
        // gate on the residual to the velocity-PREDICTED position (survives
        // fast hand motion); area is a soft penalty so distance dominates.
        const px = tr.center.x + tr.vx, py = tr.center.y + tr.vy;
        const reach = Math.max(28, Math.sqrt(tr.area) * 1.6);
        for (let si = 0; si < shapes.length; si++) {
          if (usedShapes.has(si)) continue;
          const sh = shapes[si];
          const dd = Math.hypot(px - sh.center.x, py - sh.center.y);
          if (dd > reach) continue;
          const ratio = tr.area > sh.area ? tr.area / sh.area : sh.area / tr.area;
          if (ratio > 2.5) continue; // survives a 2:1 same-colour merge/split
          const score = dd * Math.sqrt(ratio);
          if (score < bestScore) { bestScore = score; bestTrack = ti; bestShape = si; }
        }
      }
      if (bestTrack === -1) break;
      const tr = this.tracks[bestTrack];
      const sh = shapes[bestShape];
      const ncx = this.mix(tr.center.x, sh.center.x, 0.4), ncy = this.mix(tr.center.y, sh.center.y, 0.4);
      tr.vx = ncx - tr.center.x; tr.vy = ncy - tr.center.y;
      tr.corners = this.smoothCorners(tr.corners, sh.corners, 0.4);
      tr.center = { x: ncx, y: ncy };
      tr.area = this.mix(tr.area, sh.area, 0.4);
      tr.age += 1;
      tr.misses = 0;
      usedTracks.add(bestTrack);
      usedShapes.add(bestShape);
    }

    for (let i = 0; i < this.tracks.length; i++) if (!usedTracks.has(i)) this.tracks[i].misses += 1;
    for (let si = 0; si < shapes.length; si++) {
      if (usedShapes.has(si)) continue;
      const sh = shapes[si];
      this.tracks.push({ id: this.nextId++, corners: sh.corners.slice(), center: { ...sh.center }, area: sh.area, age: 1, misses: 0, vx: 0, vy: 0 });
    }

    this.tracks = this.tracks.filter((t) => t.misses <= this.maxMisses);
    // hold briefly-missed tracks at their last pose (no single-frame flicker)
    return this.tracks.filter((t) => t.age >= this.minAge && t.misses <= this.holdFrames);
  }

  reset(): void { this.tracks = []; }

  private smoothCorners(a: Point2[], b: Point2[], t: number): Point2[] {
    // align b to a by best rotation of the 4-corner ordering
    let best = b, bestD = Infinity;
    for (let r = 0; r < 4; r++) {
      const rot = [b[r % 4], b[(r + 1) % 4], b[(r + 2) % 4], b[(r + 3) % 4]];
      let dsum = 0;
      for (let i = 0; i < 4; i++) dsum += dist(a[i], rot[i]);
      if (dsum < bestD) { bestD = dsum; best = rot; }
    }
    return a.map((p, i) => ({ x: this.mix(p.x, best[i].x, t), y: this.mix(p.y, best[i].y, t) }));
  }

  private mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
}
