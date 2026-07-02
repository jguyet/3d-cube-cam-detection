"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { analyze } from "@/lib/ml/hybridAnalyze";
import { colourHex } from "@/lib/ml/stickerColor";
import { DatasetEngine, reseed, type Sample } from "@/lib/dataset/engine";

const WORK_W = 480;   // analysis resolution
const GEN_W = 480, GEN_H = 270;   // synthetic render size (engine default 16:9)

interface Item { file: string; done: boolean; faces: string; shapes: number; links: number; coherent: number; anchored: number; complete: number }

function loadImageData(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const h = Math.round(WORK_W * (img.naturalHeight / img.naturalWidth));
      const cv = document.createElement("canvas"); cv.width = WORK_W; cv.height = h;
      const c = cv.getContext("2d", { willReadFrequently: true })!;
      c.drawImage(img, 0, 0, WORK_W, h);
      resolve(c.getImageData(0, 0, WORK_W, h));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default function DatasetTester() {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [showContour, setShowContour] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [findMissing, setFindMissing] = useState(true);
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const detRef = useRef<ShapeDetector | null>(null);
  // synthetic generation
  const engineRef = useRef<DatasetEngine | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const synthRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const [synth, setSynth] = useState<{ id: number; faces: string; cells: number; gtVis: number; complete: number }[]>([]);
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    fetch("/dataset-tests/manifest.json").then((r) => r.json()).then((files: string[]) =>
      setItems(files.map((file) => ({ file, done: false, faces: "", shapes: 0, links: 0, coherent: 0, anchored: 0, complete: 0 })))
    ).catch(() => setItems([]));
  }, []);

  const runOne = useCallback(async (file: string): Promise<Partial<Item>> => {
    const det = (detRef.current ??= new ShapeDetector());
    const image = await loadImageData(`/dataset-tests/${file}`);
    const res = analyze(det, image, { findMissing });
    const canvas = canvasRefs.current[file];
    if (canvas) {
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.putImageData(image, 0, 0);
      // links
      for (const [A, B, adj] of res.links) {
        ctx.setLineDash(adj ? [] : [6, 5]); ctx.lineWidth = adj ? 2.5 : 1.8;
        ctx.strokeStyle = adj ? "rgba(0,255,120,0.9)" : "rgba(0,255,120,0.55)";
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      // grid + contour per coherent face
      for (const lat of res.lattices) {
        if (showGrid && lat.gridCoherent) {
          ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,140,0,0.7)";
          for (let u = 0; u < 4; u++) {
            ctx.beginPath(); ctx.moveTo(lat.nodes[u][0].x, lat.nodes[u][0].y); ctx.lineTo(lat.nodes[u][3].x, lat.nodes[u][3].y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(lat.nodes[0][u].x, lat.nodes[0][u].y); ctx.lineTo(lat.nodes[3][u].x, lat.nodes[3][u].y); ctx.stroke();
          }
        }
        if (showContour && lat.gridCoherent) {
          const sf = lat.surface;
          ctx.fillStyle = "rgba(255,0,200,0.10)"; ctx.beginPath();
          sf.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,0,200,0.95)"; ctx.stroke();
        }
      }
      // cells (dots)
      for (const c of res.cells) {
        ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = colourHex(c.name); ctx.fill();
        ctx.lineWidth = c.found ? 2 : 1.5; ctx.strokeStyle = c.found ? "#ffffff" : "#000"; ctx.stroke();
      }
    }
    const complete = res.lattices.filter((l) => {
      let n = 0; for (const c of res.cells) if (c.li === res.lattices.indexOf(l)) n++; return n === 9;
    }).length;
    return {
      done: true, shapes: res.shapes.length, links: res.links.length,
      faces: res.lattices.map((l) => l.count).join(",") || "—",
      coherent: res.lattices.filter((l) => l.gridCoherent).length,
      anchored: res.lattices.filter((l) => l.centerAnchored).length,
      complete,
    };
  }, [findMissing, showContour, showGrid]);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (const it of items) {
      const upd = await runOne(it.file);
      setItems((prev) => prev.map((p) => (p.file === it.file ? { ...p, ...upd } : p)));
    }
    setRunning(false);
  }, [items, runOne]);

  useEffect(() => () => { engineRef.current?.dispose(); }, []);

  const genSynthetic = useCallback(async (n: number) => {
    setGenBusy(true);
    if (!engineRef.current) {
      const gl = document.createElement("canvas");
      gl.width = GEN_W; gl.height = GEN_H;
      glCanvasRef.current = gl;
      engineRef.current = new DatasetEngine(gl, GEN_W, GEN_H);
      // backgrounds/mockup are optional — render on the plain scene for a clean test
    }
    const engine = engineRef.current, gl = glCanvasRef.current!;
    const det = (detRef.current ??= new ShapeDetector());
    const rows: typeof synth = [];
    setSynth(Array.from({ length: n }, (_, id) => ({ id, faces: "", cells: 0, gtVis: 0, complete: 0 })));
    // let React mount the canvases first
    await new Promise((r) => setTimeout(r, 30));
    for (let id = 0; id < n; id++) {
      reseed(1000 + id * 7919);
      let sample: Sample;
      try { sample = engine.randomize(); engine.render(); } catch { continue; }
      // read the rendered pixels into an ImageData
      const tmp = document.createElement("canvas"); tmp.width = GEN_W; tmp.height = GEN_H;
      const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
      tctx.drawImage(gl, 0, 0);
      const image = tctx.getImageData(0, 0, GEN_W, GEN_H);
      const res = analyze(det, image, { findMissing });
      const gtVis = sample.stickers.filter((s) => s.v === 1).length;
      const canvas = synthRefs.current[id];
      if (canvas) {
        canvas.width = GEN_W; canvas.height = GEN_H;
        const ctx = canvas.getContext("2d")!;
        ctx.putImageData(image, 0, 0);
        for (const [A, B, adj] of res.links) { ctx.setLineDash(adj ? [] : [6, 5]); ctx.lineWidth = adj ? 2.5 : 1.8; ctx.strokeStyle = adj ? "rgba(0,255,120,0.9)" : "rgba(0,255,120,0.55)"; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); }
        ctx.setLineDash([]);
        for (const lat of res.lattices) if (showContour && lat.gridCoherent) { const sf = lat.surface; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,0,200,0.95)"; ctx.beginPath(); sf.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }
        for (const c of res.cells) { ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fillStyle = colourHex(c.name); ctx.fill(); ctx.lineWidth = c.found ? 2 : 1.5; ctx.strokeStyle = c.found ? "#fff" : "#000"; ctx.stroke(); }
        // GROUND TRUTH visible sticker centres (cyan crosses) to compare
        ctx.strokeStyle = "rgba(0,220,255,0.9)"; ctx.lineWidth = 1.5;
        for (const s of sample.stickers) if (s.v === 1) { const x = s.x * GEN_W, y = s.y * GEN_H; ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke(); }
      }
      const complete = res.lattices.filter((_, i) => res.cells.filter((c) => c.li === i).length === 9).length;
      rows.push({ id, faces: res.lattices.map((l) => l.count).join(",") || "—", cells: res.cells.length, gtVis, complete });
      setSynth((prev) => prev.map((p) => (p.id === id ? rows[rows.length - 1] : p)));
      await new Promise((r) => setTimeout(r, 0));
    }
    setGenBusy(false);
  }, [findMissing, showContour]);

  // totals
  const done = items.filter((i) => i.done);
  const totFaces = done.reduce((a, i) => a + (i.coherent), 0);
  const totComplete = done.reduce((a, i) => a + i.complete, 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <button onClick={runAll} disabled={running || items.length === 0}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
          {running ? "Analyse…" : `Analyser le dataset (${items.length})`}
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={findMissing} onChange={(e) => setFindMissing(e.target.checked)} /> compléter cases manquantes</label>
        <label className="flex items-center gap-2 text-sm text-fuchsia-600 dark:text-fuchsia-400"><input type="checkbox" checked={showContour} onChange={(e) => setShowContour(e.target.checked)} /> contour</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grille 3×3</label>
        {done.length > 0 && <span className="ml-auto text-sm text-slate-500 dark:text-slate-400">faces cohérentes: <strong>{totFaces}</strong> · faces 9/9: <strong>{totComplete}</strong> · {done.length}/{items.length} images</span>}
      </div>
      {/* ---- SYNTHETIC GENERATION ---- */}
      <div className="mb-4 rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => genSynthetic(9)} disabled={genBusy}
            className="rounded-xl bg-violet-600 px-5 py-2.5 font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
            {genBusy ? "Génération…" : "Générer & tester (synthétique ×9)"}
          </button>
          <span className="text-sm text-slate-500 dark:text-slate-400">rend des cubes 3D synthétiques et lance l&apos;algo dessus · croix cyan = vérité terrain (stickers visibles)</span>
        </div>
        {synth.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {synth.map((s) => (
              <div key={s.id} className="overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
                <canvas ref={(el) => { synthRefs.current[s.id] = el; }} className="w-full bg-black" />
                <div className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                  faces <strong>[{s.faces || "…"}]</strong> · {s.cells} détectées / <strong>{s.gtVis}</strong> visibles (GT) · <span className={s.complete ? "text-emerald-600 dark:text-emerald-400" : ""}>9/9 ×{s.complete}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold">Images réelles</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <div key={it.file} className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <div className="relative bg-black">
              <canvas ref={(el) => { canvasRefs.current[it.file] = el; }} className="w-full" />
              {!it.done && <div className="absolute inset-0 grid place-items-center text-xs text-white/50">non analysé</div>}
            </div>
            <div className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
              {it.done ? (
                <span>faces <strong>[{it.faces}]</strong> · {it.shapes} shapes · {it.links} liens · cohér. {it.coherent} · ancr. {it.anchored} · <span className={it.complete ? "text-emerald-600 dark:text-emerald-400" : ""}>9/9 ×{it.complete}</span></span>
              ) : <span className="text-slate-400">{it.file}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
