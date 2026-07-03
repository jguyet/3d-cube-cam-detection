"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { sampleQuadRGB, classifyColour, colourHex } from "@/lib/ml/stickerColor";
import { graphFaces } from "@/lib/ml/shapeGraph";

type Status = "idle" | "loading" | "scanning" | "error";

// V2 ALGO — face position from the NEIGHBOUR GRAPH. We detect square shapes, split
// gap-less blocks, build the neighbour graph, and read each face's grid straight from
// it (rotation + pitch from the links, (gx,gy) by BFS). Then we fit an affine
// (gx,gy)->pixel per face and EXTRAPOLATE the full W×H lattice, so the complete face
// pattern is imagined even when only part of it is detected.
export default function V2AlgoScanner() {
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
  const [splitBlocks, setSplitBlocks] = useState(true);
  const [imagine, setImagine] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [res, setRes] = useState(560);
  const r = useRef({ thr, adaptive, showWhite, splitBlocks, imagine, showLinks });
  r.current = { thr, adaptive, showWhite, splitBlocks, imagine, showLinks };

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); }, []);

  // Least-squares affine fit  (gx,gy,1) -> (px,py).  Returns predictor or null.
  const fitAffine = (pts: { gx: number; gy: number; x: number; y: number }[]) => {
    // normal equations for [a b c] on x and [d e f] on y, sharing the 3x3 gram matrix
    let Sxx = 0, Sxy = 0, Sx1 = 0, Syy = 0, Sy1 = 0, S11 = 0;
    let bXx = 0, bXy = 0, bX1 = 0, bYx = 0, bYy = 0, bY1 = 0;
    for (const p of pts) {
      Sxx += p.gx * p.gx; Sxy += p.gx * p.gy; Sx1 += p.gx;
      Syy += p.gy * p.gy; Sy1 += p.gy; S11 += 1;
      bXx += p.x * p.gx; bXy += p.x * p.gy; bX1 += p.x;
      bYx += p.y * p.gx; bYy += p.y * p.gy; bY1 += p.y;
    }
    const M = [ [Sxx, Sxy, Sx1], [Sxy, Syy, Sy1], [Sx1, Sy1, S11] ];
    const inv = invert3(M); if (!inv) return null;
    const sol = (b0: number, b1: number, b2: number) => [
      inv[0][0] * b0 + inv[0][1] * b1 + inv[0][2] * b2,
      inv[1][0] * b0 + inv[1][1] * b1 + inv[1][2] * b2,
      inv[2][0] * b0 + inv[2][1] * b1 + inv[2][2] * b2,
    ];
    const A = sol(bXx, bXy, bX1), B = sol(bYx, bYy, bY1);
    return (gx: number, gy: number) => ({ x: A[0] * gx + A[1] * gy + A[2], y: B[0] * gx + B[1] * gy + B[2] });
  };
  const invert3 = (m: number[][]) => {
    const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(d) < 1e-9) return null;
    const c = (a: number, b: number, cc: number, dd: number) => a * dd - b * cc;
    return [
      [c(m[1][1], m[1][2], m[2][1], m[2][2]) / d, c(m[0][2], m[0][1], m[2][2], m[2][1]) / d, c(m[0][1], m[0][2], m[1][1], m[1][2]) / d],
      [c(m[1][2], m[1][0], m[2][2], m[2][0]) / d, c(m[0][0], m[0][2], m[2][0], m[2][2]) / d, c(m[0][2], m[0][0], m[1][2], m[1][0]) / d],
      [c(m[1][0], m[1][1], m[2][0], m[2][1]) / d, c(m[0][1], m[0][0], m[2][1], m[2][0]) / d, c(m[0][0], m[0][1], m[1][0], m[1][1]) / d],
    ];
  };

  const FACE_COL = ["#f43f5e", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#f97316"];

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
    if (o.splitBlocks) { shapes = det.splitMerged(shapes, image); whites = det.splitMerged(whites, image); }
    const all = [...shapes, ...whites];

    const { nodes, faces, edges } = graphFaces(all);

    // ---- graph links ----
    if (o.showLinks) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.25)";
      for (const [i, j] of edges) {
        const a = all[i].center, b = all[j].center;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    // ---- per-face reconstruction ----
    let fi = 0;
    const realFaces = faces.filter((f) => f.nodes.length >= 3).sort((a, b) => b.nodes.length - a.nodes.length);
    for (const face of realFaces) {
      const col = FACE_COL[fi % FACE_COL.length]; fi++;
      const pts = face.nodes.map((n) => ({ gx: n.gx, gy: n.gy, x: n.shape.center.x, y: n.shape.center.y }));

      // detected cells: quad + sampled colour + (gx,gy) label
      for (const n of face.nodes) {
        const s = n.shape;
        const rgb = sampleQuadRGB(s.corners, image.data, W, H);
        const fillCol = rgb ? colourHex(classifyColour(rgb)) : undefined;
        ctx.beginPath(); s.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
        if (fillCol) { ctx.fillStyle = fillCol; ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "bold 12px monospace";
        ctx.fillText(`${n.gx},${n.gy}`, s.center.x - 8, s.center.y + 4);
      }

      // IMAGINE the full lattice: fit affine (gx,gy)->pixel, extrapolate a 3×3 (or the
      // face's own span if larger) and draw the cells we did NOT detect as dashed ghosts.
      if (o.imagine && face.nodes.length >= 3) {
        const predict = fitAffine(pts);
        if (predict) {
          const gw = Math.max(3, face.w), gh = Math.max(3, face.h);
          const have = new Set(face.nodes.map((n) => `${n.gx},${n.gy}`));
          // half-cell footprint from the pitch, drawn as a small square around each predicted centre
          const hp = face.pitch * 0.42;
          ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = col;
          for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
            if (have.has(`${gx},${gy}`)) continue;
            const c0 = predict(gx, gy);
            // local axes from neighbouring predicted centres so the ghost follows perspective
            const cx = predict(gx + 1, gy), cy = predict(gx, gy + 1);
            const ux = (cx.x - c0.x) * 0.42, uy = (cx.y - c0.y) * 0.42;
            const vX = (cy.x - c0.x) * 0.42, vY = (cy.y - c0.y) * 0.42;
            const corners = [
              { x: c0.x - ux - vX, y: c0.y - uy - vY }, { x: c0.x + ux - vX, y: c0.y + uy - vY },
              { x: c0.x + ux + vX, y: c0.y + uy + vY }, { x: c0.x - ux + vX, y: c0.y - uy + vY },
            ];
            ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
            void hp;
          }
          ctx.setLineDash([]);
        }
      }
    }

    // centre dots
    ctx.fillStyle = "#fff";
    for (const s of all) { ctx.beginPath(); ctx.arc(s.center.x, s.center.y, 2.5, 0, Math.PI * 2); ctx.fill(); }

    ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(6, 6, 380, 26);
    ctx.fillStyle = "#a7f3d0"; ctx.font = "14px monospace";
    const fdesc = realFaces.map((f) => `${f.w}×${f.h}(${f.nodes.length})`).join(" ");
    ctx.fillText(`shapes:${all.length}  faces:${realFaces.length}  ${fdesc}`, 12, 24);
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
        <label className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
          <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} /> seuil adaptatif
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          {adaptive ? "seuil max" : "seuil"}
          <input type="range" min={40} max={400} step={5} value={thr} onChange={(e) => setThr(+e.target.value)} />
          <span className="w-8 font-mono">{thr}</span>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400"><input type="checkbox" checked={splitBlocks} onChange={(e) => setSplitBlocks(e.target.checked)} /> découper blocs</label>
        <label className="flex items-center gap-2 text-sm font-medium text-fuchsia-600 dark:text-fuchsia-400"><input type="checkbox" checked={imagine} onChange={(e) => setImagine(e.target.checked)} /> imaginer face complète</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} /> liens</label>
        <label className="flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-400"><input type="checkbox" checked={showWhite} onChange={(e) => setShowWhite(e.target.checked)} /> blanc</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          résolution
          <select value={res} onChange={(e) => setRes(+e.target.value)} disabled={status === "scanning"} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            <option value={360}>360</option><option value={480}>480</option><option value={560}>560</option><option value={720}>720</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <strong>V2 algo</strong> — position des faces via le <span className="font-semibold text-emerald-600 dark:text-emerald-400">graphe de liaisons</span> :
        chaque face est une composante connexe, sa rotation et son pas viennent des liens, les coordonnées <code>(gx,gy)</code> par parcours du graphe.
        <span className="font-semibold text-fuchsia-600 dark:text-fuchsia-400"> «&nbsp;imaginer face complète&nbsp;»</span> extrapole la grille 3×3 par affine et dessine en pointillés les cellules non détectées.
      </p>
    </div>
  );
}
