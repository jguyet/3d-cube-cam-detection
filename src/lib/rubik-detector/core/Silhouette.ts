// Isolates the cube's silhouette by SATURATION. The cube's stickers are highly
// saturated; the kitchen background, skin and hand are not. This separates the
// cube far more reliably than gray edges (which catch the whole scene).

import type { Point2 } from "../types";
import { convexHull, polygonArea } from "../utils/geometry";

export interface SilhouetteResult {
  hull: Point2[] | null;
  fillFrac: number; // hull area / frame area
}

export class Silhouette {
  // sThresh: minimum saturation to count as a sticker. vThresh: minimum value
  // (reject near-black). Skin is rejected explicitly: it is warm-hued and only
  // moderately saturated, whereas stickers are vividly saturated — without this
  // the convex hull engulfs the hand holding the cube.
  detect(img: ImageData, sThresh = 0.5, vThresh = 0.25): SilhouetteResult {
    const w = img.width, h = img.height, d = img.data;

    let mask: Uint8Array = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const dl = mx - mn;
      const s = mx === 0 ? 0 : dl / mx;
      const v = mx / 255;
      if (s <= sThresh || v <= vThresh) continue;
      // hue
      let hue = 0;
      if (dl) {
        if (mx === r) hue = (((g - b) / dl) % 6);
        else if (mx === g) hue = (b - r) / dl + 2;
        else hue = (r - g) / dl + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      const skin = (hue <= 45 || hue >= 350) && s >= 0.15 && s <= 0.55 && v >= 0.35 && r >= g && g >= b;
      if (!skin) mask[j] = 1;
    }

    // Opening (erode→dilate) removes thin finger bridges and speckle, then a
    // dilation closes the lattice of stickers into one solid blob.
    mask = this.erode(mask, w, h, 2);
    mask = this.dilate(mask, w, h, 2);
    mask = this.dilate(mask, w, h, 3);

    const blob = this.largestComponent(mask, w, h);
    if (!blob || blob.length < w * h * 0.015) return { hull: null, fillFrac: 0 };

    const hull = convexHull(blob);
    return { hull, fillFrac: polygonArea(hull) / (w * h) };
  }

  private dilate(m: Uint8Array, w: number, h: number, iters: number): Uint8Array {
    for (let it = 0; it < iters; it++) {
      const o = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (m[i] || m[i - 1] || m[i + 1] || m[i - w] || m[i + w] ||
              m[i - w - 1] || m[i - w + 1] || m[i + w - 1] || m[i + w + 1]) o[i] = 1;
        }
      m = o;
    }
    return m;
  }

  private erode(m: Uint8Array, w: number, h: number, iters: number): Uint8Array {
    for (let it = 0; it < iters; it++) {
      const o = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] &&
              m[i - w - 1] && m[i - w + 1] && m[i + w - 1] && m[i + w + 1]) o[i] = 1;
        }
      m = o;
    }
    return m;
  }

  private largestComponent(m: Uint8Array, w: number, h: number): Point2[] | null {
    const vis = new Uint8Array(w * h);
    const stack: number[] = [];
    let best: Point2[] | null = null, bestN = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || vis[s]) continue;
      vis[s] = 1; stack.length = 0; stack.push(s);
      const pts: Point2[] = [];
      while (stack.length) {
        const n = stack.pop()!;
        const nx = n % w, ny = (n / w) | 0;
        pts.push({ x: nx, y: ny });
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const mx = nx + dx, my = ny + dy;
            if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
            const mm = my * w + mx;
            if (m[mm] && !vis[mm]) { vis[mm] = 1; stack.push(mm); }
          }
      }
      if (pts.length > bestN) { bestN = pts.length; best = pts; }
    }
    return best;
  }
}
