// Hybrid step 1: within the ML-detected cube ZONE, snap to the real cube by a
// CLASSICAL silhouette — the colourful stickers form a compact high-saturation
// blob; its convex hull (simplified) is the cube's outer outline, precise to the
// pixel. Runs only inside the ML bbox, where classical CV is reliable.

import { convexHull, dpClosed } from "@/lib/rubik-detector/utils/geometry";

export interface Point2 { x: number; y: number }

// bbox in normalised 0..1 frame coords (from the ML corners).
export function refineCubeSilhouette(
  img: ImageData,
  bbox: { cx: number; cy: number; w: number; h: number },
): { hull: Point2[]; poly: Point2[] } | null {
  const W = img.width, H = img.height, d = img.data;
  // expand the ML bbox a bit and clamp
  const pad = 0.12;
  const x0 = Math.max(0, Math.floor((bbox.cx - bbox.w / 2 - pad * bbox.w) * W));
  const x1 = Math.min(W, Math.ceil((bbox.cx + bbox.w / 2 + pad * bbox.w) * W));
  const y0 = Math.max(0, Math.floor((bbox.cy - bbox.h / 2 - pad * bbox.h) * H));
  const y1 = Math.min(H, Math.ceil((bbox.cy + bbox.h / 2 + pad * bbox.h) * H));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;

  // collect colourful pixels (cube stickers) — skin/background are low-saturation
  const step = Math.max(1, Math.floor((x1 - x0) / 120));
  const pts: Point2[] = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      if (sat > 0.42 && mx > 70) pts.push({ x, y });   // saturated sticker colour
    }
  }
  if (pts.length < 25) return null;

  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  // simplify the hull to the cube's outline (a cube silhouette ≈ 4-6 vertices)
  let peri = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    peri += Math.hypot(a.x - b.x, a.y - b.y);
  }
  const poly = dpClosed(hull, peri * 0.02);
  return { hull, poly };
}
