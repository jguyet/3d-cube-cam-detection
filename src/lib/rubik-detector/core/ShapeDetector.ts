// Second, independent algorithm: detect geometric quadrilateral shapes in the
// frame (stickers, faces, panels…) and drop the background. Pure JS, per frame.
//
// Pipeline: grayscale → blur → Sobel edges → the cube's grid/edges carve the
// image into regions → connected components of the non-edge regions → keep the
// ones whose minimum-area rectangle is well-filled and square-ish (a real
// quad). Background is removed by discarding the large frame-spanning region
// and anything bleeding to the image border.

import type { Point2 } from "../types";
import { convexHull, minAreaRect, polygonArea, pointInPoly, dist, squareScore } from "../utils/geometry";
import { classifyColour, type ColourMemory, type CubeColour } from "@/lib/ml/stickerColor";

export interface Shape {
  corners: Point2[]; // 4 corners, ordered TL,TR,BR,BL
  center: Point2;
  area: number;
  fill: number;      // area / minRect area  (squareness of fill)
  colour?: CubeColour;                 // set when detect() runs colour-aware
  rgb?: [number, number, number];      // region mean RGB
  homogeneity?: number;                // 0..1, colour uniformity of the region (1 = flat)
}

// Colour-aware discovery options. When `colour` is on, detect() (1) splits regions at
// colour boundaries (different facelets that touch with no gap still separate) and
// (2) tags each shape with its mean colour, REJECTING black regions (a black patch is
// never a facelet). `mem` classifies against the learned palette when supplied.
export interface DetectOpts { colour?: boolean; mem?: ColourMemory }

// Fast colour quantiser mirroring classifyColour's buckets — returns a small int label
// (or -1 unknown) for the colour-boundary edge map. Kept inline to avoid a per-pixel
// function call + string alloc over the whole frame.
function quantise(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const s = mx > 0 ? d / mx : 0, v = mx / 255;
  if (s < 0.16 && v > 0.55) return 0;                  // white
  if (v < 0.22 && s < 0.5) return 6;                   // dark/black
  if (s < 0.22) return v > 0.5 ? 0 : -1;               // greyish
  let h = 0;
  if (d > 1e-6) { if (mx === r) h = (((g - b) / d) % 6 + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; }
  if (h < 12 || h >= 345) return 2;                    // red
  if (h < 42) return 3;                                // orange
  if (h < 75) return 1;                                // yellow
  if (h < 170) return 4;                               // green
  if (h < 265) return 5;                               // blue
  return 2;                                            // magenta → red
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
  detect(img: ImageData, colorThreshold = 160, region?: import("../types").Point2[], adaptive = false, opts?: DetectOpts): Shape[] {
    const w = img.width, h = img.height, d = img.data;
    const frame = w * h;
    const colourOn = !!opts?.colour, mem = opts?.mem;

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
    const mag = new Float32Array(frame);
    const BINS = 256, SCALE = BINS / 1800;   // RGB Sobel mag ranges ~0..1800
    const hist = new Int32Array(BINS); let inRegion = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gxR = (bR[i - w + 1] + 2 * bR[i + 1] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - 1] + bR[i + w - 1]);
        const gyR = (bR[i + w - 1] + 2 * bR[i + w] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - w] + bR[i - w + 1]);
        const gxG = (bG[i - w + 1] + 2 * bG[i + 1] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - 1] + bG[i + w - 1]);
        const gyG = (bG[i + w - 1] + 2 * bG[i + w] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - w] + bG[i - w + 1]);
        const gxB = (bB[i - w + 1] + 2 * bB[i + 1] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - 1] + bB[i + w - 1]);
        const gyB = (bB[i + w - 1] + 2 * bB[i + w] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - w] + bB[i - w + 1]);
        const m = Math.sqrt(gxR * gxR + gyR * gyR + gxG * gxG + gyG * gyG + gxB * gxB + gyB * gyB);
        mag[i] = m;
        if (adaptive && (!region || pointInPoly({ x, y }, region))) { hist[Math.min(BINS - 1, (m * SCALE) | 0)]++; inRegion++; }
      }
    // ADAPTIVE threshold: the inter-sticker gap edges are the strongest gradients in
    // the zone, so the ~82nd percentile of in-zone magnitudes tracks them — it drops
    // where contrast is low (DARK stickers vs black gap: weak but still top edges)
    // and rises under glare. Clamped so a flat patch can't hallucinate edges.
    let T = colorThreshold;
    if (adaptive && inRegion > 500) {
      const target = inRegion * 0.82; let acc = 0, bin = 0;
      for (; bin < BINS; bin++) { acc += hist[bin]; if (acc >= target) break; }
      T = Math.max(60, Math.min(colorThreshold, bin / SCALE));   // never above the slider; can go down to catch faint gaps
    }
    for (let i = 0; i < frame; i++) if (mag[i] > T) edges[i] = 1;

    // COLOUR-GUIDED discovery: quantise the (blurred) frame to cube-colour labels and
    // add an edge wherever the label changes. Two facelets of DIFFERENT colours that
    // touch with a weak gradient (no black gap) now split — colour drives the search,
    // not only luminance edges. Same-colour neighbours are untouched (gap handles them).
    if (colourOn) {
      const label = new Int16Array(frame).fill(-1);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; label[i] = quantise(bR[i], bG[i], bB[i]); }
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, li = label[i]; if (li < 0) continue;
        const lr = label[i + 1], lb = label[i + w];
        if ((lr >= 0 && lr !== li) || (lb >= 0 && lb !== li)) edges[i] = 1;
      }
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
      let border = 0, sumR = 0, sumG = 0, sumB = 0, sumR2 = 0, sumG2 = 0, sumB2 = 0;
      while (stack.length) {
        const n = stack.pop()!;
        const nx = n % w, ny = (n / w) | 0;
        pts.push({ x: nx, y: ny });
        if (colourOn) { const r = rA[n], g = gA[n], b = bA[n]; sumR += r; sumG += g; sumB += b; sumR2 += r * r; sumG2 += g * g; sumB2 += b * b; }
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
      const shape: Shape = { corners: rect.corners, center: { x: cx / 4, y: cy / 4 }, area, fill };
      if (colourOn) {
        const mr = sumR / area, mg = sumG / area, mb = sumB / area;
        const rgb: [number, number, number] = [mr, mg, mb];
        // colour HOMOGENEITY: per-channel std over the region. A real facelet is one
        // flat colour (low std); a mixed / glare-ridden / boundary-straddling region
        // is heterogeneous → not a clean sticker.
        const std = (Math.sqrt(Math.max(0, sumR2 / area - mr * mr)) + Math.sqrt(Math.max(0, sumG2 / area - mg * mg)) + Math.sqrt(Math.max(0, sumB2 / area - mb * mb)) / 1) / 3;
        const homogeneity = Math.max(0, 1 - std / 60);
        if (std > 52) continue;             // too heterogeneous → not a uniform facelet
        // NEAR-BLACK gate on the mean, independent of the palette: a dark low-saturation
        // patch (gap/shadow/black plastic) must NEVER be snapped to one of the 6 colours
        // by the closed-set. A dark but SATURATED patch is a dark facelet → kept.
        const mmx = Math.max(mr, mg, mb), mmn = Math.min(mr, mg, mb), msat = mmx > 0 ? (mmx - mmn) / mmx : 0;
        if (mmx < 70 && msat < 0.4) continue;
        const colour = mem ? mem.classify(rgb) : classifyColour(rgb);
        if (colour === "dark") continue;    // BLACK region → not a facelet, reject at discovery
        shape.colour = colour; shape.rgb = rgb; shape.homogeneity = homogeneity;
        if (mem) mem.learn(rgb);
      }
      shapes.push(shape);
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

  // DEBUG: the dilated edge map used by detect() — lets a validation page show
  // exactly what the detector "sees" (where gaps do/don't produce edges).
  debugEdges(img: ImageData, colorThreshold = 125, adaptive = false): { edges: Uint8Array; w: number; h: number; T: number } {
    const w = img.width, h = img.height, d = img.data, frame = w * h;
    const rA = new Float32Array(frame), gA = new Float32Array(frame), bA = new Float32Array(frame);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { rA[j] = d[i]; gA[j] = d[i + 1]; bA[j] = d[i + 2]; }
    const bR = this.blur(rA, w, h), bG = this.blur(gA, w, h), bB = this.blur(bA, w, h);
    let edges: Uint8Array = new Uint8Array(frame);
    const mag = new Float32Array(frame);
    const BINS = 256, SCALE = BINS / 1800; const hist = new Int32Array(BINS); let cnt = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gxR = (bR[i - w + 1] + 2 * bR[i + 1] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - 1] + bR[i + w - 1]);
      const gyR = (bR[i + w - 1] + 2 * bR[i + w] + bR[i + w + 1]) - (bR[i - w - 1] + 2 * bR[i - w] + bR[i - w + 1]);
      const gxG = (bG[i - w + 1] + 2 * bG[i + 1] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - 1] + bG[i + w - 1]);
      const gyG = (bG[i + w - 1] + 2 * bG[i + w] + bG[i + w + 1]) - (bG[i - w - 1] + 2 * bG[i - w] + bG[i - w + 1]);
      const gxB = (bB[i - w + 1] + 2 * bB[i + 1] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - 1] + bB[i + w - 1]);
      const gyB = (bB[i + w - 1] + 2 * bB[i + w] + bB[i + w + 1]) - (bB[i - w - 1] + 2 * bB[i - w] + bB[i - w + 1]);
      const m = Math.sqrt(gxR * gxR + gyR * gyR + gxG * gxG + gyG * gyG + gxB * gxB + gyB * gyB);
      mag[i] = m; if (adaptive) { hist[Math.min(BINS - 1, (m * SCALE) | 0)]++; cnt++; }
    }
    let T = colorThreshold;
    if (adaptive && cnt > 500) { const target = cnt * 0.82; let acc = 0, bin = 0; for (; bin < BINS; bin++) { acc += hist[bin]; if (acc >= target) break; } T = Math.max(60, Math.min(colorThreshold, bin / SCALE)); }
    for (let i = 0; i < frame; i++) if (mag[i] > T) edges[i] = 1;
    edges = this.dilate(edges, w, h, 1);
    return { edges, w, h, T: Math.round(T) };
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
    // maxArea raised 0.10→0.40: a SOLVED uniform face is ONE big blob (no internal
    // gaps segment it); it used to be discarded here before any split could run, so
    // the white pass returned zero cells exactly when the face is most uniform. Now
    // a large near-square blob is subdivided into its 3×3 cells (FATAL fix).
    const minArea = frame * 0.0006, maxArea = frame * 0.7, unitArea = frame * 0.10;
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
      // FATAL fix: a big near-square white blob is a merged solved FACE → subdivide
      // into its 3×3 cells (bilinear over the rect) instead of emitting one giant
      // quad. Only when clearly square (squareScore high) so a lone wall square is
      // not fabricated into a face.
      if (area > unitArea && aspect < 1.35 && fill > 0.7 && squareScore(rect.corners) > 0.72) {
        const [P0, P1, P2, P3] = rect.corners;
        const at = (u: number, v: number): Point2 => ({
          x: (1 - u) * (1 - v) * P0.x + u * (1 - v) * P1.x + u * v * P2.x + (1 - u) * v * P3.x,
          y: (1 - u) * (1 - v) * P0.y + u * (1 - v) * P1.y + u * v * P2.y + (1 - u) * v * P3.y,
        });
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          const c0 = at(i / 3, j / 3), c1 = at((i + 1) / 3, j / 3), c2 = at((i + 1) / 3, (j + 1) / 3), c3 = at(i / 3, (j + 1) / 3);
          shapes.push({ corners: [c0, c1, c2, c3], center: { x: (c0.x + c1.x + c2.x + c3.x) / 4, y: (c0.y + c1.y + c2.y + c3.y) / 4 }, area: area / 9, fill });
        }
        continue;
      }
      if (area > unitArea) continue;   // large but not a clean square → not a facelet
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
  splitMerged(shapes: Shape[], img?: ImageData): Shape[] {
    if (shapes.length < 3) return shapes;
    const shortOf = (s: Shape) => Math.min(dist(s.corners[0], s.corners[1]), dist(s.corners[1], s.corners[2]));
    const shorts = shapes.map(shortOf).sort((a, b) => a - b);
    const unit = shorts[shorts.length >> 1] || 1;
    const out: Shape[] = [];
    // luminance sampler (when the image is provided we VERIFY a real seam before splitting)
    const px = img?.data, iw = img?.width ?? 0, ih = img?.height ?? 0;
    const lumaAt = (x: number, y: number): number => {
      if (!px) return -1; const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= iw || yi >= ih) return -1;
      const i = (yi * iw + xi) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };
    for (const s of shapes) {
      const [TL, TR, BR, BL] = s.corners;
      const a = dist(TL, TR), b = dist(TL, BL);
      // Split a merged block into na×nb unit cells — handles ELONGATED (1×N) AND
      // SQUARE (2×2, 2×3, 3×3) blocks. Each axis is split into its own near-integer
      // count of units. A single sticker (1×1) and a perspective-stretched sticker
      // (a/unit ~1.3 → rounds to 1) are left alone; the tight near-integer residual
      // (<0.33) prevents splitting a 1.6× lone sticker into a bogus 2×2.
      const na = Math.min(3, Math.max(1, Math.round(a / unit)));
      const nb = Math.min(3, Math.max(1, Math.round(b / unit)));
      const aInt = Math.abs(a / unit - na) < 0.33, bInt = Math.abs(b / unit - nb) < 0.33;
      const cellA = a / na, cellB = b / nb;   // each split cell must be ~one sticker
      if (na * nb < 2 || !aInt || !bInt || cellA < 0.72 * unit || cellA > 1.4 * unit || cellB < 0.72 * unit || cellB > 1.4 * unit) { out.push(s); continue; }
      const P = (u: number, v: number): Point2 => ({
        x: (1 - u) * (1 - v) * TL.x + u * (1 - v) * TR.x + u * v * BR.x + (1 - u) * v * BL.x,
        y: (1 - u) * (1 - v) * TL.y + u * (1 - v) * TR.y + u * v * BR.y + (1 - u) * v * BL.y,
      });
      // VERIFY A SEAM (when the image is given): only split along an internal grid
      // line if the luminance there actually DIPS/PERTURBS vs the cell interiors — a
      // truly uniform block (one real facelet, no seam) is left whole. Gap-less cubes
      // still have a faint bevel/seam between tiles → a small dip is enough.
      if (px) {
        const cellL = (i: number, j: number) => { const c = P((i + 0.5) / na, (j + 0.5) / nb); return lumaAt(c.x, c.y); };
        let seam = false;
        // vertical internal lines
        for (let i = 1; i < na && !seam; i++) for (let j = 0; j < nb; j++) {
          const on = P(i / na, (j + 0.5) / nb); const L = lumaAt(on.x, on.y);
          const c = (cellL(i - 1, j) + cellL(i, j)) / 2;
          if (L >= 0 && c > 0 && (c - L) > 0.10 * c + 6) { seam = true; break; }   // line darker than cells
        }
        for (let j = 1; j < nb && !seam; j++) for (let i = 0; i < na; i++) {
          const on = P((i + 0.5) / na, j / nb); const L = lumaAt(on.x, on.y);
          const c = (cellL(i, j - 1) + cellL(i, j)) / 2;
          if (L >= 0 && c > 0 && (c - L) > 0.10 * c + 6) { seam = true; break; }
        }
        if (!seam) { out.push(s); continue; }   // no seam anywhere → it's one facelet, don't split
      }
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
