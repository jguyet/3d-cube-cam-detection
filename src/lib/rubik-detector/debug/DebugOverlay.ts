// Draws the detected cube faces over the live frame. Debug/visual only.

import type { CubeDetection } from "../types";

const FACE_FILL = ["rgba(255,80,80,0.38)", "rgba(80,220,120,0.38)", "rgba(90,150,255,0.38)"];

export class DebugOverlay {
  draw(ctx: CanvasRenderingContext2D, det: CubeDetection): void {
    if (!det.hull || det.faces.length === 0) return;

    // Faint silhouette.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(det.hull[0].x, det.hull[0].y);
    for (let i = 1; i < det.hull.length; i++) ctx.lineTo(det.hull[i].x, det.hull[i].y);
    ctx.closePath();
    ctx.stroke();

    // Each face filled + outlined.
    det.faces.forEach((f, i) => {
      ctx.beginPath();
      ctx.moveTo(f[0].x, f[0].y);
      for (let k = 1; k < f.length; k++) ctx.lineTo(f[k].x, f[k].y);
      ctx.closePath();
      ctx.fillStyle = FACE_FILL[i % FACE_FILL.length];
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    });

    // Shared near-corner for the 3-face case.
    if (det.center) {
      ctx.fillStyle = "#ffe000";
      ctx.beginPath();
      ctx.arc(det.center.x, det.center.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Live decision readout (so a screenshot explains the classification).
    if (det.debug) {
      const d = det.debug;
      const txt = `n=${det.nFaces}  coins:${d.corners}  bal:${d.balance.toFixed(2)}  arete:${d.sup2.toFixed(2)}  rempl:${d.fillFrac.toFixed(2)}`;
      ctx.font = "bold 11px ui-monospace, monospace";
      const wTxt = ctx.measureText(txt).width + 10;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(4, 4, wTxt, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(txt, 9, 17);
    }
  }
}
