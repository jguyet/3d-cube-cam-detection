"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";
import { ShapeDetector, type Shape } from "@/lib/rubik-detector/core/ShapeDetector";
import { colourHex, ColourMemory, darkFraction } from "@/lib/ml/stickerColor";
import { detectCubeFaces, dedupeShapes } from "@/lib/ml/shapeGraph";
import { FaceTracker } from "@/lib/ml/faceTrack";
import { stabiliseZone, type Zone } from "@/lib/ml/temporalStabilise";
import type { Point2 } from "@/lib/rubik-detector/types";

type Status = "idle" | "loading" | "scanning" | "error";
const PRESENCE_ON = 0.45, PRESENCE_OFF = 0.25, VIS_MIN = 0.4;

// V3 — the ML ZONE (hybrid localisation) restricts WHERE we look, then the v2 GRAPH
// face detector does the assembly INSIDE it. Best of both: the ML zone kills the
// cluttered background (no phantom quads) and focuses detection on the cube, while v2
// reads faces straight from the neighbour graph (colour-aware, anisotropic, tracked).
export default function V3ZoneScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cropRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const netRef = useRef<CubeNet | null>(null);
  const detRef = useRef<ShapeDetector | null>(null);
  const memRef = useRef<ColourMemory | null>(null);
  const trackRef = useRef<FaceTracker | null>(null);
  const zoneRef = useRef<Zone | null>(null);
  const histRef = useRef<MLResult[]>([]);
  const activeRef = useRef(false);
  const presMissRef = useRef(0);
  const busyRef = useRef(false);
  const rafRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showZone, setShowZone] = useState(true);
  const [imagine, setImagine] = useState(true);
  const [stabilise, setStabilise] = useState(true);
  const r = useRef({ showZone, imagine, stabilise });
  r.current = { showZone, imagine, stabilise };

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); }, []);

  const FACE_COL = ["#f43f5e", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#f97316"];

  const loop = () => {
    rafRef.current = requestAnimationFrame(loop);
    const video = videoRef.current, canvas = canvasRef.current, grabber = grabberRef.current, net = netRef.current, det = detRef.current, mem = memRef.current, track = trackRef.current;
    if (!video || !canvas || !grabber || !net || !det || !mem || !track || busyRef.current) return;
    const image = grabber.grab(video);
    if (!image) return;
    const W = grabber.width, H = grabber.height;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);
    const o = r.current;

    busyRef.current = true;
    net.predict(image).then((res) => {
      busyRef.current = false;
      if (!res) return;
      const hist = histRef.current; hist.push(res); if (hist.length > 6) hist.shift();
      const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

      // presence hysteresis
      const presence = median(hist.map((h) => h.present));
      if (!activeRef.current) {
        if (presence >= PRESENCE_ON) { activeRef.current = true; presMissRef.current = 0; }
        else { badge(ctx, `aucun cube (${(presence * 100) | 0}%)`); track.update(null); return; }
      } else if (presence < PRESENCE_OFF) {
        if (++presMissRef.current >= 4) { activeRef.current = false; presMissRef.current = 0; zoneRef.current = null; track.update(null); return; }
      } else presMissRef.current = 0;

      // ML corners → stabilised zone bbox
      const sc = Array.from({ length: 8 }, (_, i) => {
        const xs: number[] = [], ys: number[] = [], ws: number[] = [];
        for (const h of hist) { const p = h.corners[i]; xs.push(p.x); ys.push(p.y); ws.push(p.v); }
        return { x: median(xs), y: median(ys), w: median(ws) };
      });
      const vis = sc.filter((p) => p.w >= VIS_MIN), zc = sc.filter((p) => p.w >= 0.25);
      if (vis.length >= 3 && zc.length >= 3) {
        let minx = 1, miny = 1, maxx = 0, maxy = 0;
        for (const p of zc) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
        const ex = 0.18;
        zoneRef.current = stabiliseZone(zoneRef.current, { x0: (minx - ex * (maxx - minx)) * W, x1: (maxx + ex * (maxx - minx)) * W, y0: (miny - ex * (maxy - miny)) * H, y1: (maxy + ex * (maxy - miny)) * H });
      } else if (zoneRef.current && zoneRef.current.miss < 6) {
        zoneRef.current = { ...zoneRef.current, miss: zoneRef.current.miss + 1 };
      } else { track.update(null); return; }
      const rx0 = zoneRef.current.x0, rx1 = zoneRef.current.x1, ry0 = zoneRef.current.y0, ry1 = zoneRef.current.y1;
      const region: Point2[] = [{ x: rx0, y: ry0 }, { x: rx1, y: ry0 }, { x: rx1, y: ry1 }, { x: rx0, y: ry1 }];

      if (o.showZone) { ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,224,255,0.5)"; ctx.setLineDash([5, 4]); ctx.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0); ctx.setLineDash([]); }

      // ---- v2 pipeline INSIDE the zone (hi-res crop for small cubes) ----
      let shapes = det.detect(image, 72, region, true, { colour: true, mem, aspectMax: 5 });
      let whites = det.detectWhite(image, region, false);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw > W * 1.3) {
        const zx = Math.max(0, (rx0 / W) * vw), zy = Math.max(0, (ry0 / H) * vh);
        const zw = Math.min(vw - zx, ((rx1 - rx0) / W) * vw), zh = Math.min(vh - zy, ((ry1 - ry0) / H) * vh);
        if (zw > 16 && zh > 16) {
          const cw = 360, ch = Math.max(48, Math.round((cw * zh) / zw));
          const cc = cropRef.current!; cc.width = cw; cc.height = ch;
          const cctx = cc.getContext("2d", { willReadFrequently: true })!;
          cctx.drawImage(video, zx, zy, zw, zh, 0, 0, cw, ch);
          const cropImg = cctx.getImageData(0, 0, cw, ch);
          const cropRegion: Point2[] = [{ x: 0, y: 0 }, { x: cw, y: 0 }, { x: cw, y: ch }, { x: 0, y: ch }];
          const sx = (rx1 - rx0) / cw, sy = (ry1 - ry0) / ch;
          const mapBack = (s: Shape): Shape => ({ corners: s.corners.map((p) => ({ x: rx0 + p.x * sx, y: ry0 + p.y * sy })) as Point2[], center: { x: rx0 + s.center.x * sx, y: ry0 + s.center.y * sy }, area: s.area * sx * sy, fill: s.fill, colour: s.colour, rgb: s.rgb });
          const hi = det.detect(cropImg, 72, cropRegion, true, { colour: true, mem, aspectMax: 5 });
          if (hi.length > shapes.length) shapes = hi.map(mapBack);
          whites = det.detectWhite(cropImg, cropRegion, false).map(mapBack);
        }
      }
      // black filter + dedupe → graph faces
      const nb = (s: Shape) => darkFraction(s.corners, image.data, W, H) <= 0.2;
      const all = dedupeShapes([...shapes.filter(nb), ...whites.filter(nb)]);
      const faces = detectCubeFaces(all, { image, mem });

      // ---- draw (dominant face stabilised) ----
      const drawCell = (corners: { x: number; y: number }[], center: { x: number; y: number }, colour: string, detected: boolean, label: string, col: string) => {
        if (!detected && !o.imagine) return;
        const fillCol = colour !== "unknown" ? colourHex(colour as never) : undefined;
        ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
        if (fillCol) { ctx.fillStyle = fillCol; ctx.globalAlpha = detected ? 0.5 : 0.28; ctx.fill(); ctx.globalAlpha = 1; }
        if (detected) { ctx.setLineDash([]); ctx.lineWidth = 3; } else { ctx.setLineDash([5, 4]); ctx.lineWidth = 1.6; }
        ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#fff"; ctx.font = "bold 11px monospace"; ctx.fillText(label, center.x - 6, center.y + 4);
      };
      if (o.stabilise) {
        const slots = track.update(faces[0] ?? null); const col = FACE_COL[0];
        for (const s of slots) drawCell(s.corners, { x: s.cx, y: s.cy }, track.colourOf(s), s.detected, `${s.gx}${s.gy}`, col);
        let fi = 1;
        for (const face of faces.slice(1)) { const c = FACE_COL[fi++ % FACE_COL.length]; for (const cell of face.cells) drawCell(cell.corners, cell.center, cell.colour, cell.detected, `${cell.gx}${cell.gy}`, c); }
      } else {
        track.update(null); let fi = 0;
        for (const face of faces) { const col = FACE_COL[fi++ % FACE_COL.length]; for (const cell of face.cells) drawCell(cell.corners, cell.center, cell.colour, cell.detected, `${cell.gx}${cell.gy}`, col); }
      }

      ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(6, 6, 300, 26);
      ctx.fillStyle = "#a7f3d0"; ctx.font = "14px monospace";
      ctx.fillText(`zone✓  shapes:${all.length}  faces:${faces.length}  ${faces.map((f) => `9(${f.count})`).join(" ")}`, 12, 24);
    }).catch(() => { busyRef.current = false; });
  };

  const badge = (ctx: CanvasRenderingContext2D, text: string) => { ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 176, 26); ctx.fillStyle = "#fca5a5"; ctx.font = "14px system-ui"; ctx.fillText(text, 16, 26); };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      detRef.current = new ShapeDetector();
      memRef.current = new ColourMemory(); memRef.current.load(); memRef.current.seedCanonical();
      trackRef.current = new FaceTracker();
      cropRef.current = document.createElement("canvas");
      const net = new CubeNet(); await net.load("/models/cube_detector.onnx"); netRef.current = net;
      const camera = new CameraStream(); await camera.start(videoRef.current!); cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(560);
      setStatus("scanning");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) { setStatus("error"); setError("Init : " + (e instanceof Error ? e.message : String(e))); }
  };
  const stop = () => { cancelAnimationFrame(rafRef.current); memRef.current?.save(); cameraRef.current?.stop(); cameraRef.current = null; histRef.current = []; zoneRef.current = null; activeRef.current = false; presMissRef.current = 0; setStatus("idle"); };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (<div className="absolute inset-0 grid place-items-center text-sm text-white/60">{status === "loading" ? "Chargement du modèle…" : "Caméra éteinte"}</div>)}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {status !== "scanning" ? (
          <button onClick={start} disabled={status === "loading"} className="rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50">{status === "loading" ? "Chargement…" : "Activer la caméra"}</button>
        ) : (<button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100">Arrêter</button>)}
        <label className="flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-400"><input type="checkbox" checked={showZone} onChange={(e) => setShowZone(e.target.checked)} /> zone ML</label>
        <label className="flex items-center gap-2 text-sm font-medium text-fuchsia-600 dark:text-fuchsia-400"><input type="checkbox" checked={imagine} onChange={(e) => setImagine(e.target.checked)} /> imaginer face complète</label>
        <label className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400"><input type="checkbox" checked={stabilise} onChange={(e) => setStabilise(e.target.checked)} /> stabiliser (anti-shift)</label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <strong>V3</strong> — la <span className="font-semibold text-cyan-600 dark:text-cyan-400">zone ML</span> (iter4) localise le cube et coupe le fond, puis le
        <span className="font-semibold text-emerald-600 dark:text-emerald-400"> détecteur graphe v2</span> assemble les faces 3×3 à l&apos;intérieur (couleur + pitch anisotrope + tracking).
      </p>
    </div>
  );
}
