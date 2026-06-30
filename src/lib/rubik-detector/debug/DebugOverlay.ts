// Minimal overlay: only the grey silhouette contour of the detected cube.

import type { CubeDetection } from "../types";

export class DebugOverlay {
  draw(ctx: CanvasRenderingContext2D, det: CubeDetection): void {
    if (!det.hull || det.hull.length === 0) return;

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(det.hull[0].x, det.hull[0].y);
    for (let i = 1; i < det.hull.length; i++) ctx.lineTo(det.hull[i].x, det.hull[i].y);
    ctx.closePath();
    ctx.stroke();
  }
}
