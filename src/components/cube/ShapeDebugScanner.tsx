"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { sampleQuadRGB, classifyColour, colourHex, ColourMemory } from "@/lib/ml/stickerColor";

type Status = "idle" | "loading" | "scanning" | "error";

// Live validation of the RAW ShapeDetector — no ML zone, no grid, no memory. Shows
// exactly what detect()/detectWhite() produce on the live feed so the detector can
// be tuned/diagnosed: adjustable threshold, edge-map view, per-quad fill/aspect.
export default function ShapeDebugScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const detRef = useRef<ShapeDetector | null>(null);
  const memRef = useRef<ColourMemory | null>(null);
  const rafRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const [thr, setThr] = useState(72);
  const [adaptive, setAdaptive] = useState(true);
  const [showWhite, setShowWhite] = useState(true);
  const [showEdges, setShowEdges] = useState(false);
  const [showColour, setShowColour] = useState(true);
  const [colourEdges, setColourEdges] = useState(true);
  const [res, setRes] = useState(560);
  const r = useRef({ thr, adaptive, showWhite, showEdges, showColour, colourEdges });
  r.current = { thr, adaptive, showWhite, showEdges, showColour, colourEdges };

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); }, []);

  const loop = () => {
    rafRef.current = requestAnimationFrame(loop);
    const video = videoRef.current, canvas = canvasRef.current, grabber = grabberRef.current, det = detRef.current;
    if (!video || !canvas || !grabber || !det) return;
    const image = grabber.grab(video);
    if (!image) return;
    const W = grabber.width, H = grabber.height;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);
    const o = r.current;

    // edge map underlay
    let effT = o.thr;
    if (o.showEdges) {
      const { edges, T } = det.debugEdges(image, o.thr, o.adaptive);
      effT = T;
      const ov = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < edges.length; i++) if (edges[i]) { const p = i * 4; ov.data[p] = 255; ov.data[p + 1] = 0; ov.data[p + 2] = 255; }
      ctx.putImageData(ov, 0, 0);
    }

    // detect() quads (region = whole frame so nothing is zone-gated)
    const region = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const shapes = det.detect(image, o.thr, region, o.adaptive, o.colourEdges ? { colour: true, mem: memRef.current!, aspectMax: 5 } : { aspectMax: 5 });
    const whites = o.showWhite ? det.detectWhite(image, region, false) : [];

    const drawQuad = (corners: { x: number; y: number }[], stroke: string, fillCol?: string) => {
      ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      if (fillCol) { ctx.fillStyle = fillCol; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke();
      ctx.fillStyle = stroke;
      for (const p of corners) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
    };

    for (const s of shapes) {
      let fillCol: string | undefined;
      if (o.showColour) { const rgb = sampleQuadRGB(s.corners, image.data, W, H); if (rgb) fillCol = colourHex(classifyColour(rgb)); }
      drawQuad(s.corners, "rgba(0,255,120,0.95)", fillCol);
    }
    for (const s of whites) drawQuad(s.corners, "rgba(0,224,255,0.95)");

    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(6, 6, 300, 26);
    ctx.fillStyle = "#a7f3d0"; ctx.font = "14px monospace";
    ctx.fillText(`edge:${shapes.length}  white:${whites.length}  seuil:${o.adaptive ? `~${effT}(auto,max${o.thr})` : o.thr}`, 12, 24);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      detRef.current = new ShapeDetector();
      memRef.current = new ColourMemory(); memRef.current.seedCanonical();
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(res);
      setStatus("scanning");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError("Caméra : " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const stop = () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); cameraRef.current = null; setStatus("idle"); };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
            {status === "loading" ? "Chargement…" : "Caméra éteinte"}
          </div>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {status !== "scanning" ? (
          <button onClick={start} disabled={status === "loading"} className="rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50">
            {status === "loading" ? "Chargement…" : "Activer la caméra"}
          </button>
        ) : (
          <button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100">Arrêter</button>
        )}
        <label className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
          <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} /> seuil adaptatif
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          {adaptive ? "seuil max" : "seuil arête"}
          <input type="range" min={40} max={400} step={5} value={thr} onChange={(e) => setThr(+e.target.value)} />
          <span className="w-8 font-mono">{thr}</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-400"><input type="checkbox" checked={showWhite} onChange={(e) => setShowWhite(e.target.checked)} /> détection blanc</label>
        <label className="flex items-center gap-2 text-sm text-fuchsia-600 dark:text-fuchsia-400"><input type="checkbox" checked={showEdges} onChange={(e) => setShowEdges(e.target.checked)} /> carte d&apos;arêtes</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={showColour} onChange={(e) => setShowColour(e.target.checked)} /> couleur des quads</label>
        <label className="flex items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400"><input type="checkbox" checked={colourEdges} onChange={(e) => setColourEdges(e.target.checked)} /> frontières couleur (vrai pipeline)</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          résolution
          <select value={res} onChange={(e) => setRes(+e.target.value)} disabled={status === "scanning"} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            <option value={360}>360</option><option value={480}>480</option><option value={560}>560</option><option value={720}>720</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-semibold text-emerald-600 dark:text-emerald-400">Vert</span> = quads de <code>detect()</code> (rempli de leur couleur classée) ·
        <span className="font-semibold text-cyan-600 dark:text-cyan-400"> Cyan</span> = <code>detectWhite()</code> ·
        <span className="font-semibold text-fuchsia-600 dark:text-fuchsia-400"> Magenta</span> = carte d&apos;arêtes (ce que le détecteur « voit »).
        Détecteur BRUT, sans zone ML ni grille ni mémoire — pour régler le seuil et voir les manques.
      </p>
    </div>
  );
}
