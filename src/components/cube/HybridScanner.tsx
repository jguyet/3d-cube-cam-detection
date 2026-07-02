"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";
import { ShapeDetector, type Shape } from "@/lib/rubik-detector/core/ShapeDetector";
import { cubePoseFromStickers, faceLatticesFromStickers, projectPose, matToQuat, quatToMat, slerp, type Quat } from "@/lib/ml/cubePoseFromStickers";
import { sampleQuadRGB, classifyColour, colourHex, ColourMemory, type CubeColour } from "@/lib/ml/stickerColor";
import { stabiliseZone, type Zone } from "@/lib/ml/temporalStabilise";
import type { Point2 } from "@/lib/rubik-detector/types";

type Status = "idle" | "loading" | "scanning" | "error";

const PRESENCE_ON = 0.45;   // Schmitt trigger: activate above this…
const PRESENCE_OFF = 0.25;  // …deactivate below this (after a few frames)
const VIS_MIN = 0.4;

// Hybrid detector (experimental): iter4 ML gives the cube ZONE, then a CLASSICAL
// silhouette (orange) is fit inside that zone to snap onto the real cube edges.
// ML cube-fit shown in cyan for comparison.
export default function HybridScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const netRef = useRef<CubeNet | null>(null);
  const shapeRef = useRef<ShapeDetector | null>(null);
  const cropRef = useRef<HTMLCanvasElement | null>(null);   // high-res zone crop
  const memRef = useRef<ColourMemory | null>(null);         // learned cube palette
  const frameRef = useRef(0);
  const lastFaceRef = useRef<{ center: CubeColour; cells: CubeColour[]; known: number } | null>(null);
  // accumulated cube state: 6 faces keyed by centre colour → their 9 facelets
  const [cubeState, setCubeState] = useState<Record<string, CubeColour[]>>({});
  const poseRef = useRef<{ q: Quat; t: number[]; k: number[] } | null>(null);   // filtered 3D pose (k=[f,fy,cx,cy,s])
  // sticker HISTORY across frames: recently-seen stickers persist a few frames so
  // the links don't flicker with per-frame detection dropouts
  type TrackedShape = { corners: [Point2, Point2, Point2, Point2]; center: Point2; area: number; fill: number };
  const tracksRef = useRef<{ shape: TrackedShape; ttl: number }[]>([]);
  const coastRef = useRef<{ corners: Point2[]; edges: [number, number][]; ttl: number } | null>(null); // hold last pose through dropouts
  const zoneRef = useRef<Zone | null>(null);                // temporally-stabilised ML zone
  const activeRef = useRef(false);                          // presence hysteresis state
  const presMissRef = useRef(0);
  const rafRef = useRef(0);
  const busyRef = useRef(false);
  const histRef = useRef<MLResult[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showMl, setShowMl] = useState(true);
  const [showLattice, setShowLattice] = useState(false);   // extrapolated 3x3 grid
  const showLatticeRef = useRef(false);
  showLatticeRef.current = showLattice;
  const [showCube, setShowCube] = useState(false);          // 3D cube overlay
  const showCubeRef = useRef(false);
  showCubeRef.current = showCube;
  const [splitBlocks, setSplitBlocks] = useState(false);    // split same-colour blocks (gap-less cubes)
  const splitRef = useRef(false);
  splitRef.current = splitBlocks;
  const [showContour, setShowContour] = useState(false);    // exact cube-surface contour sensor
  const contourRef = useRef(false);
  contourRef.current = showContour;
  const [findMissing, setFindMissing] = useState(false);    // search empty cells for (partial) stickers
  const findMissingRef = useRef(false);
  findMissingRef.current = findMissing;

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); }, []);

  const loop = async () => {
    rafRef.current = requestAnimationFrame(loop);
    const video = videoRef.current, canvas = canvasRef.current, grabber = grabberRef.current, net = netRef.current;
    if (!video || !canvas || !grabber || !net || busyRef.current) return;
    const image = grabber.grab(video);
    if (!image) return;
    canvas.width = grabber.width; canvas.height = grabber.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);

    busyRef.current = true;
    let res: MLResult | null = null;
    try { res = await net.predict(image); } catch { /* ignore */ }
    busyRef.current = false;
    if (!res) return;

    const N = 6;
    const hist = histRef.current;
    hist.push(res);
    if (hist.length > N) hist.shift();
    const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

    // ---- PRESENCE HYSTERESIS (Schmitt trigger): activate at ON, deactivate only
    // after several sustained sub-OFF frames → no on/off blink at a single boundary.
    const presence = median(hist.map((h) => h.present));
    if (!activeRef.current) {
      if (presence >= PRESENCE_ON) { activeRef.current = true; presMissRef.current = 0; }
      else {
        ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 168, 26);
        ctx.fillStyle = "#fca5a5"; ctx.font = "14px system-ui";
        ctx.fillText(`aucun cube (${(presence * 100) | 0}%)`, 16, 26);
        return;
      }
    } else if (presence < PRESENCE_OFF) {
      if (++presMissRef.current >= 4) {
        activeRef.current = false; presMissRef.current = 0;
        zoneRef.current = null; poseRef.current = null; coastRef.current = null;
        return;
      }
    } else presMissRef.current = 0;

    const W = grabber.width, H = grabber.height;
    const sc = Array.from({ length: 8 }, (_, i) => {
      const xs: number[] = [], ys: number[] = [], ws: number[] = [];
      for (const h of hist) { const p = h.corners[i]; xs.push(p.x); ys.push(p.y); ws.push(p.v); }
      return { x: median(xs), y: median(ys), w: median(ws) };
    });

    // ---- ML zone → bbox over the visible corners (expanded), then TEMPORALLY
    // STABILISED (reject partial/jumping bboxes, EMA, hold the last good zone).
    const vis = sc.filter((p) => p.w >= VIS_MIN);
    if (vis.length >= 3) {
      let minx = 1, miny = 1, maxx = 0, maxy = 0;
      for (const p of vis) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
      const ex = 0.18;
      zoneRef.current = stabiliseZone(zoneRef.current, {
        x0: (minx - ex * (maxx - minx)) * W, x1: (maxx + ex * (maxx - minx)) * W,
        y0: (miny - ex * (maxy - miny)) * H, y1: (maxy + ex * (maxy - miny)) * H,
      });
    } else if (zoneRef.current && zoneRef.current.miss < 6) {
      zoneRef.current = { ...zoneRef.current, miss: zoneRef.current.miss + 1 };   // coast on the held zone
    } else { return; }
    const rx0 = zoneRef.current.x0, rx1 = zoneRef.current.x1, ry0 = zoneRef.current.y0, ry1 = zoneRef.current.y1;
    const region: Point2[] = [{ x: rx0, y: ry0 }, { x: rx1, y: ry0 }, { x: rx1, y: ry1 }, { x: rx0, y: ry1 }];

    if (showMl) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,224,255,0.5)"; ctx.setLineDash([5, 4]);
      ctx.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0); ctx.setLineDash([]);
    }

    // ---- CLASSICAL sticker detection on a HIGH-RES crop of the ML zone ----
    // At 360px full-frame each sticker is only ~15px → colour-edge quads get
    // missed (live counter stuck at 4-6 even with 9 visible). Crop the zone from
    // the NATIVE video (720p+): stickers become ~3× bigger → far better recall.
    let shapes = shapeRef.current!.detect(image, 125, region);
    let cropWhites: Shape[] | null = null;   // border-tested whites from the hi-res crop
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw > W * 1.3) {
      const zx = Math.max(0, (rx0 / W) * vw), zy = Math.max(0, (ry0 / H) * vh);
      const zw = Math.min(vw - zx, ((rx1 - rx0) / W) * vw), zh = Math.min(vh - zy, ((ry1 - ry0) / H) * vh);
      if (zw > 16 && zh > 16) {
        const cw = 360, ch = Math.max(48, Math.round((cw * zh) / zw));
        const cc = cropRef.current!;
        cc.width = cw; cc.height = ch;
        const cctx = cc.getContext("2d", { willReadFrequently: true })!;
        cctx.drawImage(video, zx, zy, zw, zh, 0, 0, cw, ch);
        const cropImg = cctx.getImageData(0, 0, cw, ch);
        const cropRegion: Point2[] = [{ x: 0, y: 0 }, { x: cw, y: 0 }, { x: cw, y: ch }, { x: 0, y: ch }];
        const sx = (rx1 - rx0) / cw, sy = (ry1 - ry0) / ch;
        const mapBack = (s: Shape): Shape => ({
          corners: s.corners.map((p) => ({ x: rx0 + p.x * sx, y: ry0 + p.y * sy })) as [Point2, Point2, Point2, Point2],
          center: { x: rx0 + s.center.x * sx, y: ry0 + s.center.y * sy },
          area: s.area * sx * sy, fill: s.fill,
        });
        const hi = shapeRef.current!.detect(cropImg, 125, cropRegion);
        if (hi.length > shapes.length) shapes = hi.map(mapBack);   // keep whichever scale found more
        // whites detected at high-res WITH the dark-border test (gap is several px wide here)
        cropWhites = shapeRef.current!.detectWhite(cropImg, cropRegion, true).map(mapBack);
      }
    }
    // ---- WHITE PASS: white facelets can't be edge-detected (glare/blend). Detect
    // them by a brightness mask WITH the dark-border test (a real facelet is ringed
    // by the black gap; a flat wall square isn't). Crucially, do NOT require a
    // coloured neighbour — a FULLY WHITE face has none; its 9 squares must be able
    // to form the grid on their own. Furniture is rejected two ways: the per-square
    // border test, and the face-level grid coherence in extractFacesV2 (scattered
    // furniture squares don't rectify to a regular 3×3). Size-plausibility uses the
    // coloured cluster if present, else the whites' own median (all ~equal on a face).
    {
      const near = (a: Point2, b: Point2, s: number) => Math.hypot(a.x - b.x, a.y - b.y) < 0.6 * s;
      // apply white detection to BOTH scales of shape detection: the hi-res crop
      // (sharp gaps) AND the full frame; union them (dedup so a white found at both
      // scales counts once). More whites caught → more complete faces.
      const whites: Shape[] = [...(cropWhites ?? [])];
      for (const wsh of shapeRef.current!.detectWhite(image, region, true)) {
        const side = Math.sqrt(Math.max(1, wsh.area));
        if (!whites.some((o) => near(o.center, wsh.center, side))) whites.push(wsh);
      }
      const colSides = shapes.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
      const whSides = whites.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
      const ref = colSides.length >= 3 ? colSides[colSides.length >> 1] : (whSides.length ? whSides[whSides.length >> 1] : 0);
      for (const wsh of whites) {
        const side = Math.sqrt(Math.max(1, wsh.area));
        if (shapes.some((s) => near(s.center, wsh.center, side))) continue;   // duplicate of an edge sticker
        if (ref > 0) { const r = side / ref; if (r < 0.55 || r > 1.8) continue; }   // sticker-sized only
        shapes.push(wsh);
      }
    }

    // ---- COLOUR GATE: drop quads whose interior is SKIN (beige/brown finger) or
    // DARK (black / dark-brown = hair or deep shadow) — neither is a lit sticker
    // (user's idea). Cleans the links of non-cube quads.
    let nSkin = 0;
    shapes = shapes.filter((s) => {
      const rgb = sampleQuadRGB(s.corners, image.data, W, H);
      if (rgb) { const c = classifyColour(rgb); if (c === "skin" || c === "dark") { nSkin++; return false; } }
      return true;
    });

    // ---- SPLIT MERGED BLOCKS (opt-in, for gap-less cubes): 3 same-colour
    // facelets in a row are detected as one long rectangle — cut them back into
    // unit stickers so each counts. Off by default (would over-split under the
    // perspective size spread of a normal gapped cube).
    if (splitRef.current) shapes = shapeRef.current!.splitMerged(shapes);

    // ---- SIZE GATE (user's insight): on one face every sticker is ~the same
    // size, so a quad whose side is far from the median is NOT a facelet (merged
    // region, background chunk, fragment). Band is wide enough to tolerate the
    // perspective size difference between two visible faces. Needs enough quads
    // for a trustworthy median.
    let nSize = 0;
    if (shapes.length >= 5) {
      const sides = shapes.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
      const medSide = sides[sides.length >> 1];
      shapes = shapes.filter((s) => {
        const r = Math.sqrt(Math.max(1, s.area)) / medSide;
        if (r < 0.5 || r > 2.1) { nSize++; return false; }
        return true;
      });
    }

    // ---- STICKER HISTORY: merge this frame's detections into short-lived tracks
    // (TTL ~8 frames). A sticker missed on one frame keeps feeding the links.
    const TTL = 12;
    const tracks = tracksRef.current;
    for (const t of tracks) t.ttl--;
    for (const s of shapes) {
      const side = Math.sqrt(Math.max(1, s.area));
      let best: { shape: TrackedShape; ttl: number } | null = null, bd = Infinity;
      for (const t of tracks) {
        const d = Math.hypot(t.shape.center.x - s.center.x, t.shape.center.y - s.center.y);
        if (d < bd) { bd = d; best = t; }
      }
      if (best && bd < 0.9 * side) { best.shape = s as TrackedShape; best.ttl = TTL; }
      else tracks.push({ shape: s as TrackedShape, ttl: TTL });
    }
    tracksRef.current = tracks.filter((t) => t.ttl > 0);
    const tracked = tracksRef.current.map((t) => t.shape);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pose = tracked.length >= 3 ? cubePoseFromStickers(tracked as any, W, H) : null;

    // tracked stickers (faint; fresher = brighter)
    for (const t of tracksRef.current) {
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(255,255,255,${(0.15 + 0.25 * (t.ttl / TTL)).toFixed(2)})`;
      ctx.beginPath(); t.shape.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath(); ctx.stroke();
    }

    // ---- LIAISONS (primary display): connect DETECTED sticker centres to their
    // grid neighbours — coherent cube-structure links, nothing invented/inferred.
    // Solid green = adjacent; dashed = same row/col skipping one missing cell.
    const allLat = faceLatticesFromStickers(tracked as never[]);
    // DEDUPE over-segmented faces: one physical face split into two groups yields
    // OVERLAPPING surfaces (near-equal centroids). Two genuinely-visible faces sit
    // side by side and don't overlap, so this only removes the spurious duplicates.
    const cxy = (s: Point2[]) => ({ x: (s[0].x + s[1].x + s[2].x + s[3].x) / 4, y: (s[0].y + s[1].y + s[2].y + s[3].y) / 4 });
    const diag = (s: Point2[]) => Math.hypot(s[2].x - s[0].x, s[2].y - s[0].y);
    const lattices: typeof allLat = [];
    for (const lat of [...allLat].sort((a, b) => b.count - a.count)) {
      const c = cxy(lat.surface), sz = diag(lat.surface);
      if (lattices.some((o) => Math.hypot(cxy(o.surface).x - c.x, cxy(o.surface).y - c.y) < 0.5 * Math.max(sz, diag(o.surface)))) continue;
      lattices.push(lat);
    }
    let nLinks = 0, nFound = 0;
    const mem = memRef.current;
    for (let li = 0; li < lattices.length; li++) {
      const lat = lattices[li];
      // dot = detected sticker, painted its Rubik colour; learn the palette
      type Cent = { x: number; y: number; gx: number; gy: number; name: CubeColour; found?: boolean };
      const cents: Cent[] = lat.centres.map((c0) => {
        // sample the WHOLE sticker quad (median over ~25 interior points), not a
        // single centre pixel — robust to glare, logos and edge noise.
        const rgb = sampleQuadRGB(c0.corners, image.data, W, H);
        if (rgb && mem) mem.learn(rgb);
        return { x: c0.x, y: c0.y, gx: c0.gx, gy: c0.gy, name: (rgb ? (mem ? mem.classify(rgb) : classifyColour(rgb)) : "unknown") as CubeColour };
      });

      // ---- MISSING-STICKER SEARCH: for each empty grid cell, vote over sampled
      // pixels; accept a (possibly PARTIAL) sticker if a LEARNED cube colour wins
      // enough of the votes. The learned palette is the discriminator — skin, hair
      // and background don't match a cube colour, so this stays clean.
      if (findMissingRef.current) {
        // Sample ONLY the established sticker footprint (centred, sized by the face's
        // measured stickerFrac) — NOT the whole cell — so we test the sticker area
        // like the detected ones, never the gaps or off-cube margins. lo..hi is the
        // sticker's extent within the cell in [0,1].
        const half = Math.max(0.18, 0.5 * lat.stickerFrac * 0.9);
        const lo = 0.5 - half, hi = 0.5 + half, step = (hi - lo) / 4;
        for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) {
          if (lat.filled[gx][gy] || cents.some((c) => c.gx === gx && c.gy === gy)) continue;
          const A = lat.nodes[gx][gy], B = lat.nodes[gx + 1][gy], C = lat.nodes[gx + 1][gy + 1], D = lat.nodes[gx][gy + 1];
          const mid = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
          if (mid.x < rx0 || mid.x > rx1 || mid.y < ry0 || mid.y > ry1) continue;   // must be inside the operating zone
          const votes: Record<string, number> = {}; let tot = 0;
          const uv: Record<string, { u: number; v: number }[]> = {};
          for (let u = lo; u <= hi + 1e-6; u += step) for (let v = lo; v <= hi + 1e-6; v += step) {
            const x = (1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x;
            const y = (1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y;
            const rgb = sampleQuadRGB([{ x: x - 2, y: y - 2 }, { x: x + 2, y: y - 2 }, { x: x + 2, y: y + 2 }, { x: x - 2, y: y + 2 }], image.data, W, H);
            if (!rgb) continue;
            tot++;
            const c = mem ? mem.classify(rgb) : classifyColour(rgb);
            if (c === "skin" || c === "dark" || c === "unknown") continue;   // not a cube colour
            if (mem && mem.ready() >= 3 && !mem.refs[c as keyof typeof mem.refs]) continue;   // only LEARNED colours
            votes[c] = (votes[c] || 0) + 1;
            (uv[c] ??= []).push({ u, v });
          }
          let bestC = "", bestN = 0;
          for (const k in votes) if (votes[k] > bestN) { bestN = votes[k]; bestC = k; }
          // the winning colour's ZONE must be about a whole sticker in size: its
          // spread must cover most of the sticker footprint (dimensioned by the
          // established stickerFrac), else it's a colour sliver, not a facelet.
          const pts = uv[bestC] ?? [];
          const uSpan = pts.length ? Math.max(...pts.map((p) => p.u)) - Math.min(...pts.map((p) => p.u)) : 0;
          const vSpan = pts.length ? Math.max(...pts.map((p) => p.v)) - Math.min(...pts.map((p) => p.v)) : 0;
          const sizeOK = uSpan >= 0.6 * (hi - lo) && vSpan >= 0.6 * (hi - lo);
          if (tot > 0 && bestN / tot >= 0.45 && sizeOK) {   // enough coverage AND sticker-sized zone
            cents.push({ x: mid.x, y: mid.y, gx, gy, name: bestC as CubeColour, found: true });
            nFound++;
          }
        }
      }

      // ---- WHITE COMPLETION (ALWAYS ON): white facelets can't be found by shape/
      // edge detection (they glare & blend). Find them by GRID POSITION instead —
      // any empty cell of a formed face that reads bright & neutral is a white
      // facelet. Furniture can never qualify: it never lands on a formed face's
      // grid cell. This is the primary white mechanism.
      {
        const half = Math.max(0.18, 0.5 * lat.stickerFrac * 0.9);
        const lo = 0.5 - half, hi = 0.5 + half, step = (hi - lo) / 4;
        for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) {
          if (lat.filled[gx][gy] || cents.some((c) => c.gx === gx && c.gy === gy)) continue;
          const A = lat.nodes[gx][gy], B = lat.nodes[gx + 1][gy], C = lat.nodes[gx + 1][gy + 1], D = lat.nodes[gx][gy + 1];
          const mid = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
          if (mid.x < rx0 || mid.x > rx1 || mid.y < ry0 || mid.y > ry1) continue;
          let whiteN = 0, tot = 0; const wpts: { u: number; v: number }[] = [];
          for (let u = lo; u <= hi + 1e-6; u += step) for (let v = lo; v <= hi + 1e-6; v += step) {
            const x = (1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x;
            const y = (1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y;
            const rgb = sampleQuadRGB([{ x: x - 2, y: y - 2 }, { x: x + 2, y: y - 2 }, { x: x + 2, y: y + 2 }, { x: x - 2, y: y + 2 }], image.data, W, H);
            if (!rgb) continue;
            tot++;
            const mx = Math.max(rgb[0], rgb[1], rgb[2]), mn = Math.min(rgb[0], rgb[1], rgb[2]);
            const sat = mx > 0 ? (mx - mn) / mx : 0;
            const whiteByMem = mem && (mem.refs.white?.n ?? 0) >= 4 ? mem.classify(rgb) === "white" : false;
            if (whiteByMem || (mx > 140 && sat < 0.30)) { whiteN++; wpts.push({ u, v }); }   // bright & neutral
          }
          // the white zone must be about a whole sticker in size (spread over the footprint)
          const uSpan = wpts.length ? Math.max(...wpts.map((p) => p.u)) - Math.min(...wpts.map((p) => p.u)) : 0;
          const vSpan = wpts.length ? Math.max(...wpts.map((p) => p.v)) - Math.min(...wpts.map((p) => p.v)) : 0;
          if (tot > 0 && whiteN / tot >= 0.5 && uSpan >= 0.6 * (hi - lo) && vSpan >= 0.6 * (hi - lo)) {
            cents.push({ x: mid.x, y: mid.y, gx, gy, name: "white", found: true });
            nFound++;
          }
        }
      }

      for (let a = 0; a < cents.length; a++) for (let b = a + 1; b < cents.length; b++) {
        const A = cents[a], B = cents[b];
        const dgx = Math.abs(A.gx - B.gx), dgy = Math.abs(A.gy - B.gy);
        if (dgx + dgy === 1) {
          ctx.setLineDash([]); ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(0,255,120,0.9)";
        } else if ((dgx === 2 && dgy === 0) || (dgx === 0 && dgy === 2)) {
          ctx.setLineDash([6, 5]); ctx.lineWidth = 1.8; ctx.strokeStyle = "rgba(0,255,120,0.55)";
        } else continue;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); nLinks++;
      }
      ctx.setLineDash([]);
      for (const c0 of cents) {
        ctx.beginPath(); ctx.arc(c0.x, c0.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = colourHex(c0.name); ctx.fill();
        ctx.lineWidth = c0.found ? 2 : 1.5;
        ctx.strokeStyle = c0.found ? "#ffffff" : "#000";   // white ring = found in an empty cell
        ctx.stroke();
      }
      // dominant face (li===0): expose its 9-cell readout for capture/validation
      if (li === 0) {
        const cells: CubeColour[] = Array(9).fill("unknown");
        for (const c0 of cents) cells[c0.gy * 3 + c0.gx] = c0.name;
        const known = cells.filter((c) => c !== "unknown").length;
        lastFaceRef.current = { center: cells[4], cells, known };
      }
      // optional extrapolated 3×3 grid — ONLY when the grid pitch matches the
      // sticker shape dimensions (the cube's computed size is coherent). An
      // incoherent grid (cells not sticker-sized) is not drawn.
      if (showLatticeRef.current && lat.gridCoherent) {
        ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,140,0,0.7)";
        for (let u = 0; u < 4; u++) {
          ctx.beginPath(); ctx.moveTo(lat.nodes[u][0].x, lat.nodes[u][0].y); ctx.lineTo(lat.nodes[u][3].x, lat.nodes[u][3].y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(lat.nodes[0][u].x, lat.nodes[0][u].y); ctx.lineTo(lat.nodes[3][u].x, lat.nodes[3][u].y); ctx.stroke();
        }
      }
      // CONTOUR SENSOR: each face's surface is the grid extrapolated (via measured
      // sticker proportions) out to the physical cube edge → the exact border.
      if (contourRef.current && lat.gridCoherent) {
        const sf = lat.surface;
        // sanity: skip if the surface fell outside the operating zone (bad face fit)
        const margin = 0.6 * (rx1 - rx0);
        const outside = sf.some((p) => p.x < rx0 - margin || p.x > rx1 + margin || p.y < ry0 - margin || p.y > ry1 + margin);
        if (outside) continue;
        ctx.fillStyle = "rgba(255,0,200,0.10)";
        ctx.beginPath(); sf.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,0,200,0.95)"; ctx.stroke();
        ctx.fillStyle = "#ff64d2";
        for (const p of sf) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
      }
    }

    if (pose) {
      // POSE-SPACE (quaternion) temporal filter → rigid, no pixel "swimming".
      // Only when the exposed pose actually reprojects the displayed cube (holds for
      // the common close-up/single-face case); else keep the raw resection corners.
      let c = pose.corners;
      let poseOK = false;
      if (pose.pose) {
        const raw = projectPose(pose.pose, W, H);
        const xs = pose.corners.map((p) => p.x), ys = pose.corners.map((p) => p.y);
        const sz = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
        let md = 0; for (let i = 0; i < 8; i++) md = Math.max(md, Math.hypot(raw[i].x - pose.corners[i].x, raw[i].y - pose.corners[i].y));
        poseOK = md < 0.12 * sz;
      }
      if (pose.pose && poseOK) {
        const p = pose.pose;
        const q = matToQuat(p.R);
        const k = [p.f, p.fy ?? p.f, p.cx ?? W / 2, p.cy ?? H / 2, p.s ?? 0];
        const prev = poseRef.current;
        let fq = q, ft = p.t, fk = k;
        if (prev) {
          const dot = Math.abs(prev.q[0] * q[0] + prev.q[1] * q[1] + prev.q[2] * q[2] + prev.q[3] * q[3]);
          const a = dot < 0.7 ? 1 : 0.4;   // big reorientation → snap; else smooth
          fq = slerp(prev.q, q, a);
          ft = p.t.map((v, i) => prev.t[i] + (v - prev.t[i]) * a);
          fk = k.map((v, i) => prev.k[i] + (v - prev.k[i]) * a);
        }
        poseRef.current = { q: fq, t: ft, k: fk };
        c = projectPose({ R: quatToMat(fq), t: ft, f: fk[0], fy: fk[1], cx: fk[2], cy: fk[3], s: fk[4] }, W, H);
      } else {
        poseRef.current = null;
      }
      coastRef.current = { corners: c, edges: pose.edges, ttl: 20 };  // ~0.7s hold
      if (showCubeRef.current) {
        for (const [i, j] of pose.edges) {
          const vertical = i + 4 === j;
          ctx.lineWidth = vertical ? 2 : 3;
          ctx.strokeStyle = vertical ? "rgba(0,224,255,0.6)" : "rgba(0,224,255,0.95)";
          ctx.beginPath(); ctx.moveTo(c[i].x, c[i].y); ctx.lineTo(c[j].x, c[j].y); ctx.stroke();
        }
        ctx.fillStyle = "#00e0ff";
        for (const p of c) { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      }
    } else if (coastRef.current && coastRef.current.ttl > 0) {
      const co = coastRef.current; co.ttl--;
      if (showCubeRef.current) {
        const alpha = 0.25 + 0.5 * (co.ttl / 20);
        ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(0,224,255,${alpha.toFixed(2)})`;
        for (const [i, j] of co.edges) { ctx.beginPath(); ctx.moveTo(co.corners[i].x, co.corners[i].y); ctx.lineTo(co.corners[j].x, co.corners[j].y); ctx.stroke(); }
      }
    } else {
      poseRef.current = null;
      coastRef.current = null;
    }

    // persist the learned palette every ~90 frames
    if (memRef.current && (++frameRef.current % 90 === 0)) memRef.current.save();

    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 300, 24);
    ctx.fillStyle = nLinks ? "#a7f3d0" : "#fca5a5"; ctx.font = "13px system-ui";
    const pal = memRef.current ? memRef.current.ready() : 0;
    ctx.fillText(`${nLinks} liaison(s) · ${tracked.length} stickers${nFound ? `+${nFound}` : ""} · palette ${pal}/6${nSkin ? ` · ${nSkin} peau` : ""}`, 14, 25);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      const net = new CubeNet();
      await net.load("/models/cube_detector.onnx");   // iter4
      netRef.current = net;
      shapeRef.current = new ShapeDetector();
      cropRef.current = document.createElement("canvas");
      const mem = new ColourMemory(); mem.load(); memRef.current = mem;   // recall this cube's palette
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(360);
      setStatus("scanning");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError("Modèle ou caméra : " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const stop = () => { cancelAnimationFrame(rafRef.current); memRef.current?.save(); cameraRef.current?.stop(); cameraRef.current = null; histRef.current = []; poseRef.current = null; coastRef.current = null; zoneRef.current = null; activeRef.current = false; presMissRef.current = 0; setStatus("idle"); };

  // capture the currently visible dominant face into the cube state, keyed by its
  // centre colour (the centre identifies the face). Merges with any prior read of
  // the same face, filling unknown cells.
  const captureFace = () => {
    const f = lastFaceRef.current;
    if (!f || f.center === "unknown" || f.known < 5) return;
    setCubeState((prev) => {
      const existing = prev[f.center];
      const merged = f.cells.map((c, i) => (c !== "unknown" ? c : (existing?.[i] ?? "unknown")));
      return { ...prev, [f.center]: merged };
    });
  };
  const resetScan = () => setCubeState({});

  // ---- COUNT VALIDATION: a real cube has exactly 9 of each colour and 6 distinct
  // centres. Tally the captured faces and flag impossibilities → catches misreads.
  const TALLY: CubeColour[] = ["white", "yellow", "red", "orange", "green", "blue"];
  const counts: Record<string, number> = Object.fromEntries(TALLY.map((c) => [c, 0]));
  let total = 0;
  for (const cells of Object.values(cubeState)) for (const c of cells) if (c in counts) { counts[c]++; total++; }
  const over = TALLY.filter((c) => counts[c] > 9);
  const faces = Object.keys(cubeState).length;

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3 text-sm">
        <span className="font-semibold">Détecteur hybride</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">— ML (zone) + silhouette classique (coins précis)</span>
      </div>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
            {status === "loading" ? "Chargement du modèle…" : "Caméra éteinte"}
          </div>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        {status !== "scanning" ? (
          <button onClick={start} disabled={status === "loading"} className="rounded-xl bg-orange-600 px-5 py-3 font-semibold text-white transition hover:bg-orange-500 disabled:opacity-50">
            {status === "loading" ? "Chargement…" : "Activer la caméra"}
          </button>
        ) : (
          <button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">Arrêter</button>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={showMl} onChange={(e) => setShowMl(e.target.checked)} /> zone ML (cyan)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={showLattice} onChange={(e) => setShowLattice(e.target.checked)} /> grille 3×3 (orange)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={showCube} onChange={(e) => setShowCube(e.target.checked)} /> cube 3D (cyan)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={splitBlocks} onChange={(e) => setSplitBlocks(e.target.checked)} /> découper blocs même couleur (sans gap)
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-fuchsia-600 dark:text-fuchsia-400">
          <input type="checkbox" checked={showContour} onChange={(e) => setShowContour(e.target.checked)} /> contour exact du cube
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={findMissing} onChange={(e) => setFindMissing(e.target.checked)} /> chercher étiquettes manquantes
        </label>
        <button onClick={() => { try { localStorage.removeItem("rubix-palette"); } catch { } if (memRef.current) memRef.current.refs = {}; }}
          className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">
          oublier la palette
        </button>
      </div>

      {/* ---- CUBE STATE + COUNT VALIDATION ---- */}
      <div className="mt-4 rounded-xl bg-slate-100 p-4 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:ring-slate-700">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={captureFace} disabled={status !== "scanning"}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50">
            capturer la face
          </button>
          <button onClick={resetScan} className="rounded-lg bg-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">
            réinitialiser le scan
          </button>
          <span className="text-sm text-slate-600 dark:text-slate-400">faces <strong>{faces}/6</strong> · facettes <strong>{total}/54</strong></span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {TALLY.map((c) => (
            <span key={c} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ring-1 ${counts[c] > 9 ? "bg-red-100 text-red-800 ring-red-300 dark:bg-red-950/50 dark:text-red-300" : "bg-white text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700"}`}>
              <span className="inline-block h-3 w-3 rounded-sm ring-1 ring-black/20" style={{ backgroundColor: colourHex(c) }} />
              {counts[c]}/9
            </span>
          ))}
        </div>
        {over.length > 0 && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
            ⚠ Erreur de lecture : trop de {over.join(", ")} (&gt; 9). Recapture la/les faces concernées.
          </p>
        )}
        {faces === 6 && over.length === 0 && total === 54 && TALLY.every((c) => counts[c] === 9) && (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
            ✓ Cube complet et cohérent : 6 faces, 9 de chaque couleur.
          </p>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Montre une face au cube, puis <strong>capturer la face</strong> ; tourne le cube et recommence pour les 6 faces.
        La palette apprise fiabilise rouge/orange ; le comptage valide qu&apos;il y a bien 9 de chaque couleur et 6 centres.
      </p>
    </div>
  );
}
