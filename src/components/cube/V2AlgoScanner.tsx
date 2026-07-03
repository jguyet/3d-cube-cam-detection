"use client";

import { useEffect, useRef, useState } from "react";
import { CameraStream, FrameGrabber } from "@/lib/rubik-detector";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { colourHex, ColourMemory, darkFraction } from "@/lib/ml/stickerColor";
import { graphFaces, detectCubeFaces, dedupeShapes, keepDominantCluster } from "@/lib/ml/shapeGraph";
import { FaceTracker } from "@/lib/ml/faceTrack";
import { CubeSim } from "@/lib/ml/cubeSim";
import { cubeOrientation, type FaceObs } from "@/lib/ml/facePose";
import type { CubeColour } from "@/lib/ml/stickerColor";

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
  const memRef = useRef<ColourMemory | null>(null);
  const trackRef = useRef<FaceTracker | null>(null);
  const cubeCanvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<CubeSim | null>(null);
  const activeRef = useRef(false);      // presence hysteresis state
  const presMissRef = useRef(0);
  const rafRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cubeInfo, setCubeInfo] = useState<{ pct: number; status: "valid" | "invalid" | "partial"; msg: string }>({ pct: 0, status: "partial", msg: "" });
  const frameRef = useRef(0);

  const [thr, setThr] = useState(72);
  const [adaptive, setAdaptive] = useState(true);
  const [showWhite, setShowWhite] = useState(true);
  const [splitBlocks, setSplitBlocks] = useState(true);
  const [imagine, setImagine] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [stabilise, setStabilise] = useState(true);
  const [res, setRes] = useState(560);
  const r = useRef({ thr, adaptive, showWhite, splitBlocks, imagine, showLinks, stabilise });
  r.current = { thr, adaptive, showWhite, splitBlocks, imagine, showLinks, stabilise };

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cameraRef.current?.stop(); }, []);

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

    const mem = memRef.current!;
    const region = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    // COLOUR-AWARE discovery: colour boundaries split touching facelets, each shape is
    // tagged with its colour, black regions are rejected at the source.
    let shapes = det.detect(image, o.thr, region, o.adaptive, { colour: true, mem, aspectMax: 5 });
    let whites = o.showWhite ? det.detectWhite(image, region, false) : [];
    if (o.splitBlocks) { shapes = det.splitMerged(shapes, image); whites = det.splitMerged(whites, image); }
    // FINAL BLACK FILTER: splitMerged / detectWhite sub-cells are created AFTER the
    // discovery-time black rejection, so re-check here — a cell whose interior is >20%
    // black is a gap/shadow, never a facelet. Nothing black survives to the graph.
    const notBlack = (s: { corners: { x: number; y: number }[] }) => darkFraction(s.corners, image.data, W, H) <= 0.2;
    shapes = shapes.filter(notBlack); whites = whites.filter(notBlack);
    // DEDUPE overlapping shapes (detect/detectWhite/split overlap) so the pitch estimate
    // and grid stay correct.
    const all = dedupeShapes([...shapes, ...whites]);

    // ---- graph links (raw structure) ----
    if (o.showLinks) {
      const { edges } = graphFaces(all);
      ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.22)";
      for (const [i, j] of edges) {
        const a = all[i].center, b = all[j].center;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    // ---- DETECT FACES: each face is a full 3×3 (9 cells), detected + completed ----
    // Self-localisation (no ML): keep only the dominant cluster of adjacent faces → the
    // cube; isolated background faces are dropped. Free background rejection, no model.
    const faces = keepDominantCluster(detectCubeFaces(all, { image, mem }));

    // ---- PRESENCE (no ML): confidence = the best face's number of DETECTED, cube-coloured
    // cells. A real face scores 6-9; background clutter almost never clears 5. Schmitt
    // hysteresis (on ≥5, off after several <3 frames) so it can't blink.
    const CUBE = new Set(["white", "yellow", "red", "orange", "green", "blue"]);
    const conf = faces.reduce((m, f) => Math.max(m, f.cells.filter((c) => c.detected && CUBE.has(c.colour)).length), 0);
    if (!activeRef.current) {
      if (conf >= 5) { activeRef.current = true; presMissRef.current = 0; }
      else {
        trackRef.current!.update(null);
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(6, 6, 190, 26);
        ctx.fillStyle = "#fca5a5"; ctx.font = "14px monospace"; ctx.fillText(`aucun cube (${conf}/9)`, 12, 24);
        return;
      }
    } else if (conf < 3) {
      if (++presMissRef.current >= 5) { activeRef.current = false; presMissRef.current = 0; trackRef.current!.update(null);
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(6, 6, 190, 26); ctx.fillStyle = "#fca5a5"; ctx.font = "14px monospace"; ctx.fillText("aucun cube", 12, 24); return; }
    } else presMissRef.current = 0;

    // ---- feed the 3D SIM: colour each scanned face (indexed by centre) + gyroscope ----
    const sim = simRef.current;
    if (sim && faces.length) {
      const cell = (f: typeof faces[0], gx: number, gy: number) => f.cells.find((c) => c.gx === gx && c.gy === gy);
      // GYROSCOPE from ALL visible faces — each face's CENTRE colour anchors its absolute
      // cube-space frame, so seeing two faces mid-rotation over-determines (not confuses)
      // the orientation. Weight each by its detected-cell count so the 50/50 transition
      // blends smoothly between the two known faces.
      const obs: FaceObs[] = [];
      for (const f of faces) {
        const m = cell(f, 1, 1); if (!m || !CUBE.has(m.colour)) continue;
        const cells9: CubeColour[] = [];
        for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) cells9.push((cell(f, gx, gy)?.colour ?? "unknown") as CubeColour);
        sim.setFace(m.colour as CubeColour, cells9);
        const a = cell(f, 0, 0), b = cell(f, 2, 0), c = cell(f, 0, 2);
        if (a && b && c) obs.push({ colour: m.colour, c00: a.center, c20: b.center, c02: c.center, weight: f.count });
      }
      const q = cubeOrientation(obs);
      if (q) sim.setOrientation(q);
      // completion % + Rubik-law validity (throttled to avoid re-render churn)
      if ((frameRef.current++ & 7) === 0) { const v = sim.validity(); setCubeInfo({ pct: Math.round(sim.completion() * 100), status: v.status, msg: v.msg }); }
    }

    // TEMPORAL STABILISATION of the dominant face (anti-shift): feed it to the tracker
    // and draw the smoothed, colour-voted, label-stable slots instead of the raw cells.
    const centres: { colour: string; frame: string }[] = [];   // each face's CENTRE cell colour
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
      const slots = trackRef.current!.update(faces[0] ?? null);
      const col = FACE_COL[0];
      for (const s of slots) drawCell(s.corners, { x: s.cx, y: s.cy }, trackRef.current!.colourOf(s), s.detected, `${s.gx}${s.gy}`, col);
      const mid = slots.find((s) => s.gx === 1 && s.gy === 1);
      if (mid) centres.push({ colour: trackRef.current!.colourOf(mid), frame: col });
      // draw any secondary faces raw (rare) so multi-face still shows
      let fi = 1;
      for (const face of faces.slice(1)) { const c = FACE_COL[fi++ % FACE_COL.length]; for (const cell of face.cells) drawCell(cell.corners, cell.center, cell.colour, cell.detected, `${cell.gx}${cell.gy}`, c); const m = face.cells.find((cl) => cl.gx === 1 && cl.gy === 1); if (m) centres.push({ colour: m.colour, frame: c }); }
    } else {
      trackRef.current!.reset();
      let fi = 0;
      for (const face of faces) { const col = FACE_COL[fi++ % FACE_COL.length]; for (const cell of face.cells) drawCell(cell.corners, cell.center, cell.colour, cell.detected, `${cell.gx}${cell.gy}`, col); const m = face.cells.find((cl) => cl.gx === 1 && cl.gy === 1); if (m) centres.push({ colour: m.colour, frame: col }); }
    }

    // ---- CENTRE-CELL ZONE: the fixed centre sticker of each face (its identity) ----
    if (centres.length) {
      const sw = 34, pad = 6, x0 = W - (centres.length * (sw + pad) + pad), y0 = 8;
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(x0 - pad, y0 - pad, centres.length * (sw + pad) + pad * 2, sw + pad * 2 + 14);
      ctx.fillStyle = "#e5e7eb"; ctx.font = "10px monospace"; ctx.fillText("centres", x0, y0 - pad + 10);
      centres.forEach((c, i) => {
        const cx = x0 + i * (sw + pad), cy = y0 + 12;
        ctx.fillStyle = c.colour !== "unknown" ? colourHex(c.colour as never) : "#334155";
        ctx.fillRect(cx, cy, sw, sw);
        ctx.lineWidth = 3; ctx.strokeStyle = c.frame; ctx.strokeRect(cx, cy, sw, sw);
      });
    }

    // centre dots
    ctx.fillStyle = "#fff";
    for (const s of all) { ctx.beginPath(); ctx.arc(s.center.x, s.center.y, 2.5, 0, Math.PI * 2); ctx.fill(); }

    ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(6, 6, 380, 26);
    ctx.fillStyle = "#a7f3d0"; ctx.font = "14px monospace";
    const fdesc = faces.map((f) => `9(${f.count}vus)`).join(" ");
    ctx.fillText(`shapes:${all.length}  faces:${faces.length}  ${fdesc}`, 12, 24);
  };

  const start = async () => {
    setError(null); setStatus("loading");
    try {
      detRef.current = new ShapeDetector();
      memRef.current = new ColourMemory(); memRef.current.load(); memRef.current.seedCanonical();
      trackRef.current = new FaceTracker();
      if (cubeCanvasRef.current) { simRef.current = new CubeSim(cubeCanvasRef.current); simRef.current.resize(cubeCanvasRef.current.clientWidth || 320, cubeCanvasRef.current.clientHeight || 320); }
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
  const stop = () => { cancelAnimationFrame(rafRef.current); memRef.current?.save(); simRef.current?.dispose(); simRef.current = null; cameraRef.current?.stop(); cameraRef.current = null; setStatus("idle"); };

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
          <video ref={videoRef} playsInline muted className="hidden" />
          <canvas ref={canvasRef} className="h-full w-full object-contain" />
          {status !== "scanning" && (
            <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
              {status === "loading" ? "Chargement…" : "Caméra éteinte"}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 to-slate-800 ring-1 ring-white/10">
            <canvas ref={cubeCanvasRef} className="h-full w-full" />
            <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/40 px-2 py-0.5 text-[11px] font-medium text-white/80">cube 3D — gyroscope</span>
          </div>
          <div className="rounded-lg bg-slate-100 p-2.5 dark:bg-slate-800">
            <div className="flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>complétion</span><span className="font-mono">{cubeInfo.pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-300 dark:bg-slate-700">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${cubeInfo.pct}%` }} />
            </div>
            <div className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${cubeInfo.status === "invalid" ? "text-red-600 dark:text-red-400" : cubeInfo.status === "valid" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"}`}>
              <span>{cubeInfo.status === "invalid" ? "✗" : cubeInfo.status === "valid" ? "✓" : "…"}</span>
              <span>lois Rubik : {cubeInfo.status === "invalid" ? cubeInfo.msg : cubeInfo.status === "valid" ? "valide" : `en cours — ${cubeInfo.msg}`}</span>
            </div>
          </div>
        </div>
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
        <label className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400"><input type="checkbox" checked={stabilise} onChange={(e) => setStabilise(e.target.checked)} /> stabiliser (anti-shift)</label>
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
