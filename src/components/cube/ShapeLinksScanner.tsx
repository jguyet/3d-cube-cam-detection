"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { sampleQuadRGB, classifyColour, colourHex } from "@/lib/ml/stickerColor";

type Status = "idle" | "loading" | "scanning" | "error";

// Same live RAW ShapeDetector view as /shape-detector-test, PLUS links drawn
// between the detected shapes — so the grid structure emerging from the raw
// detections is visible (neighbours connected, or every pair).
export default function ShapeLinksScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<CameraStream | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const detRef = useRef<ShapeDetector | null>(null);
  const rafRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const [thr, setThr] = useState(72);
  const [adaptive, setAdaptive] = useState(true);
  const [showWhite, setShowWhite] = useState(true);
  const [showColour, setShowColour] = useState(true);
  const [splitBlocks, setSplitBlocks] = useState(true);
  const [linkMode, setLinkMode] = useState<"neighbours" | "all">("neighbours");
  const [res, setRes] = useState(560);
  const r = useRef({ thr, adaptive, showWhite, showColour, splitBlocks, linkMode });
  r.current = { thr, adaptive, showWhite, showColour, splitBlocks, linkMode };

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

    const region = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    let shapes = det.detect(image, o.thr, region, o.adaptive);
    let whites = o.showWhite ? det.detectWhite(image, region, false) : [];
    // SPLIT MERGED same-colour blocks (gap-less cubes) into unit cells BEFORE links,
    // so a 3-in-a-row merged block becomes 3 stickers that link into the grid.
    if (o.splitBlocks) { shapes = det.splitMerged(shapes); whites = det.splitMerged(whites); }
    const all = [...shapes, ...whites];

    // ---- LINKS between shapes ----
    if (all.length >= 2) {
      const sides = all.map((s) => Math.sqrt(Math.max(1, s.area))).sort((a, b) => a - b);
      const med = sides[sides.length >> 1] || 1;
      const near = 1.8 * med;   // ~one pitch: a neighbour is within ~1.8 sticker sides
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i].center, b = all[j].center;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (o.linkMode === "neighbours" && d > near) continue;
        // colour a link by whether it's a plausible grid neighbour (green) or long (faint)
        const grid = d <= near;
        ctx.lineWidth = grid ? 2 : 1;
        ctx.strokeStyle = grid ? "rgba(0,255,120,0.85)" : "rgba(255,255,255,0.18)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    // ---- quads on top ----
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
      drawQuad(s.corners, "rgba(0,224,255,0.9)", fillCol);
    }
    for (const s of whites) drawQuad(s.corners, "rgba(255,224,0,0.9)");
    // centre dots
    ctx.fillStyle = "#fff";
    for (const s of all) { ctx.beginPath(); ctx.arc(s.center.x, s.center.y, 3, 0, Math.PI * 2); ctx.fill(); }

    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(6, 6, 320, 26);
    ctx.fillStyle = "#a7f3d0"; ctx.font = "14px monospace";
    ctx.fillText(`shapes:${all.length}  liens:${o.linkMode}  seuil:${o.adaptive ? `~auto(max${o.thr})` : o.thr}`, 12, 24);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      detRef.current = new ShapeDetector();
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
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          liens
          <select value={linkMode} onChange={(e) => setLinkMode(e.target.value as "neighbours" | "all")} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            <option value="neighbours">voisins</option><option value="all">tous</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
          <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} /> seuil adaptatif
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          {adaptive ? "seuil max" : "seuil"}
          <input type="range" min={40} max={400} step={5} value={thr} onChange={(e) => setThr(+e.target.value)} />
          <span className="w-8 font-mono">{thr}</span>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400"><input type="checkbox" checked={splitBlocks} onChange={(e) => setSplitBlocks(e.target.checked)} /> découper blocs même couleur</label>
        <label className="flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-400"><input type="checkbox" checked={showWhite} onChange={(e) => setShowWhite(e.target.checked)} /> blanc</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={showColour} onChange={(e) => setShowColour(e.target.checked)} /> couleur</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          résolution
          <select value={res} onChange={(e) => setRes(+e.target.value)} disabled={status === "scanning"} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            <option value={360}>360</option><option value={480}>480</option><option value={560}>560</option><option value={720}>720</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Détecteur BRUT (comme <code>/shape-detector-test</code>) + <span className="font-semibold text-emerald-600 dark:text-emerald-400">liens verts</span> entre shapes
        voisins (≤ ~1 pas de grille) — mode <strong>voisins</strong> ou <strong>tous</strong>. Sert à voir la structure de grille émerger des détections.
      </p>
    </div>
  );
}
