"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";
import { fitCube } from "@/lib/ml/cubeFit";
import { refineCubeSilhouette } from "@/lib/ml/cubeRefine";

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
  const rafRef = useRef(0);
  const busyRef = useRef(false);
  const histRef = useRef<MLResult[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showMl, setShowMl] = useState(true);

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

    // ---- ML zone → bbox over the visible corners ----
    const vis = sc.filter((p) => p.w >= VIS_MIN);
    if (vis.length < 3) return;
    let minx = 1, miny = 1, maxx = 0, maxy = 0;
    for (const p of vis) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
    const bbox = { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, w: Math.max(0.02, maxx - minx), h: Math.max(0.02, maxy - miny) };

    // ---- ML cube-fit (cyan, faint) for reference ----
    if (showMl) {
      const fitInput = sc.map((p) => ({ x: p.x, y: p.y, w: p.w >= VIS_MIN ? p.w : 0 }));
      const fit = vis.length >= 6 ? fitCube(fitInput) : null;
      if (fit) {
        const c = fit.corners;
        ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,224,255,0.55)";
        for (const [i, j] of res.edges) {
          ctx.beginPath(); ctx.moveTo(c[i].x * W, c[i].y * H); ctx.lineTo(c[j].x * W, c[j].y * H); ctx.stroke();
        }
      }
    }

    // ---- CLASSICAL silhouette inside the ML zone (orange, bold) ----
    const refined = refineCubeSilhouette(image, bbox);
    if (refined) {
      const poly = refined.poly;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,140,0,0.95)";
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = "#ff8c00";
      for (const p of poly) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 210, 24);
      ctx.fillStyle = "#ffd08a"; ctx.font = "13px system-ui";
      ctx.fillText(`silhouette classique: ${poly.length} sommets`, 14, 25);
    }
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      const net = new CubeNet();
      await net.load("/models/cube_detector.onnx");   // iter4
      netRef.current = net;
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

  const stop = () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); cameraRef.current = null; histRef.current = []; setStatus("idle"); };

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
          <input type="checkbox" checked={showMl} onChange={(e) => setShowMl(e.target.checked)} /> superposer le cube ML (cyan)
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Test hybride : le ML (iter4) localise la <strong>zone</strong> du cube, puis la <strong>silhouette classique</strong>
        (contour orange) est calée sur les vrais bords du cube dans cette zone. Objectif : coins précis au pixel.
      </p>
    </div>
  );
}
