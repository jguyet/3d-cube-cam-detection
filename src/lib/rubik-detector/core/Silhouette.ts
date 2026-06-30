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
  private bgW = 0;
  private bgH = 0;
  private bgY: Float32Array | null = null;
  private bgCb: Float32Array | null = null;
  private bgCr: Float32Array | null = null;
  private motionHold: Uint8Array | null = null;

  // sThresh: minimum saturation to count as a sticker. vThresh: minimum value
  // (reject near-black). Skin is rejected explicitly: it is warm-hued and only
  // moderately saturated, whereas stickers are vividly saturated — without this
  // the convex hull engulfs the hand holding the cube.
  detect(img: ImageData, sThresh = 0.5, vThresh = 0.25): SilhouetteResult {
    const w = img.width, h = img.height, d = img.data;

    const colorMask: Uint8Array = new Uint8Array(w * h);
    const whiteSeed: Uint8Array = new Uint8Array(w * h);
    const whiteCandidate: Uint8Array = new Uint8Array(w * h);
    const darkGapMask: Uint8Array = new Uint8Array(w * h);
    const skinMask: Uint8Array = new Uint8Array(w * h);
    const luma = new Float32Array(w * h);
    const cbMap = new Float32Array(w * h);
    const crMap = new Float32Array(w * h);
    this.ensureTemporalBuffers(w, h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const dl = mx - mn;
      const s = mx === 0 ? 0 : dl / mx;
      const v = mx / 255;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      luma[j] = y;
      cbMap[j] = cb;
      crMap[j] = cr;
      if (v <= 0.22 || y <= 58) darkGapMask[j] = 1;
      // hue
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
      if (skin) skinMask[j] = 1;
      if (!skin && s > sThresh && v > vThresh) {
        colorMask[j] = 1;
        continue;
      }
      // White stickers are often cool-tinted or slightly greyed by exposure.
      // Keep a strict seed, then a broader candidate that must later survive
      // colour support, dark cube-gap support and skin rejection.
      const neutralRgb =
        dl <= 72 &&
        Math.abs(r - g) <= 46 &&
        Math.abs(g - b) <= 52 &&
        Math.abs(r - b) <= 58;
      const neutralYcc = Math.abs(cb - 128) <= 24 && Math.abs(cr - 128) <= 24;
      const whiteBright = y >= 134 && v >= 0.5 && mx >= 150 && mn >= 88;
      if (!skin && neutralRgb && neutralYcc && whiteBright && s <= 0.4) {
        whiteSeed[j] = 1;
        whiteCandidate[j] = 1;
        continue;
      }

      const softNeutralRgb =
        dl <= 96 &&
        Math.abs(r - g) <= 60 &&
        Math.abs(g - b) <= 64 &&
        Math.abs(r - b) <= 76;
      const softNeutralYcc = Math.abs(cb - 128) <= 34 && Math.abs(cr - 128) <= 28;
      const coolOrNeutral = b >= r - 24 && b >= g - 24;
      const candidateWhite = y >= 116 && v >= 0.44 && mx >= 134 && mn >= 70;
      if (!skin && softNeutralRgb && softNeutralYcc && candidateWhite && s <= 0.5 && (coolOrNeutral || cr <= 140)) {
        whiteCandidate[j] = 1;
      }
    }

    const movingNow = this.computeMovingMask(luma, cbMap, crMap, w, h);
    const cubeSeed = new Uint8Array(w * h);
    for (let i = 0; i < cubeSeed.length; i++) cubeSeed[i] = colorMask[i] || whiteSeed[i] ? 1 : 0;

    const support = this.dilate(cubeSeed, w, h, 6);
    const darkSupport = this.dilate(darkGapMask, w, h, 2);
    const skinExpanded = this.dilate(skinMask, w, h, 2);
    const movingRecent = this.movingRecentMask(w, h);
    const filteredWhite = this.filterWhiteComponents(
      whiteCandidate,
      cubeSeed,
      support,
      darkSupport,
      skinExpanded,
      movingNow,
      movingRecent,
      w,
      h,
    );
    const whiteExpandedFiltered = this.dilate(filteredWhite, w, h, 1);
    let mask: Uint8Array = new Uint8Array(colorMask);
    for (let y = 3; y < h - 3; y++)
      for (let x = 3; x < w - 3; x++) {
        const i = y * w + x;
        if (!whiteExpandedFiltered[i] || !support[i] || skinExpanded[i]) continue;
        let seedNeighbours = 0;
        let darkNeighbours = 0;
        let contrastScore = 0;
        let brightNeighbours = 0;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            if (!dx && !dy) continue;
            const n = (y + dy) * w + (x + dx);
            if (cubeSeed[n]) seedNeighbours++;
            if (darkSupport[n]) darkNeighbours++;
            if (filteredWhite[n]) brightNeighbours++;
            contrastScore += Math.abs(luma[i] - luma[n]);
          }
        const meanContrast = contrastScore / 48;
        if (seedNeighbours >= 2 && darkNeighbours >= 3 && (meanContrast >= 12 || brightNeighbours >= 7 || seedNeighbours >= 6)) {
          mask[i] = 1;
        }
      }

    // Opening (erode→dilate) removes thin finger bridges and speckle, then a
    // dilation closes the lattice of stickers into one solid blob.
    mask = this.erode(mask, w, h, 2);
    mask = this.dilate(mask, w, h, 2);
    mask = this.dilate(mask, w, h, 3);
    for (let i = 0; i < mask.length; i++) {
      if (skinExpanded[i] && !cubeSeed[i]) mask[i] = 0;
      if (whiteSeed[i]) mask[i] = 1;
    }
    mask = this.dilate(mask, w, h, 1);
    this.updateBackground(luma, cbMap, crMap, mask, movingNow, w, h);

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

  private filterWhiteComponents(
    white: Uint8Array,
    cubeSeed: Uint8Array,
    support: Uint8Array,
    darkSupport: Uint8Array,
    skin: Uint8Array,
    movingNow: Uint8Array,
    movingRecent: Uint8Array,
    w: number,
    h: number,
  ): Uint8Array {
    const out = new Uint8Array(w * h);
    const vis = new Uint8Array(w * h);
    const stack: number[] = [];
    const component: number[] = [];
    const maxSize = Math.max(24, Math.floor(w * h * 0.02));

    for (let s = 0; s < w * h; s++) {
      if (!white[s] || vis[s]) continue;
      vis[s] = 1;
      stack.length = 0;
      component.length = 0;
      stack.push(s);
      let supportHits = 0;
      let seedAdj = 0;
      let darkBorder = 0;
      let touchSkin = 0;
      let movingHits = 0;
      let recentHits = 0;

      while (stack.length) {
        const n = stack.pop()!;
        component.push(n);
        const nx = n % w;
        const ny = (n / w) | 0;
        if (support[n]) supportHits++;
        if (movingNow[n]) movingHits++;
        if (movingRecent[n]) recentHits++;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const mx = nx + dx;
            const my = ny + dy;
            if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
            const mm = my * w + mx;
            if (cubeSeed[mm]) seedAdj++;
            if (darkSupport[mm]) darkBorder++;
            if (skin[mm]) touchSkin++;
            if (white[mm] && !vis[mm]) {
              vis[mm] = 1;
              stack.push(mm);
            }
          }
        }
      }

      const size = component.length;
      const plausibleSize = size >= 3 && size <= maxSize;
      const anchored = supportHits >= Math.max(2, Math.floor(size * 0.15)) && seedAdj >= 2;
      const structured = darkBorder >= Math.max(6, Math.floor(size * 0.35));
      const skinSafe = touchSkin <= Math.max(2, Math.floor(size * 0.1));
      const temporal = movingHits >= 1 || recentHits >= Math.max(1, Math.floor(size * 0.1));
      const staticStructured = anchored && structured && darkBorder >= Math.max(10, size);
      if (!plausibleSize || !anchored || !skinSafe || !(temporal || staticStructured)) continue;
      for (const i of component) out[i] = 1;
    }

    return out;
  }

  private ensureTemporalBuffers(w: number, h: number): void {
    if (this.bgW === w && this.bgH === h && this.bgY && this.bgCb && this.bgCr && this.motionHold) return;
    this.bgW = w;
    this.bgH = h;
    this.bgY = new Float32Array(w * h);
    this.bgCb = new Float32Array(w * h);
    this.bgCr = new Float32Array(w * h);
    this.motionHold = new Uint8Array(w * h);
  }

  private computeMovingMask(
    luma: Float32Array,
    cbMap: Float32Array,
    crMap: Float32Array,
    w: number,
    h: number,
  ): Uint8Array {
    const moving = new Uint8Array(w * h);
    const bgY = this.bgY!;
    const bgCb = this.bgCb!;
    const bgCr = this.bgCr!;
    const hold = this.motionHold!;
    const uninitialized = bgY[0] === 0 && bgCb[0] === 0 && bgCr[0] === 0;
    if (uninitialized) {
      for (let i = 0; i < bgY.length; i++) {
        bgY[i] = luma[i];
        bgCb[i] = cbMap[i];
        bgCr[i] = crMap[i];
      }
      return moving;
    }

    for (let i = 0; i < moving.length; i++) {
      const dy = Math.abs(luma[i] - bgY[i]);
      const dcb = Math.abs(cbMap[i] - bgCb[i]);
      const dcr = Math.abs(crMap[i] - bgCr[i]);
      const delta = dy + 0.55 * dcb + 0.55 * dcr;
      const active = delta >= 28 || (dy >= 16 && (dcb >= 7 || dcr >= 7));
      if (active) {
        moving[i] = 1;
        hold[i] = 8;
      } else if (hold[i] > 0) {
        hold[i] -= 1;
      }
    }

    return this.dilate(moving, w, h, 1);
  }

  private movingRecentMask(w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    const hold = this.motionHold!;
    for (let i = 0; i < hold.length; i++) {
      if (hold[i] > 0) out[i] = 1;
    }
    return out;
  }

  private updateBackground(
    luma: Float32Array,
    cbMap: Float32Array,
    crMap: Float32Array,
    mask: Uint8Array,
    movingNow: Uint8Array,
    w: number,
    h: number,
  ): void {
    const bgY = this.bgY!;
    const bgCb = this.bgCb!;
    const bgCr = this.bgCr!;
    const protectedMask = this.dilate(mask, w, h, 4);
    for (let i = 0; i < bgY.length; i++) {
      if (protectedMask[i] || movingNow[i]) continue;
      bgY[i] = bgY[i] * 0.97 + luma[i] * 0.03;
      bgCb[i] = bgCb[i] * 0.97 + cbMap[i] * 0.03;
      bgCr[i] = bgCr[i] * 0.97 + crMap[i] * 0.03;
    }
  }

  reset(): void {
    this.bgW = 0;
    this.bgH = 0;
    this.bgY = null;
    this.bgCb = null;
    this.bgCr = null;
    this.motionHold = null;
  }
}
