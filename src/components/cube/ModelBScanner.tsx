"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { CubeNet, type MLResult } from "@/lib/ml/cubeNet";

type Status = "idle" | "loading" | "scanning" | "error";
const PRESENCE_MIN = 0.3;

// Visualise MODEL B: the learned sticker-centre DENSITY heatmap + its peaks (NMS),
// live on the camera. Lets you SEE what the second model detects (vs the classical
// detector). Loads /models/cube_detector_modelb.onnx.
export default function ModelBScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const netRef = useRef<CubeNet | null>(null);
  const rafRef = useRef(0);
  const busyRef = useRef(false);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [thr, setThr] = useState(0.25);
  const thrRef = useRef(0.25);
  thrRef.current = thr;

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

    const W = grabber.width, H = grabber.height;
    if (res.present < PRESENCE_MIN || !res.stickers) {
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 250, 26);
      ctx.fillStyle = "#fca5a5"; ctx.font = "14px system-ui";
      ctx.fillText(res.stickers ? `aucun cube (${(res.present * 100) | 0}%)` : "modèle sans sortie stickers", 16, 26);
      return;
    }

    const { data, w: sw, h: sh } = res.stickers;
    // 1) heatmap overlay (green glow, alpha = density)
    const cw = W / sw, ch = H / sh;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const v = data[y * sw + x];
      if (v < 0.08) continue;
      ctx.fillStyle = `rgba(0,255,120,${Math.min(0.6, v * 0.7)})`;
      ctx.fillRect(x * cw, y * ch, cw + 1, ch + 1);
    }
    // 2) NMS peaks (detected sticker centres)
    const t = thrRef.current;
    let peaks = 0;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const v = data[y * sw + x];
      if (v < t) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
        if (data[ny * sw + nx] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      peaks++;
      const px = (x + 0.5) * cw, py = (y + 0.5) * ch;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#00ff78"; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#000"; ctx.stroke();
    }
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(8, 8, 260, 26);
    ctx.fillStyle = "#a8f0ff"; ctx.font = "14px system-ui";
    ctx.fillText(`Modèle B — ${peaks} centres de stickers (seuil ${t.toFixed(2)})`, 16, 26);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      const net = new CubeNet();
      await net.load("/models/cube_detector_modelb.onnx");
      netRef.current = net;
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(360);
      setStatus("scanning");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError("Modèle B ou caméra : " + (e instanceof Error ? e.message : String(e)) + " — dépose cube_detector_modelb.onnx dans public/models/.");
    }
  };

  const stop = () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); cameraRef.current = null; setStatus("idle"); };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3 text-sm">
        <span className="font-semibold">Modèle B</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">— densité de centres de stickers apprise (visualisation)</span>
      </div>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
            {status === "loading" ? "Chargement du Modèle B…" : "Caméra éteinte"}
          </div>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">{error}</p>}
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        {status !== "scanning" ? (
          <button onClick={start} disabled={status === "loading"} className="rounded-xl bg-cyan-600 px-5 py-3 font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-50">
            {status === "loading" ? "Chargement…" : "Activer la caméra"}
          </button>
        ) : (
          <button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">Arrêter</button>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          seuil pics
          <input type="range" min={0.1} max={0.9} step={0.05} value={thr} onChange={(e) => setThr(+e.target.value)} />
          {thr.toFixed(2)}
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Le vert = densité de stickers prédite par le Modèle B ; points = pics (centres détectés). Compare avec la
        détection classique de <code>/scanner-hybrid</code>. Note : sur du réel, le Modèle B détecte peu de stickers
        (écart sim→réel) — le détecteur classique reste plus fiable.
      </p>
    </div>
  );
}
