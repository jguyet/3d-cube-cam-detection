"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { cubePoseFromStickers, faceLatticesFromStickers, projectPose, matToQuat, quatToMat, slerp, type Quat } from "@/lib/ml/cubePoseFromStickers";
import { sampleQuadRGB, classifyColour, colourHex } from "@/lib/ml/stickerColor";
import type { Point2 } from "@/lib/rubik-detector/types";

type Status = "idle" | "loading" | "scanning" | "error";

const PRESENCE_MIN = 0.3;
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
  const poseRef = useRef<{ q: Quat; t: number[]; k: number[] } | null>(null);   // filtered 3D pose (k=[f,fy,cx,cy,s])
  // sticker HISTORY across frames: recently-seen stickers persist a few frames so
  // the links don't flicker with per-frame detection dropouts
  type TrackedShape = { corners: [Point2, Point2, Point2, Point2]; center: Point2; area: number; fill: number };
  const tracksRef = useRef<{ shape: TrackedShape; ttl: number }[]>([]);
  const coastRef = useRef<{ corners: Point2[]; edges: [number, number][]; ttl: number } | null>(null); // hold last pose through dropouts
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

    const presence = median(hist.map((h) => h.present));
    if (presence < PRESENCE_MIN) {
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 168, 26);
      ctx.fillStyle = "#fca5a5"; ctx.font = "14px system-ui";
      ctx.fillText(`aucun cube (${(presence * 100) | 0}%)`, 16, 26);
      return;
    }

    const W = grabber.width, H = grabber.height;
    const sc = Array.from({ length: 8 }, (_, i) => {
      const xs: number[] = [], ys: number[] = [], ws: number[] = [];
      for (const h of hist) { const p = h.corners[i]; xs.push(p.x); ys.push(p.y); ws.push(p.v); }
      return { x: median(xs), y: median(ys), w: median(ws) };
    });

    // ---- ML zone → bbox over the visible corners (expanded), in PIXEL coords ----
    const vis = sc.filter((p) => p.w >= VIS_MIN);
    if (vis.length < 3) return;
    let minx = 1, miny = 1, maxx = 0, maxy = 0;
    for (const p of vis) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
    const ex = 0.18;
    const rx0 = (minx - ex * (maxx - minx)) * W, rx1 = (maxx + ex * (maxx - minx)) * W;
    const ry0 = (miny - ex * (maxy - miny)) * H, ry1 = (maxy + ex * (maxy - miny)) * H;
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
        const hi = shapeRef.current!.detect(cropImg, 125, cropRegion);
        if (hi.length > shapes.length) {   // keep whichever scale found more
          const sx = (rx1 - rx0) / cw, sy = (ry1 - ry0) / ch;
          shapes = hi.map((s) => ({
            corners: s.corners.map((p) => ({ x: rx0 + p.x * sx, y: ry0 + p.y * sy })) as [Point2, Point2, Point2, Point2],
            center: { x: rx0 + s.center.x * sx, y: ry0 + s.center.y * sy },
            area: s.area * sx * sy,
            fill: s.fill,
          }));
        }
      }
    }
    // ---- WHITE PASS: the edge detector misses glared/desaturated white facelets,
    // so also detect them by a brightness+low-saturation mask, and merge any that
    // the edge pass didn't already find (dedupe by centre distance).
    {
      const whites = shapeRef.current!.detectWhite(image, region);
      const near = (a: Point2, b: Point2, s: number) => Math.hypot(a.x - b.x, a.y - b.y) < 0.6 * s;
      for (const wsh of whites) {
        const side = Math.sqrt(Math.max(1, wsh.area));
        if (!shapes.some((s) => near(s.center, wsh.center, side))) shapes.push(wsh);
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
    const TTL = 8;
    const tracks = tracksRef.current;
    for (const t of tracks) t.ttl--;
    for (const s of shapes) {
      const side = Math.sqrt(Math.max(1, s.area));
      let best: { shape: TrackedShape; ttl: number } | null = null, bd = Infinity;
      for (const t of tracks) {
        const d = Math.hypot(t.shape.center.x - s.center.x, t.shape.center.y - s.center.y);
        if (d < bd) { bd = d; best = t; }
      }
      if (best && bd < 0.7 * side) { best.shape = s as TrackedShape; best.ttl = TTL; }
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
    const lattices = faceLatticesFromStickers(tracked as never[]);
    let nLinks = 0;
    for (const lat of lattices) {
      const cents = lat.centres;
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
      for (const c0 of cents) {   // dot = detected sticker, painted its Rubik colour
        const rgb = sampleQuadRGB([{ x: c0.x - 4, y: c0.y - 4 }, { x: c0.x + 4, y: c0.y - 4 }, { x: c0.x + 4, y: c0.y + 4 }, { x: c0.x - 4, y: c0.y + 4 }], image.data, W, H);
        ctx.beginPath(); ctx.arc(c0.x, c0.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = rgb ? colourHex(classifyColour(rgb)) : "#00ff78"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = "#000"; ctx.stroke();
      }
      if (showLatticeRef.current) {   // optional extrapolated 3×3 grid (off by default)
        ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,140,0,0.7)";
        for (let u = 0; u < 4; u++) {
          ctx.beginPath(); ctx.moveTo(lat.nodes[u][0].x, lat.nodes[u][0].y); ctx.lineTo(lat.nodes[u][3].x, lat.nodes[u][3].y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(lat.nodes[0][u].x, lat.nodes[0][u].y); ctx.lineTo(lat.nodes[3][u].x, lat.nodes[3][u].y); ctx.stroke();
        }
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
      coastRef.current = { corners: c, edges: pose.edges, ttl: 14 };  // ~0.5s hold
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
        const alpha = 0.25 + 0.5 * (co.ttl / 14);
        ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(0,224,255,${alpha.toFixed(2)})`;
        for (const [i, j] of co.edges) { ctx.beginPath(); ctx.moveTo(co.corners[i].x, co.corners[i].y); ctx.lineTo(co.corners[j].x, co.corners[j].y); ctx.stroke(); }
      }
    } else {
      poseRef.current = null;
      coastRef.current = null;
    }

    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 280, 24);
    ctx.fillStyle = nLinks ? "#a7f3d0" : "#fca5a5"; ctx.font = "13px system-ui";
    ctx.fillText(`${nLinks} liaison(s) · ${tracked.length} stickers · ${lattices.length} face(s)${nSkin ? ` · ${nSkin} peau/cheveux` : ""}${nSize ? ` · ${nSize} hors-taille` : ""}`, 14, 25);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      const net = new CubeNet();
      await net.load("/models/cube_detector.onnx");   // iter4
      netRef.current = net;
      shapeRef.current = new ShapeDetector();
      cropRef.current = document.createElement("canvas");
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

  const stop = () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); cameraRef.current = null; histRef.current = []; poseRef.current = null; coastRef.current = null; setStatus("idle"); };

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
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Test hybride : le ML (iter4) localise la <strong>zone</strong> du cube, puis la <strong>silhouette classique</strong>
        (contour orange) est calée sur les vrais bords du cube dans cette zone. Objectif : coins précis au pixel.
      </p>
    </div>
  );
}
