"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ShapeDetector } from "@/lib/rubik-detector/core/ShapeDetector";
import { analyze, type AnalyzeResult } from "@/lib/ml/hybridAnalyze";
import { colourHex } from "@/lib/ml/stickerColor";
import { DatasetEngine, reseed, type Sample } from "@/lib/dataset/engine";

const WORK_W = 480;
const GEN_W = 480, GEN_H = 270;
const ANNO_KEY = "rubix-dataset-annos";

type Verdict = "good" | "bad" | undefined;
type Validity = "valid" | "invalid" | undefined;
interface ImageAnno { verdict?: Verdict; validity?: Validity; cells: Record<string, "ok" | "bad"> }
type Annos = Record<string, ImageAnno>;

const cellKey = (li: number, gx: number, gy: number) => `${li}:${gx}:${gy}`;

interface Entry { image: ImageData; res: AnalyzeResult; gtValid?: boolean; gtVis?: number }

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
  const [files, setFiles] = useState<string[]>([]);
  const [synthIds, setSynthIds] = useState<number[]>([]);
  const [running, setRunning] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [showContour, setShowContour] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [findMissing, setFindMissing] = useState(true);
  const [annos, setAnnos] = useState<Annos>({});
  const [, force] = useState(0);   // repaint trigger

  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const entries = useRef<Record<string, Entry>>({});
  const detRef = useRef<ShapeDetector | null>(null);
  const engineRef = useRef<DatasetEngine | null>(null);
  const glRef = useRef<HTMLCanvasElement | null>(null);
  const annosRef = useRef<Annos>({});
  annosRef.current = annos;

  useEffect(() => {
    try { const s = localStorage.getItem(ANNO_KEY); if (s) setAnnos(JSON.parse(s)); } catch { }
    fetch("/dataset-tests/manifest.json").then((r) => r.json()).then(setFiles).catch(() => setFiles([]));
  }, []);
  useEffect(() => () => { engineRef.current?.dispose(); }, []);

  const saveAnnos = useCallback((next: Annos) => { setAnnos(next); try { localStorage.setItem(ANNO_KEY, JSON.stringify(next)); } catch { } }, []);

  // draw image + algo overlay + annotation markers for one key
  const paint = useCallback((key: string) => {
    const canvas = canvasRefs.current[key], entry = entries.current[key];
    if (!canvas || !entry) return;
    const { image, res } = entry;
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);
    for (const [A, B, adj] of res.links) {
      ctx.setLineDash(adj ? [] : [6, 5]); ctx.lineWidth = adj ? 2.5 : 1.8;
      ctx.strokeStyle = adj ? "rgba(0,255,120,0.9)" : "rgba(0,255,120,0.55)";
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
    ctx.setLineDash([]);
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
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,0,200,0.95)";
        ctx.beginPath(); sf.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
      }
    }
    const cellAnno = annosRef.current[key]?.cells ?? {};
    for (const c of res.cells) {
      // always a black outer ring so white/cream dots stay visible on light cubes;
      // completed cells get a blue dashed halo so 9/9 completion is obvious.
      ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = colourHex(c.name); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
      if (c.found) { ctx.beginPath(); ctx.arc(c.x, c.y, 8.5, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = "#2563eb"; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); }
      const a = cellAnno[cellKey(c.li, c.gx, c.gy)];
      if (a) {
        ctx.lineWidth = 2.5; ctx.strokeStyle = a === "ok" ? "#22c55e" : "#ef4444";
        ctx.beginPath(); ctx.arc(c.x, c.y, 9, 0, Math.PI * 2); ctx.stroke();
        if (a === "bad") { ctx.beginPath(); ctx.moveTo(c.x - 6, c.y - 6); ctx.lineTo(c.x + 6, c.y + 6); ctx.moveTo(c.x + 6, c.y - 6); ctx.lineTo(c.x - 6, c.y + 6); ctx.stroke(); }
      }
    }
    // ground-truth crosses for synthetic
    if (entry.gtValid !== undefined && entry.gtVis !== undefined && (entries.current[key] as Entry & { gt?: { x: number; y: number }[] }).gt) {
      ctx.strokeStyle = "rgba(0,220,255,0.9)"; ctx.lineWidth = 1.5;
      for (const p of (entries.current[key] as Entry & { gt?: { x: number; y: number }[] }).gt!) {
        ctx.beginPath(); ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4); ctx.stroke();
      }
    }
  }, [showContour, showGrid]);

  // click a cell → cycle its annotation unset→ok→bad→unset
  const onCanvasClick = useCallback((key: string, e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRefs.current[key], entry = entries.current[key];
    if (!canvas || !entry) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    let best: (typeof entry.res.cells)[0] | null = null, bd = 14;
    for (const c of entry.res.cells) { const d = Math.hypot(c.x - px, c.y - py); if (d < bd) { bd = d; best = c; } }
    if (!best) return;
    const k = cellKey(best.li, best.gx, best.gy);
    const cur = annosRef.current[key]?.cells?.[k];
    const nextVal = cur === undefined ? "ok" : cur === "ok" ? "bad" : undefined;
    const prev = annosRef.current[key] ?? { cells: {} };
    const cells = { ...prev.cells };
    if (nextVal) cells[k] = nextVal; else delete cells[k];
    saveAnnos({ ...annosRef.current, [key]: { ...prev, cells } });
    requestAnimationFrame(() => paint(key));
  }, [paint, saveAnnos]);

  const setVerdict = (key: string, v: Verdict) => { const p = annosRef.current[key] ?? { cells: {} }; saveAnnos({ ...annosRef.current, [key]: { ...p, verdict: p.verdict === v ? undefined : v } }); };
  const setValidity = (key: string, v: Validity) => { const p = annosRef.current[key] ?? { cells: {} }; saveAnnos({ ...annosRef.current, [key]: { ...p, validity: p.validity === v ? undefined : v } }); };

  const runOne = useCallback(async (file: string) => {
    const det = (detRef.current ??= new ShapeDetector());
    const image = await loadImageData(`/dataset-tests/${file}`);
    entries.current[file] = { image, res: analyze(det, image, { findMissing }) };
    paint(file);
  }, [findMissing, paint]);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (const f of files) { await runOne(f); force((n) => n + 1); await new Promise((r) => setTimeout(r, 0)); }
    setRunning(false);
  }, [files, runOne]);

  const genSynthetic = useCallback(async (n: number) => {
    setGenBusy(true);
    if (!engineRef.current) { const gl = document.createElement("canvas"); gl.width = GEN_W; gl.height = GEN_H; glRef.current = gl; engineRef.current = new DatasetEngine(gl, GEN_W, GEN_H); }
    const engine = engineRef.current!, gl = glRef.current!;
    const det = (detRef.current ??= new ShapeDetector());
    setSynthIds(Array.from({ length: n }, (_, i) => i));
    await new Promise((r) => setTimeout(r, 40));
    for (let id = 0; id < n; id++) {
      const key = `synth-${id}`;
      reseed(1000 + id * 7919);
      let sample: Sample;
      try { sample = engine.randomize(); engine.render(); } catch { continue; }
      const tmp = document.createElement("canvas"); tmp.width = GEN_W; tmp.height = GEN_H;
      const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
      tctx.drawImage(gl, 0, 0);
      const image = tctx.getImageData(0, 0, GEN_W, GEN_H);
      const res = analyze(det, image, { findMissing });
      const gt = sample.stickers.filter((s) => s.v === 1).map((s) => ({ x: s.x * GEN_W, y: s.y * GEN_H }));
      entries.current[key] = { image, res, gtValid: sample.present === 1, gtVis: gt.length } as Entry;
      (entries.current[key] as Entry & { gt?: { x: number; y: number }[] }).gt = gt;
      // auto-seed validity from ground truth (deliberately-generated negatives = invalid)
      if (!annosRef.current[key]?.validity) { const p = annosRef.current[key] ?? { cells: {} }; saveAnnos({ ...annosRef.current, [key]: { ...p, validity: sample.present === 1 ? "valid" : "invalid" } }); }
      paint(key);
      force((x) => x + 1);
      await new Promise((r) => setTimeout(r, 0));
    }
    setGenBusy(false);
  }, [findMissing, paint, saveAnnos]);

  useEffect(() => { for (const k in entries.current) paint(k); }, [showContour, showGrid, paint]);

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(annos, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "dataset-annotations.json"; a.click();
  };

  const [saveMsg, setSaveMsg] = useState<string>("");
  const saveToServer = useCallback(async () => {
    setSaveMsg("sauvegarde…");
    // capture the exact annotated overlay of every analysed card
    const images: { key: string; dataURL: string }[] = [];
    for (const k of Object.keys(entries.current)) {
      const cv = canvasRefs.current[k];
      if (cv) { try { images.push({ key: k, dataURL: cv.toDataURL("image/png") }); } catch { } }
    }
    try {
      const r = await fetch("/api/dataset-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ annotations: annosRef.current, images }) });
      const j = await r.json();
      setSaveMsg(j.ok ? `sauvé dans dataset-review/ (${j.images} images + annotations.json)` : `erreur: ${j.error}`);
    } catch (e) { setSaveMsg("erreur: " + (e instanceof Error ? e.message : String(e))); }
  }, []);

  // scoreboard
  const keys = Object.keys(annos);
  const nGood = keys.filter((k) => annos[k].verdict === "good").length;
  const nBad = keys.filter((k) => annos[k].verdict === "bad").length;
  const nCellsOk = keys.reduce((a, k) => a + Object.values(annos[k].cells).filter((v) => v === "ok").length, 0);
  const nCellsBad = keys.reduce((a, k) => a + Object.values(annos[k].cells).filter((v) => v === "bad").length, 0);

  const Card = ({ k, label, badge }: { k: string; label: string; badge?: React.ReactNode }) => {
    const a = annos[k];
    const border = a?.verdict === "good" ? "ring-emerald-400" : a?.verdict === "bad" ? "ring-red-400" : "ring-slate-200 dark:ring-slate-700";
    return (
      <div className={`overflow-hidden rounded-xl bg-white ring-2 dark:bg-slate-900 ${border}`}>
        <canvas ref={(el) => { canvasRefs.current[k] = el; if (el && entries.current[k]) paint(k); }} onClick={(e) => onCanvasClick(k, e)} className="w-full cursor-crosshair bg-black" title="clic sur une case: ok → pas ok → rien" />
        <div className="px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
            <span className="truncate">{label}</span>{badge}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button onClick={() => setVerdict(k, "good")} className={`rounded px-2 py-1 ${a?.verdict === "good" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>détection bonne</button>
            <button onClick={() => setVerdict(k, "bad")} className={`rounded px-2 py-1 ${a?.verdict === "bad" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>pas bonne</button>
            <button onClick={() => setValidity(k, "valid")} className={`rounded px-2 py-1 ${a?.validity === "valid" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>cas valide</button>
            <button onClick={() => setValidity(k, "invalid")} className={`rounded px-2 py-1 ${a?.validity === "invalid" ? "bg-amber-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>cas invalide</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <button onClick={runAll} disabled={running || files.length === 0} className="rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{running ? "Analyse…" : `Analyser réelles (${files.length})`}</button>
        <button onClick={() => genSynthetic(9)} disabled={genBusy} className="rounded-xl bg-violet-600 px-5 py-2.5 font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">{genBusy ? "Génération…" : "Générer & tester (×9)"}</button>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={findMissing} onChange={(e) => setFindMissing(e.target.checked)} /> compléter</label>
        <label className="flex items-center gap-2 text-sm text-fuchsia-600 dark:text-fuchsia-400"><input type="checkbox" checked={showContour} onChange={(e) => setShowContour(e.target.checked)} /> contour</label>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grille</label>
        <button onClick={exportJSON} className="ml-auto rounded-lg bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-100">exporter (JSON)</button>
        <button onClick={saveToServer} className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white dark:bg-slate-200 dark:text-slate-900">sauvegarder pour revue (serveur)</button>
        {saveMsg && <span className="w-full text-xs text-slate-500 dark:text-slate-400">{saveMsg}</span>}
      </div>
      <div className="mb-4 rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:ring-slate-700">
        Scores : détection <strong className="text-emerald-600 dark:text-emerald-400">{nGood} bonnes</strong> / <strong className="text-red-600 dark:text-red-400">{nBad} mauvaises</strong> · cases <strong className="text-emerald-600 dark:text-emerald-400">{nCellsOk} ok</strong> / <strong className="text-red-600 dark:text-red-400">{nCellsBad} pas ok</strong> · clic sur une case pour la noter
      </div>

      {synthIds.length > 0 && <>
        <h2 className="mb-3 text-lg font-bold">Synthétique <span className="text-sm font-normal text-slate-500">(croix cyan = vérité terrain)</span></h2>
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {synthIds.map((id) => { const k = `synth-${id}`; const e = entries.current[k]; return (
            <Card key={k} k={k} label={`synth #${id}${e ? ` · ${e.res.cells.length} détectées / ${e.gtVis} GT` : ""}`}
              badge={e ? <span className={`rounded px-1.5 py-0.5 text-[11px] ${e.gtValid ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>{e.gtValid ? "cube présent (GT)" : "négatif (GT)"}</span> : null} />
          ); })}
        </div>
      </>}

      <h2 className="mb-3 text-lg font-bold">Images réelles</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {files.map((f) => { const e = entries.current[f]; return (
          <Card key={f} k={f} label={e ? `${e.res.lattices.map((l) => l.count).join(",") || "—"} · ${e.res.cells.length} cases` : f} />
        ); })}
      </div>
    </div>
  );
}
