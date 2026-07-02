// Static-image runner for the hybrid GEOMETRIC pipeline (the classical half of
// HybridScanner, minus the ML zone / camera / temporal tracking). Lets a dataset
// test page run exactly the sticker→face→grid algorithm on still photos.

import { ShapeDetector, type Shape } from "@/lib/rubik-detector/core/ShapeDetector";
import type { Point2 } from "@/lib/rubik-detector/types";
import { faceLatticesFromStickers, type FaceLattice } from "@/lib/ml/cubePoseFromStickers";
import { sampleQuadRGB, classifyColour, ColourMemory, type CubeColour } from "@/lib/ml/stickerColor";

export interface AnalyzeOpts { findMissing?: boolean }
export interface AnalyzeResult {
  shapes: Shape[];
  edgeCount: number;   // stickers from the edge detector
  whiteCount: number;  // white stickers added by detectWhite
  lattices: FaceLattice[];
  cells: { x: number; y: number; gx: number; gy: number; name: CubeColour; found?: boolean; occluded?: boolean; li: number }[];
  links: [Point2, Point2, boolean][];   // a,b, adjacent(true)/skip(false)
}

// Run detect + white pass + size gate → shapes (whole-image region).
export function detectStickers(det: ShapeDetector, image: ImageData): { shapes: Shape[]; edgeCount: number; whiteCount: number } {
  const W = image.width, H = image.height;
  const region: Point2[] = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  let shapes = det.detect(image, 125, region);
  const edgeCount = shapes.length;
  // white pass — unioned, sticker-sized, no coloured-neighbour requirement
  const near = (a: Point2, b: Point2, s: number) => Math.hypot(a.x - b.x, a.y - b.y) < 0.6 * s;
  const whites = det.detectWhite(image, region, false);   // border test rejects real light-gap whites
  const colSides = shapes.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
  const whSides = whites.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
  const ref = colSides.length >= 3 ? colSides[colSides.length >> 1] : (whSides.length ? whSides[whSides.length >> 1] : 0);
  let whiteCount = 0;
  for (const wsh of whites) {
    const side = Math.sqrt(Math.max(1, wsh.area));
    if (shapes.some((s) => near(s.center, wsh.center, side))) continue;
    if (ref > 0) { const r = side / ref; if (r < 0.55 || r > 1.8) continue; }
    shapes.push(wsh); whiteCount++;
  }
  // size gate (same-size prior)
  if (shapes.length >= 5) {
    const sd = shapes.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
    const med = sd[sd.length >> 1];
    shapes = shapes.filter((s) => { const r = Math.sqrt(Math.max(1, s.area)) / med; return r >= 0.63 && r <= 1.45; });   // tight: drop merged blobs on uniform faces
  }
  return { shapes, edgeCount, whiteCount };
}

export function analyze(det: ShapeDetector, image: ImageData, opts: AnalyzeOpts = {}): AnalyzeResult {
  const W = image.width, H = image.height;
  const { shapes, edgeCount, whiteCount } = detectStickers(det, image);
  const all = faceLatticesFromStickers(shapes as never[]);
  // dedupe over-segmented faces (overlapping surfaces)
  const cxy = (s: Point2[]) => ({ x: (s[0].x + s[1].x + s[2].x + s[3].x) / 4, y: (s[0].y + s[1].y + s[2].y + s[3].y) / 4 });
  const diag = (s: Point2[]) => Math.hypot(s[2].x - s[0].x, s[2].y - s[0].y);
  const lattices: FaceLattice[] = [];
  for (const lat of [...all].sort((a, b) => b.count - a.count)) {
    const c = cxy(lat.surface), sz = diag(lat.surface);
    if (lattices.some((o) => Math.hypot(cxy(o.surface).x - c.x, cxy(o.surface).y - c.y) < 0.5 * Math.max(sz, diag(o.surface)))) continue;
    lattices.push(lat);
  }
  // learn a palette from this image's detected stickers
  const mem = new ColourMemory();
  for (const lat of lattices) for (const c0 of lat.centres) { const rgb = sampleQuadRGB(c0.corners, image.data, W, H); if (rgb) mem.learn(rgb); }

  const cells: AnalyzeResult["cells"] = [];
  const links: AnalyzeResult["links"] = [];
  for (let li = 0; li < lattices.length; li++) {
    const lat = lattices[li];
    // "skin" is not a cube colour, so a skin/tan reading on a FACE-GRID cell is a
    // white facelet under warm lighting (a finger can't form a 3×3) → map to white.
    const cellName = (rgb: [number, number, number] | null): CubeColour => {
      if (!rgb) return "unknown";
      const c = mem.classify(rgb);
      return c === "skin" ? "white" : c;
    };
    const detRGB: [number, number, number][] = [];
    const cur: { x: number; y: number; gx: number; gy: number; name: CubeColour; found?: boolean; occluded?: boolean; li: number }[] = lat.centres.map((c0) => {
      const rgb = sampleQuadRGB(c0.corners, image.data, W, H);
      if (rgb) detRGB.push(rgb);
      return { x: c0.x, y: c0.y, gx: c0.gx, gy: c0.gy, name: cellName(rgb), li };
    });
    // detected extent: a cell INSIDE it that we can't read is a real facelet under a
    // finger (logical deduction) — a user holds the cube, so occlusion is normal.
    const dgx = cur.map((c) => c.gx), dgy = cur.map((c) => c.gy);
    const bMinGx = Math.min(...dgx), bMaxGx = Math.max(...dgx), bMinGy = Math.min(...dgy), bMaxGy = Math.max(...dgy);
    const bracketed = (gx: number, gy: number) => gx >= bMinGx && gx <= bMaxGx && gy >= bMinGy && gy <= bMaxGy;
    // On a UNIFORM face (all detected cells the same colour) a completed cell must
    // match that colour — this rejects an off-cube grid cell that landed on the
    // wall/table (which reads white-ish but is a different tone). Median ref RGB.
    const uniform = cur.length >= 2 && new Set(cur.map((c) => c.name)).size === 1 && detRGB.length >= 2;
    const med = (i: number) => { const s = detRGB.map((r) => r[i]).sort((a, b) => a - b); return s[s.length >> 1]; };
    const faceRGB: [number, number, number] | null = uniform ? [med(0), med(1), med(2)] : null;
    const rgbFar = (rgb: [number, number, number] | null) => !!(faceRGB && rgb && Math.hypot(rgb[0] - faceRGB[0], rgb[1] - faceRGB[1], rgb[2] - faceRGB[2]) > 46);
    // completion ONLY on a coherent (non-degenerate) grid — a collapsed homography
    // would stack all completed cells on one point.
    const half = Math.max(0.18, 0.5 * lat.stickerFrac * 0.9);
    const lo = 0.5 - half, hi = 0.5 + half, step = (hi - lo) / 4;
    if (lat.gridCoherent) for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) {
      if (lat.filled[gx][gy] || cur.some((c) => c.gx === gx && c.gy === gy)) continue;
      const A = lat.nodes[gx][gy], B = lat.nodes[gx + 1][gy], C = lat.nodes[gx + 1][gy + 1], D = lat.nodes[gx][gy + 1];
      const mid0 = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
      if (rgbFar(sampleQuadRGB([{ x: mid0.x - 3, y: mid0.y - 3 }, { x: mid0.x + 3, y: mid0.y - 3 }, { x: mid0.x + 3, y: mid0.y + 3 }, { x: mid0.x - 3, y: mid0.y + 3 }], image.data, W, H))) continue;   // off-cube tone on a uniform face
      const mid = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
      const votes: Record<string, number> = {}, uv: Record<string, { u: number; v: number }[]> = {};
      let whiteN = 0, tot = 0; const wpts: { u: number; v: number }[] = [];
      for (let u = lo; u <= hi + 1e-6; u += step) for (let v = lo; v <= hi + 1e-6; v += step) {
        const x = (1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x;
        const y = (1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y;
        const rgb = sampleQuadRGB([{ x: x - 2, y: y - 2 }, { x: x + 2, y: y - 2 }, { x: x + 2, y: y + 2 }, { x: x - 2, y: y + 2 }], image.data, W, H);
        if (!rgb) continue;
        tot++;
        const mx = Math.max(rgb[0], rgb[1], rgb[2]), mn = Math.min(rgb[0], rgb[1], rgb[2]), sat = mx > 0 ? (mx - mn) / mx : 0;
        const wByMem = (mem.refs.white?.n ?? 0) >= 4 ? mem.classify(rgb) === "white" : false;
        if (wByMem || (mx > 140 && sat < 0.30)) { whiteN++; wpts.push({ u, v }); }
        if (opts.findMissing) {
          const c = mem.classify(rgb);
          if (c !== "skin" && c !== "dark" && c !== "unknown" && !(mem.ready() >= 3 && !mem.refs[c as keyof typeof mem.refs])) {
            votes[c] = (votes[c] || 0) + 1; (uv[c] ??= []).push({ u, v });
          }
        }
      }
      const span = (p: { u: number; v: number }[]) => p.length ? [Math.max(...p.map((q) => q.u)) - Math.min(...p.map((q) => q.u)), Math.max(...p.map((q) => q.v)) - Math.min(...p.map((q) => q.v))] : [0, 0];
      const [wu, wv] = span(wpts);
      let placed = false;
      if (tot > 0 && whiteN / tot >= 0.5 && wu >= 0.6 * (hi - lo) && wv >= 0.6 * (hi - lo)) {
        cur.push({ x: mid.x, y: mid.y, gx, gy, name: "white", found: true, li }); placed = true;
      } else if (opts.findMissing) {
        let bestC = "", bestN = 0; for (const k in votes) if (votes[k] > bestN) { bestN = votes[k]; bestC = k; }
        const [su, sv] = span(uv[bestC] ?? []);
        if (tot > 0 && bestN / tot >= 0.45 && su >= 0.6 * (hi - lo) && sv >= 0.6 * (hi - lo)) {
          cur.push({ x: mid.x, y: mid.y, gx, gy, name: bestC as CubeColour, found: true, li }); placed = true;
        }
      }
      // couldn't read a cube colour, but the cell is bracketed by detected stickers
      // → it's a real facelet hidden by a finger/glare: emit as unknown (occluded).
      if (!placed && bracketed(gx, gy)) {
        cur.push({ x: mid.x, y: mid.y, gx, gy, name: "unknown", found: true, occluded: true, li });
      }
    }
    // links between grid-adjacent cells
    for (let a = 0; a < cur.length; a++) for (let b = a + 1; b < cur.length; b++) {
      const A = cur[a], B = cur[b], dgx = Math.abs(A.gx - B.gx), dgy = Math.abs(A.gy - B.gy);
      if (dgx + dgy === 1) links.push([A, B, true]);
      else if ((dgx === 2 && dgy === 0) || (dgx === 0 && dgy === 2)) links.push([A, B, false]);
    }
    cells.push(...cur);
  }
  return { shapes, edgeCount, whiteCount, lattices, cells, links };
}
