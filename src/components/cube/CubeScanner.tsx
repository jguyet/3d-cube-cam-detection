"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import {
  CameraStream,
  FrameGrabber,
  RubikFaceDetector,
  CubeTracker,
  DebugOverlay,
} from "@/lib/rubik-detector";

type Status = "idle" | "scanning" | "error";

// V1 (pure JS, no OpenCV): detect the cube's main face (a square quad) and draw
// it. No colours, no pose, no full-cube state yet.
export default function CubeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const detectorRef = useRef<RubikFaceDetector | null>(null);
  const trackerRef = useRef<CubeTracker | null>(null);
  const overlayRef = useRef<DebugOverlay | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const lastImageRef = useRef<ImageData | null>(null);
  const recRef = useRef<{ frames: ImageData[]; target: number } | null>(null);
  const [recording, setRecording] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nFaces, setNFaces] = useState(0);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      cameraRef.current?.stop();
    };
  }, []);

  const loop = (t: number) => {
    rafRef.current = requestAnimationFrame(loop);
    if (t - lastRef.current < 66) return; // ~15 fps
    lastRef.current = t;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const grabber = grabberRef.current;
    const detector = detectorRef.current;
    const tracker = trackerRef.current;
    const overlay = overlayRef.current;
    if (!video || !canvas || !grabber || !detector || !tracker || !overlay) return;

    const image = grabber.grab(video);
    if (!image) return;
    lastImageRef.current = image;

    // Burst recording: collect frames, then pack into one tall sprite PNG.
    if (recRef.current) {
      recRef.current.frames.push(image);
      if (recRef.current.frames.length >= recRef.current.target) {
        const frames = recRef.current.frames;
        recRef.current = null;
        setRecording(false);
        const fw = frames[0].width, fh = frames[0].height;
        const sprite = document.createElement("canvas");
        sprite.width = fw;
        sprite.height = fh * frames.length;
        const sctx = sprite.getContext("2d")!;
        frames.forEach((f, i) => sctx.putImageData(f, 0, i * fh));
        sprite.toBlob((b) => {
          if (!b) return;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(b);
          a.download = `cube-seq-${frames.length}x${fw}x${fh}.png`;
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }
    }

    canvas.width = grabber.width;
    canvas.height = grabber.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);

    const det = tracker.update(detector.process(image));
    overlay.draw(ctx, det);
    startTransition(() => setNFaces(det.nFaces));
  };

  const start = async () => {
    setError(null);
    try {
      const camera = new CameraStream();
      await camera.start(videoRef.current!);
      cameraRef.current = camera;
      grabberRef.current = new FrameGrabber(360);
      detectorRef.current = new RubikFaceDetector();
      trackerRef.current = new CubeTracker();
      overlayRef.current = new DebugOverlay();
      setStatus("scanning");
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e) + " (HTTPS/localhost requis)");
    }
  };

  const capture = () => {
    const img = lastImageRef.current;
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = "cube-frame.png";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  const recordBurst = () => {
    if (recRef.current) return;
    recRef.current = { frames: [], target: 24 }; // ~2 s at the loop rate
    setRecording(true);
  };

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    cameraRef.current?.stop();
    cameraRef.current = null;
    setStatus("idle");
    setNFaces(0);
  };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-semibold">Détecteur cube</span>
        <span className="text-slate-500 dark:text-slate-400">— faces visibles (JS pur)</span>
        {status === "scanning" && (
          <span className="ml-auto rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            {nFaces > 0 ? `${nFaces} face${nFaces > 1 ? "s" : ""} détectée${nFaces > 1 ? "s" : ""}` : "cherche le cube…"}
          </span>
        )}
      </div>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
        <video ref={videoRef} playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {status !== "scanning" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
            Caméra éteinte
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        {status !== "scanning" ? (
          <button
            onClick={start}
            className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-500"
          >
            Activer la caméra
          </button>
        ) : (
          <>
            <button
              onClick={capture}
              className="rounded-xl bg-amber-500 px-5 py-3 font-semibold text-white transition hover:bg-amber-400"
            >
              Capturer la frame
            </button>
            <button
              onClick={recordBurst}
              disabled={recording}
              className="rounded-xl bg-rose-500 px-5 py-3 font-semibold text-white transition hover:bg-rose-400 disabled:opacity-50"
            >
              {recording ? "Enregistrement…" : "Capturer 2s (séquence)"}
            </button>
            <button
              onClick={stop}
              className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            >
              Arrêter
            </button>
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        JS pur, sans OpenCV : masque de saturation → silhouette du cube → décomposition en 1, 2 ou 3
        faces. L&apos;overlay ne garde que le wireframe gris du cube reconstruit.
      </p>
    </div>
  );
}
