// Isolates the cube's silhouette per frame — no temporal/background model.
//
// Coloured stickers are the reliable cube anchor: the background (walls,
// cabinets, skin) is never vividly saturated. The dominant coloured cluster's
// convex hull bounds the cube, so a WHITE region is treated as a sticker only
// when it is bounded (does not bleed to the frame border, unlike a wall) and
// lies inside/near that hull. A white face is kept; a white wall — alone OR
// touching the cube — is not. No assumption is made about the background colour.

import type { Point2 } from "../types";
import { convexHull, polygonArea } from "../utils/geometry";

export interface SilhouetteResult {
  hull: Point2[] | null;
  fillFrac: number; // hull area / frame area
}

export class Silhouette {
  detect(img: ImageData, sThresh = 0.5, vThresh = 0.25): SilhouetteResult {
    const w = img.width, h = img.height, d = img.data;

    const colorMask = new Uint8Array(w * h);
    const whiteSeed = new Uint8Array(w * h);
    const whiteCandidate = new Uint8Array(w * h);
    const skinMask = new Uint8Array(w * h);

    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const dl = mx - mn;
      const s = mx === 0 ? 0 : dl / mx;
      const v = mx / 255;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      let hue = 0;
      if (dl) {
        if (mx === r) hue = (((g - b) / dl) % 6);
        else if (mx === g) hue = (b - r) / dl + 2;
        else hue = (r - g) / dl + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      const warmRgb = r >= g * 0.9 && g >= b * 0.88 && r - b >= 18;
      const warmHue = (hue <= 48 || hue >= 350) && s >= 0.12 && s <= 0.58 && v >= 0.28;
      const skinYcc = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 183 && y >= 55;
      const skin = (warmRgb && warmHue) || (skinYcc && s <= 0.62 && r > b);
      if (skin) { skinMask[j] = 1; continue; }

      if (s > sThresh && v > vThresh) { colorMask[j] = 1; continue; }

      // bright-neutral white candidate (broad; the structural test cleans it up)
      if (dl <= 90 && v >= 0.45 && mn >= 80 && s <= 0.5) {
        whiteCandidate[j] = 1;
        if (dl <= 72 && v >= 0.5 && mn >= 95) whiteSeed[j] = 1;
      }
    }

    const skinExpanded = this.dilate(skinMask, w, h, 2);

    // coloured cluster → convex hull bounds the cube
    const coloredCluster = this.largestComponentMask(this.dilate(colorMask, w, h, 7), w, h);
    const clusterPts: Point2[] = [];
    for (let i = 0; i < coloredCluster.length; i++) if (coloredCluster[i]) clusterPts.push({ x: i % w, y: (i / w) | 0 });

    // No coloured anchor (e.g. a plain white wall) → no cube. White is NEVER
    // added on its own, so a white wall can't masquerade as a cube.
    if (clusterPts.length < w * h * 0.004) return { hull: null, fillFrac: 0 };

    const cHull = convexHull(clusterPts);
    const nearHull = this.nearHullMask(cHull, w, h, 12);
    const acceptedWhite = this.filterWhiteComponents(whiteCandidate, nearHull, skinExpanded, w, h);

    let mask: Uint8Array = new Uint8Array(colorMask);
    for (let i = 0; i < mask.length; i++) {
      if (acceptedWhite[i] || (whiteSeed[i] && nearHull[i])) mask[i] = 1;
    }

    // Morphological close (dilate→erode): bridges the black gaps into one blob
    // without the extra outward bloat a plain dilation leaves — tighter contour.
    mask = this.dilate(mask, w, h, 4);
    mask = this.erode(mask, w, h, 3);

    const blob = this.largestComponent(mask, w, h);
    if (!blob || blob.length < w * h * 0.01) return { hull: null, fillFrac: 0 };

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

  // White component is part of the cube when bounded (not bleeding to the frame
  // border — that rejects a wall), inside the coloured hull, and not skin.
  private filterWhiteComponents(white: Uint8Array, nearHull: Uint8Array, skin: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    const vis = new Uint8Array(w * h);
    const stack: number[] = [];
    const component: number[] = [];
    const maxFace = Math.floor(w * h * 0.22);

    for (let s = 0; s < w * h; s++) {
      if (!white[s] || vis[s]) continue;
      vis[s] = 1;
      stack.length = 0;
      component.length = 0;
      stack.push(s);
      let inNear = 0, border = 0, touchSkin = 0;

      while (stack.length) {
        const n = stack.pop()!;
        component.push(n);
        const nx = n % w, ny = (n / w) | 0;
        if (nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1) border++;
        if (nearHull[n]) inNear++;
        if (skin[n]) touchSkin++;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const mx = nx + dx, my = ny + dy;
            if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
            const mm = my * w + mx;
            if (white[mm] && !vis[mm]) { vis[mm] = 1; stack.push(mm); }
          }
      }

      const size = component.length;
      const bounded = size <= maxFace && border <= 4;
      const inside = inNear >= size * 0.6;
      const skinSafe = touchSkin <= Math.max(2, Math.floor(size * 0.1));
      if (size >= 3 && bounded && inside && skinSafe) {
        for (const i of component) out[i] = 1;
      }
    }

    return out;
  }

  private largestComponentMask(m: Uint8Array, w: number, h: number): Uint8Array {
    const blob = this.largestComponent(m, w, h);
    const out = new Uint8Array(w * h);
    if (blob) for (const p of blob) out[p.y * w + p.x] = 1;
    return out;
  }

  // Filled convex hull, expanded by `expand` px (vertices pushed outward, then
  // scanline-filled — cheap, no per-pixel test or multi-iteration dilation).
  private nearHullMask(hull: Point2[], w: number, h: number, expand: number): Uint8Array {
    let cx = 0, cy = 0;
    for (const p of hull) { cx += p.x; cy += p.y; }
    cx /= hull.length; cy /= hull.length;
    const poly = hull.map((p) => {
      const dx = p.x - cx, dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * expand, y: p.y + (dy / len) * expand };
    });
    const m = new Uint8Array(w * h);
    let minY = Infinity, maxY = -Infinity;
    for (const p of poly) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      let xmin = Infinity, xmax = -Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
          xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
        }
      }
      if (xmin > xmax) continue;
      const xa = Math.max(0, Math.floor(xmin)), xb = Math.min(w - 1, Math.ceil(xmax));
      for (let x = xa; x <= xb; x++) m[y * w + x] = 1;
    }
    return m;
  }

  reset(): void {
    // stateless
  }
}
