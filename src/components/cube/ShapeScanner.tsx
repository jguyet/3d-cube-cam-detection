"use client";

import { useEffect, useRef, useState } from "react";
import {
  CameraStream,
  FrameGrabber,
  ShapeDetector,
  ShapeTracker,
} from "@/lib/rubik-detector";

type Status = "idle" | "scanning" | "error";

// Second, independent algorithm: real-time geometric-shape (quad) detection with
// temporal tracking and background removal. Does not touch the cube detector.
export default function ShapeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const detectorRef = useRef<ShapeDetector | null>(null);
  const trackerRef = useRef<ShapeTracker | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      cameraRef.current?.stop();
    };
  }, []);

  const loop = (t: number) => {
    rafRef.current = requestAnimationFrame(loop);
    if (t - lastRef.current < 50) return; // ~20 fps
    lastRef.current = t;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const grabber = grabberRef.current;
    const detector = detectorRef.current;
    const tracker = trackerRef.current;
    if (!video || !canvas || !grabber || !detector || !tracker) return;

    const image = grabber.grab(video);
    if (!image) return;

    canvas.width = grabber.width;
    canvas.height = grabber.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);

    const shapes = detector.detect(image);
    const tracked = tracker.update(shapes);

    for (const tr of tracked) {
      const c = tr.corners;
      ctx.beginPath();
      ctx.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < c.length; i++) ctx.lineTo(c[i].x, c[i].y);
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,255,200,0.95)";
      ctx.stroke();
      // stable id, fades in with age
      ctx.fillStyle = `rgba(255,224,0,${Math.min(0.95, 0.4 + tr.age * 0.08)})`;
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillText(String(tr.id), tr.center.x - 4, tr.center.y + 3);
    }

    setCount(tracked.length);
  };

  const start = async () => {
    setError(null);
    try {
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(360);
      detectorRef.current = new ShapeDetector();
      trackerRef.current = new ShapeTracker();
      setStatus("scanning");
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e) + " (HTTPS/localhost requis)");
    }
  };

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    cameraRef.current?.stop();
    cameraRef.current = null;
    detectorRef.current?.reset();
    trackerRef.current?.reset();
    setStatus("idle");
    setCount(0);
  };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-semibold">Détecteur de formes</span>
        <span className="text-slate-500 dark:text-slate-400">— quadrilatères + suivi temporel (JS pur)</span>
        {status === "scanning" && (
          <span className="ml-auto rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            {count} forme{count > 1 ? "s" : ""} suivie{count > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">Caméra éteinte</div>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        {status !== "scanning" ? (
          <button onClick={start} className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-500">
            Activer la caméra
          </button>
        ) : (
          <button onClick={stop} className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">
            Arrêter
          </button>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Algo 2, indépendant : grayscale → Sobel → régions entre arêtes → quadrilatères bien remplis
        (fond retiré : régions trop grandes ou collées au bord ignorées) → suivi temporel avec ID stable.
      </p>
    </div>
  );
}
