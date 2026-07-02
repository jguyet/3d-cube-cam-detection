// Second, independent algorithm: detect geometric quadrilateral shapes in the
// frame (stickers, faces, panels…) and drop the background. Pure JS, per frame.
//
// Pipeline: grayscale → blur → Sobel edges → the cube's grid/edges carve the
// image into regions → connected components of the non-edge regions → keep the
// ones whose minimum-area rectangle is well-filled and square-ish (a real
// quad). Background is removed by discarding the large frame-spanning region
// and anything bleeding to the image border.

import type { Point2 } from "../types";
import { convexHull, minAreaRect, polygonArea, pointInPoly, dist } from "../utils/geometry";

export interface Shape {
  corners: Point2[]; // 4 corners, ordered TL,TR,BR,BL
  center: Point2;
  area: number;
  fill: number;      // area / minRect area  (squareness of fill)
}

export class ShapeDetector {
  // Running model of the STATIC background (per-pixel YCbCr). The cube moves, so
  // it never matches this model and stays foreground; the static scene
  // (cabinets, magnets, walls) converges into it and is removed.
  private bgY: Float32Array | null = null;
  private bgCb: Float32Array | null = null;
  private bgCr: Float32Array | null = null;

  // `region`: when given (e.g. the cube's silhouette hull), shapes are kept only
  // inside it and the standalone background-subtraction is skipped — the region
  // already restricts to the cube zone.
  detect(img: ImageData, colorThreshold = 160, region?: import("../types").Point2[]): Shape[] {
    const w = img.width, h = img.height, d = img.data;
    const frame = w * h;

    // raw R/G/B (for colour edges) + luma/chroma (for the background model)
    const rA = new Float32Array(frame), gA = new Float32Array(frame), bA = new Float32Array(frame);
    const luma = new Float32Array(frame), cb = new Float32Array(frame), cr = new Float32Array(frame);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      rA[j] = r; gA[j] = g; bA[j] = b;
      luma[j] = 0.299 * r + 0.587 * g + 0.114 * b;
      cb[j] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[j] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    const bR = this.blur(rA, w, h), bG = this.blur(gA, w, h), bB = this.blur(bA, w, h);

    // foreground (moving) mask — skipped when a cube region is supplied
    const fg = region ? null : this.foreground(luma, cb, cr, w, h);

    // Edges ONLY on a BIG colour difference: the combined RGB gradient must
    // clear a high bar. Lighting/shadow gradients within a sticker are a small
    // colour change and produce no edge — so a region = one flat-colour patch.
    let edges: Uint8Array = new Uint8Array(frame);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gxR = (bR[i - w + 1] + 2 * bR[i + 1] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - 1] + bR[i + w - 1]);
        const gyR = (bR[i + w - 1] + 2 * bR[i + w] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - w] + bR[i - w + 1]);
        const gxG = (bG[i - w + 1] + 2 * bG[i + 1] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - 1] + bG[i + w - 1]);
        const gyG = (bG[i + w - 1] + 2 * bG[i + w] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - w] + bG[i - w + 1]);
        const gxB = (bB[i - w + 1] + 2 * bB[i + 1] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - 1] + bB[i + w - 1]);
        const gyB = (bB[i + w - 1] + 2 * bB[i + w] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - w] + bB[i - w + 1]);
        const mag = Math.sqrt(gxR * gxR + gyR * gyR + gxG * gxG + gyG * gyG + gxB * gxB + gyB * gyB);
        if (mag > colorThreshold) edges[i] = 1;
      }
    edges = this.dilate(edges, w, h, 1); // close 1-px gaps so regions are sealed

    // regions = non-edge connected components
    const vis = new Uint8Array(frame);
    const stack: number[] = [];
    const shapes: Shape[] = [];
    const minArea = frame * 0.0006, maxArea = frame * 0.22;

    for (let s0 = 0; s0 < frame; s0++) {
      if (edges[s0] || vis[s0]) continue;
      vis[s0] = 1; stack.length = 0; stack.push(s0);
      const pts: Point2[] = [];
      let border = 0;
      while (stack.length) {
        const n = stack.pop()!;
        const nx = n % w, ny = (n / w) | 0;
        pts.push({ x: nx, y: ny });
        if (nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1) border++;
        // 4-connectivity keeps regions separated by 1-px edges
        if (nx + 1 < w) { const m = n + 1; if (!edges[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (nx - 1 >= 0) { const m = n - 1; if (!edges[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (ny + 1 < h) { const m = n + w; if (!edges[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (ny - 1 >= 0) { const m = n - w; if (!edges[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
      }
      const area = pts.length;
      // background removal: too big, or bleeding to the frame border
      if (area < minArea || area > maxArea || border > 6) continue;

      const hull = convexHull(pts);
      const rect = minAreaRect(hull);
      if (!rect) continue;
      const fill = area / (rect.area || 1);
      const s1 = Math.hypot(rect.corners[0].x - rect.corners[1].x, rect.corners[0].y - rect.corners[1].y);
      const s2 = Math.hypot(rect.corners[1].x - rect.corners[2].x, rect.corners[1].y - rect.corners[2].y);
      const aspect = Math.max(s1, s2) / (Math.min(s1, s2) || 1);
      if (fill < 0.5 || aspect > 3.4) continue;

      let cx = 0, cy = 0;
      for (const c of rect.corners) { cx += c.x; cy += c.y; }
      shapes.push({ corners: rect.corners, center: { x: cx / 4, y: cy / 4 }, area, fill });
    }

    // Restrict to the cube zone when a region is given, then keep only the
    // dominant cluster of stickers — the convex hull can bulge over hand/
    // background, so isolated quads sneaking inside it are dropped here.
    if (region) return this.dominantCluster(shapes.filter((s) => pointInPoly(s.center, region)));
    // …otherwise keep only MOVING shapes (static background dropped). On the
    // first frames (no model yet) everything passes until it settles.
    if (!fg) return shapes;
    return shapes.filter((s) => this.movingShape(s, fg, w, h));
  }

  // WHITE facelets are the hardest for the edge pass: they glare, desaturate, and
  // their outer border blends into a light background so the region bleeds out and
  // is dropped. Detect them directly by a brightness+low-saturation MASK instead
  // of by edges. Erode 1px to break the thin bridges where the dark gap between two
  // whites is overexposed, then take connected components that pass the shape gate.
  detectWhite(img: ImageData, region?: import("../types").Point2[], borderTest = false): Shape[] {
    const px = img.data, w = img.width, h = img.height, frame = w * h;
    const mask = new Uint8Array(frame);
    for (let i = 0; i < frame; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      if (mx > 150 && sat < 0.28) mask[i] = 1;      // bright & near-neutral = white
    }
    // erode by 1 (4-neighbour) → separate whites bridged by a washed-out gap
    const er = new Uint8Array(frame);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) er[i] = 1;
    }
    const vis = new Uint8Array(frame), stack: number[] = [], shapes: Shape[] = [];
    const minArea = frame * 0.0006, maxArea = frame * 0.10;
    for (let s0 = 0; s0 < frame; s0++) {
      if (!er[s0] || vis[s0]) continue;
      vis[s0] = 1; stack.length = 0; stack.push(s0);
      const pts: Point2[] = []; let border = 0;
      while (stack.length) {
        const n = stack.pop()!, nx = n % w, ny = (n / w) | 0;
        pts.push({ x: nx, y: ny });
        if (nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1) border++;
        if (nx + 1 < w) { const m = n + 1; if (er[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (nx - 1 >= 0) { const m = n - 1; if (er[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (ny + 1 < h) { const m = n + w; if (er[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
        if (ny - 1 >= 0) { const m = n - w; if (er[m] && !vis[m]) { vis[m] = 1; stack.push(m); } }
      }
      const area = pts.length;
      if (area < minArea || area > maxArea || border > 6) continue;
      const rect = minAreaRect(convexHull(pts));
      if (!rect) continue;
      const fill = area / (rect.area || 1);
      const s1 = dist(rect.corners[0], rect.corners[1]), s2 = dist(rect.corners[1], rect.corners[2]);
      const aspect = Math.max(s1, s2) / (Math.min(s1, s2) || 1);
      if (fill < 0.55 || aspect > 1.9) continue;      // whites are near-square
      let cx = 0, cy = 0; for (const c of rect.corners) { cx += c.x; cy += c.y; }
      const center = { x: cx / 4, y: cy / 4 };
      if (region && !pointInPoly(center, region)) continue;
      // DARK-BORDER test: a real facelet is ringed by the dark inter-sticker plastic
      // gap (and coloured neighbours read darker than white); a white wall/furniture
      // panel is surrounded by more bright pixels. Reject a blob with essentially NO
      // darker border on any side. (Most reliable on the high-res crop where the gap
      // is several px wide.)
      if (borderTest) {
        const lumaAt = (x: number, y: number) => {
          const xi = Math.round(x), yi = Math.round(y);
          if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;   // off-frame = treat as bright (no border)
          const i = (yi * w + xi) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        };
        let bin = 0; const nb = Math.min(pts.length, 400), stepB = Math.max(1, (pts.length / nb) | 0);
        let cnt = 0; for (let p = 0; p < pts.length; p += stepB) { bin += lumaAt(pts[p].x, pts[p].y); cnt++; }
        bin = cnt ? bin / cnt : 200;
        let dark = 0, tot = 0;
        for (let e = 0; e < 12; e++) {                              // ring just outside the rect
          const t = e / 12, seg = Math.floor(t * 4), ft = t * 4 - seg;
          const a0 = rect.corners[seg], a1 = rect.corners[(seg + 1) % 4];
          const ex = center.x + ((a0.x + (a1.x - a0.x) * ft) - center.x) * 1.35;
          const ey = center.y + ((a0.y + (a1.y - a0.y) * ft) - center.y) * 1.35;
          if (lumaAt(ex, ey) < 0.62 * bin) dark++;
          tot++;
        }
        if (tot > 0 && dark / tot < 0.25) continue;                 // flat bright surround → wall/furniture
      }
      shapes.push({ corners: rect.corners, center, area, fill });
    }
    return shapes;
  }

  // On a GAP-LESS cube, adjacent same-colour facelets have no border between them,
  // so the edge pass merges them into ONE big rectangle (3-in-a-row → a long rect,
  // 2×2 → a square, …). Split such blocks back into unit cells (user's idea): the
  // unit side ≈ the median of every shape's SHORT side (a merged block is only
  // long on one axis, so its short side is still one sticker), then any shape that
  // spans ~N units on an axis is cut into N. Each cell becomes a real sticker.
  splitMerged(shapes: Shape[]): Shape[] {
    if (shapes.length < 3) return shapes;
    const shortOf = (s: Shape) => Math.min(dist(s.corners[0], s.corners[1]), dist(s.corners[1], s.corners[2]));
    const shorts = shapes.map(shortOf).sort((a, b) => a - b);
    const unit = shorts[shorts.length >> 1] || 1;
    const out: Shape[] = [];
    for (const s of shapes) {
      const [TL, TR, BR, BL] = s.corners;
      const a = dist(TL, TR), b = dist(TL, BL);
      const long = Math.max(a, b), short = Math.min(a, b);
      // Only split ELONGATED blocks: the short axis is ~ONE sticker (not a thin
      // sliver, not a big square) and the long axis is a near-integer N≥2 units
      // (3 same-colour facelets in a row → a long rectangle). Near-square shapes
      // and slivers are left alone so we never invent facelets.
      const n = Math.min(3, Math.round(long / unit));
      const nearInt = Math.abs(long / unit - n) < 0.33;
      if (short < 0.72 * unit || short > 1.4 * unit || long / short < 1.9 || n < 2 || !nearInt) { out.push(s); continue; }
      const na = a >= b ? n : 1, nb = a >= b ? 1 : n;
      const P = (u: number, v: number): Point2 => ({
        x: (1 - u) * (1 - v) * TL.x + u * (1 - v) * TR.x + u * v * BR.x + (1 - u) * v * BL.x,
        y: (1 - u) * (1 - v) * TL.y + u * (1 - v) * TR.y + u * v * BR.y + (1 - u) * v * BL.y,
      });
      for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
        const c0 = P(i / na, j / nb), c1 = P((i + 1) / na, j / nb), c2 = P((i + 1) / na, (j + 1) / nb), c3 = P(i / na, (j + 1) / nb);
        out.push({
          corners: [c0, c1, c2, c3],
          center: { x: (c0.x + c1.x + c2.x + c3.x) / 4, y: (c0.y + c1.y + c2.y + c3.y) / 4 },
          area: s.area / (na * nb), fill: s.fill,
        });
      }
    }
    return out;
  }

  // Foreground mask via background subtraction. Returns null until the model is
  // seeded. Updates the background only where there is no motion, so the moving
  // cube never bakes into it.
  private foreground(luma: Float32Array, cb: Float32Array, cr: Float32Array, w: number, h: number): Uint8Array | null {
    const n = w * h;
    if (!this.bgY || this.bgY.length !== n) {
      this.bgY = Float32Array.from(luma);
      this.bgCb = Float32Array.from(cb);
      this.bgCr = Float32Array.from(cr);
      return null;
    }
    const bgY = this.bgY, bgCb = this.bgCb!, bgCr = this.bgCr!;
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const delta = Math.abs(luma[i] - bgY[i]) + 0.6 * Math.abs(cb[i] - bgCb[i]) + 0.6 * Math.abs(cr[i] - bgCr[i]);
      if (delta > 26) {
        fg[i] = 1; // moving → leave background untouched
      } else {
        bgY[i] += 0.06 * (luma[i] - bgY[i]);
        bgCb[i] += 0.06 * (cb[i] - bgCb[i]);
        bgCr[i] += 0.06 * (cr[i] - bgCr[i]);
      }
    }
    return this.dilate(fg, w, h, 3);
  }

  // A shape is foreground if a good share of its perimeter sits on moving pixels
  // (a moving sticker's borders shift; a static panel's do not).
  private movingShape(s: Shape, fg: Uint8Array, w: number, h: number): boolean {
    const c = s.corners;
    let hit = 0, total = 0;
    for (let e = 0; e < 4; e++) {
      const a = c[e], b = c[(e + 1) % 4];
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        total++;
        if (fg[y * w + x]) hit++;
      }
    }
    return total > 0 && hit / total >= 0.35;
  }

  reset(): void {
    this.bgY = null;
    this.bgCb = null;
    this.bgCr = null;
  }


  // Keep the densest group of similar-sized neighbouring shapes (the cube's
  // sticker lattice); drop isolated quads. Union-find by proximity + size.
  private dominantCluster(shapes: Shape[]): Shape[] {
    const n = shapes.length;
    if (n <= 4) return shapes;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = shapes[i], b = shapes[j];
        const sa = Math.sqrt(a.area), sb = Math.sqrt(b.area);
        const sizeOk = Math.max(sa, sb) / Math.min(sa, sb) < 2.4;
        const near = dist(a.center, b.center) < 2.4 * Math.max(sa, sb);
        if (sizeOk && near) parent[find(i)] = find(j);
      }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const g = groups.get(r);
      if (g) g.push(i); else groups.set(r, [i]);
    }
    let best: number[] = [];
    for (const g of groups.values()) if (g.length > best.length) best = g;
    if (best.length < 3) return shapes;
    return best.map((i) => shapes[i]);
  }

  // separable gaussian blur [1,4,6,4,1]/16
  private blur(src: Float32Array, w: number, h: number): Float32Array {
    const k = [1, 4, 6, 4, 1];
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) { const xx = Math.min(w - 1, Math.max(0, x + t)); s += src[y * w + xx] * k[t + 2]; }
        tmp[y * w + x] = s / 16;
      }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) { const yy = Math.min(h - 1, Math.max(0, y + t)); s += tmp[yy * w + x] * k[t + 2]; }
        out[y * w + x] = s / 16;
      }
    return out;
  }

  private dilate(m: Uint8Array, w: number, h: number, iters: number): Uint8Array {
    for (let it = 0; it < iters; it++) {
      const o = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (m[i] || m[i - 1] || m[i + 1] || m[i - w] || m[i + w]) o[i] = 1;
        }
      m = o;
    }
    return m;
  }
}
