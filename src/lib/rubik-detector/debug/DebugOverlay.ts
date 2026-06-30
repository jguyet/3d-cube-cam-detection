// Minimal overlay: grey silhouette contour + persistent tracked corner points.

import type { CubeDetection, Point2 } from "../types";
import { dist, dpClosed, topKCorners } from "../utils/geometry";

type CornerTrack = {
  id: number;
  x: number;
  y: number;
  age: number;
  misses: number;
};

export class DebugOverlay {
  private tracks: CornerTrack[] = [];
  private nextId = 1;

  draw(ctx: CanvasRenderingContext2D, det: CubeDetection): void {
    const hull = det.hull;
    if (!hull || hull.length === 0) {
      this.fadeTracks();
      return;
    }

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
    ctx.stroke();

    this.updateTracks(det);
    this.drawTracks(ctx);
  }

  private updateTracks(det: CubeDetection): void {
    const hull = det.hull;
    if (!hull || hull.length === 0) {
      this.fadeTracks();
      return;
    }
    const observed = this.extractCorners(det);
    const threshold = this.matchThreshold(hull);
    const usedTracks = new Set<number>();
    const usedObserved = new Set<number>();

    while (true) {
      let bestTrack = -1;
      let bestObserved = -1;
      let bestDist = threshold;

      for (let ti = 0; ti < this.tracks.length; ti++) {
        if (usedTracks.has(ti)) continue;
        const track = this.tracks[ti];
        for (let oi = 0; oi < observed.length; oi++) {
          if (usedObserved.has(oi)) continue;
          const d = Math.hypot(track.x - observed[oi].x, track.y - observed[oi].y);
          if (d < bestDist) {
            bestDist = d;
            bestTrack = ti;
            bestObserved = oi;
          }
        }
      }

      if (bestTrack === -1 || bestObserved === -1) break;

      const track = this.tracks[bestTrack];
      const corner = observed[bestObserved];
      track.x = this.mix(track.x, corner.x, 0.42);
      track.y = this.mix(track.y, corner.y, 0.42);
      track.age += 1;
      track.misses = 0;
      usedTracks.add(bestTrack);
      usedObserved.add(bestObserved);
    }

    for (let i = 0; i < this.tracks.length; i++) {
      if (!usedTracks.has(i)) this.tracks[i].misses += 1;
    }

    for (let i = 0; i < observed.length; i++) {
      if (usedObserved.has(i)) continue;
      this.tracks.push({
        id: this.nextId++,
        x: observed[i].x,
        y: observed[i].y,
        age: 1,
        misses: 0,
      });
    }

    this.tracks = this.tracks.filter((track) => track.misses <= 5);
    const maxTracks = Math.min(observed.length, this.maxVisibleContourCorners(det));
    if (this.tracks.length > maxTracks) {
      this.tracks.sort((a, b) => (b.age - b.misses * 3) - (a.age - a.misses * 3));
      this.tracks.length = maxTracks;
    }
  }

  private extractCorners(det: CubeDetection): Point2[] {
    const hull = det.hull;
    const pts: Point2[] = [];
    if (!hull || hull.length === 0) return pts;
    const peri = hull.reduce((sum, p, i) => sum + dist(p, hull[(i + 1) % hull.length]), 0);
    let hullCorners = dpClosed(hull, peri * 0.018);
    if (hullCorners.length > 8) hullCorners = topKCorners(hullCorners, 8);

    for (const p of hullCorners) {
      pts.push({ x: p.x, y: p.y });
    }

    return pts;
  }

  private drawTracks(ctx: CanvasRenderingContext2D): void {
    for (const track of this.tracks) {
      const alpha = track.misses > 0 ? 0.55 : Math.min(0.95, 0.45 + track.age * 0.06);
      ctx.beginPath();
      ctx.arc(track.x, track.y, 4.25, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.28, alpha * 0.32)})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(track.x, track.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
    }
  }

  private fadeTracks(): void {
    this.tracks.forEach((track) => {
      track.misses += 1;
    });
    this.tracks = this.tracks.filter((track) => track.misses <= 5);
  }

  private matchThreshold(hull: Point2[]): number {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of hull) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return Math.max(10, Math.hypot(maxX - minX, maxY - minY) * 0.08);
  }

  private mix(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private maxVisibleContourCorners(det: CubeDetection): number {
    if (det.nFaces <= 1) return 4;
    return 6;
  }
}
