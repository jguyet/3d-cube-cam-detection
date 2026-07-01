"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";

type Status = "idle" | "loading" | "scanning" | "error";

const PRESENCE_MIN = 0.3;   // calibrated: cube presence ~0.67, no-cube ~0.0 → 0.3 gives recall≈0.72, FP≈0
const VIS_MIN = 0.6;        // hide low-confidence corners (kills the centre-collapse artefact)

// Live inference with the trained ONNX cube detector. Drop your trained
// cube_detector.onnx in public/models/ first.
export default function MLScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const netRef = useRef<CubeNet | null>(null);
  const rafRef = useRef(0);
  const busyRef = useRef(false);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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

    // Gate on the presence head (stricter → fewer false "cube here" on clutter).
    if (res.present < PRESENCE_MIN) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(8, 8, 168, 26);
      ctx.fillStyle = "#fca5a5"; ctx.font = "14px system-ui";
      ctx.fillText(`aucun cube (${(res.present * 100) | 0}%)`, 16, 26);
      return;
    }

    const W = grabber.width, H = grabber.height, c = res.corners;
    // Only draw corners the net is confident about. Uncertain corners soft-argmax
    // to the image centre (flat heatmap) — drawing them creates the "corner stuck
    // at centre" artefact, so we hide them and any edge touching them.
    const vis = c.map((p) => p.v >= VIS_MIN);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,90,230,0.95)";
    for (const [i, j] of res.edges) {
      if (!vis[i] || !vis[j]) continue;
      ctx.beginPath();
      ctx.moveTo(c[i].x * W, c[i].y * H);
      ctx.lineTo(c[j].x * W, c[j].y * H);
      ctx.stroke();
    }
    c.forEach((p, i) => {
      if (!vis[i]) return;
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#00ff78";
      ctx.fill();
    });
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      const net = new CubeNet();
      await net.load();
      netRef.current = net;
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(360);
      setStatus("scanning");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError("Modèle ou caméra : " + (e instanceof Error ? e.message : String(e)) + " — dépose cube_detector.onnx dans public/models/.");
    }
  };

  const stop = () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); cameraRef.current = null; setStatus("idle"); };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3 text-sm">
        <span className="font-semibold">Détecteur ML</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">— cube 3D par réseau entraîné (ONNX)</span>
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
      <div className="mt-4 flex gap-2">
        {status !== "scanning" ? (
          <button onClick={start} disabled={status === "loading"} className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
            {status === "loading" ? "Chargement…" : "Activer la caméra"}
          </button>
        ) : (
          <button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">Arrêter</button>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Prérequis : entraîne le modèle (<code>training/</code>) et dépose <code>cube_detector.onnx</code> dans
        <code> public/models/</code>. Le réseau prédit les 8 coins + faces → cube 3D superposé.
      </p>
    </div>
  );
}
