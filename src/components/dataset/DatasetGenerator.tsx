"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { DatasetEngine, reseed, type Sample, type BgItem } from "@/lib/dataset/engine";

const RENDER_W = 480, RENDER_H = 270;    // rendered/exported image size (16:9)
const DISPLAY_W = 480, DISPLAY_H = 270;  // on-screen preview size

// parse "..__cx_cy_w_h.jpg" → the original cube bbox (so we place the cube on it)
function bboxFromName(name: string): BgItem["bbox"] {
  const m = name.match(/__([\d.]+)_([\d.]+)_([\d.]+)_([\d.]+)\.jpe?g$/i);
  return m ? { cx: +m[1], cy: +m[2], w: +m[3], h: +m[4] } : undefined;
}

export default function DatasetGenerator() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DatasetEngine | null>(null);

  const [ready, setReady] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [bgCount, setBgCount] = useState(0);
  const [count, setCount] = useState(2000);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!glRef.current) return;
    const engine = new DatasetEngine(glRef.current, RENDER_W, RENDER_H);
    engineRef.current = engine;
    reseed(Date.now());
    setReady(true);
    regen();
    autoLoadBackgrounds();
    // load the realistic t-shirt torso + studio HDR, then re-render a sample
    engine.loadMockup(["/mockup/models/men-tishirt.glb"], "/mockup/hdr/blocky_photo_studio_1k.hdr")
      .then(() => regen()).catch(() => {});
    return () => engine.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto-load the bundled real backgrounds (public/backgrounds/manifest.json)
  const autoLoadBackgrounds = async () => {
    try {
      const res = await fetch("/backgrounds/manifest.json");
      if (!res.ok) return;
      const files: string[] = await res.json();
      const loader = new THREE.TextureLoader();
      const items: BgItem[] = [];
      for (const name of files) {
        try {
          const tex = await new Promise<THREE.Texture>((ok, no) => loader.load(`/backgrounds/${name}`, ok, undefined, no));
          tex.colorSpace = THREE.SRGBColorSpace;
          items.push({ tex, bbox: bboxFromName(name) });
        } catch { /* skip */ }
      }
      if (items.length && engineRef.current) {
        engineRef.current.setBackgrounds(items);
        setBgCount(items.length);
        regen();
      }
    } catch { /* no manifest */ }
  };

  const drawOverlay = (s: Sample) => {
    const cv = overlayRef.current;
    if (!cv) return;
    cv.width = DISPLAY_W; cv.height = DISPLAY_H;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);
    // corners
    s.corners.forEach((c, i) => {
      const x = c.x * DISPLAY_W, y = c.y * DISPLAY_H;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = c.v ? "rgba(0,255,120,0.95)" : "rgba(255,60,60,0.85)";
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#000"; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px ui-monospace";
      ctx.fillText(String(i), x + 6, y - 6);
    });
    // edges between visible corners that share a cube edge (i,j differ in 1 bit)
    ctx.strokeStyle = "rgba(0,255,120,0.5)"; ctx.lineWidth = 1.5;
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
      const diff = (a ^ b); if (diff !== 1 && diff !== 2 && diff !== 4) continue;
      if (!s.corners[a].v || !s.corners[b].v) continue;
      ctx.beginPath();
      ctx.moveTo(s.corners[a].x * DISPLAY_W, s.corners[a].y * DISPLAY_H);
      ctx.lineTo(s.corners[b].x * DISPLAY_W, s.corners[b].y * DISPLAY_H);
      ctx.stroke();
    }
  };

  const regen = () => {
    const engine = engineRef.current; if (!engine) return;
    const s = engine.randomize();
    engine.render();
    setSample(s);
    drawOverlay(s);
  };

  const loadBackgrounds = async (files: FileList | null) => {
    if (!files || !engineRef.current) return;
    const loader = new THREE.TextureLoader();
    const items: BgItem[] = [];
    for (const f of Array.from(files)) {
      const url = URL.createObjectURL(f);
      const tex = await new Promise<THREE.Texture>((res, rej) => loader.load(url, res, undefined, rej));
      tex.colorSpace = THREE.SRGBColorSpace;
      items.push({ tex, bbox: bboxFromName(f.name) }); // bbox if encoded, else random placement
    }
    engineRef.current.setBackgrounds(items);
    setBgCount(items.length);
    regen();
  };

  const exportBatch = async () => {
    const engine = engineRef.current; if (!engine) return;
    setProgress(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picker = (window as any).showDirectoryPicker;
    try {
      if (picker) {
        const dir = await picker.call(window);
        const labels = await dir.getFileHandle("labels.jsonl", { create: true });
        const lw = await labels.createWritable();
        for (let i = 0; i < count; i++) {
          const s = engine.randomize(); engine.render();
          const blob = await engine.toBlob();
          const name = `cube_${String(i).padStart(5, "0")}.png`;
          const fh = await dir.getFileHandle(name, { create: true });
          const fw = await fh.createWritable(); await fw.write(blob!); await fw.close();
          await lw.write(JSON.stringify({ file: name, ...s }) + "\n");
          setProgress(i + 1);
          if (i % 25 === 0) await new Promise((r) => requestAnimationFrame(r));
        }
        await lw.close();
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        const lines: string[] = [];
        for (let i = 0; i < count; i++) {
          const s = engine.randomize(); engine.render();
          const blob = await engine.toBlob();
          const name = `cube_${String(i).padStart(5, "0")}.png`;
          zip.file(name, blob!);
          lines.push(JSON.stringify({ file: name, ...s }));
          setProgress(i + 1);
          if (i % 25 === 0) await new Promise((r) => requestAnimationFrame(r));
        }
        zip.file("labels.jsonl", lines.join("\n"));
        const content = await zip.generateAsync({ type: "blob" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(content); a.download = "cube-dataset.zip"; a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      console.error(e);
    }
    setProgress(null);
    regen();
  };

  const visibleCorners = sample ? sample.corners.filter((c) => c.v).length : 0;
  const visibleFaces = sample ? sample.faces.filter((f) => f).length : 0;

  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <div>
          <div className="relative" style={{ width: DISPLAY_W, height: DISPLAY_H }}>
            <canvas ref={glRef} width={RENDER_W} height={RENDER_H} style={{ width: DISPLAY_W, height: DISPLAY_H }} className="rounded-xl ring-1 ring-white/10" />
            <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" style={{ width: DISPLAY_W, height: DISPLAY_H }} />
          </div>
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            {sample ? `${visibleCorners}/8 coins visibles · ${visibleFaces} faces · ${sample.scheme}-gap` : "…"}
          </p>
        </div>

        <div className="space-y-4 text-sm">
          <p className="text-slate-600 dark:text-slate-400">
            Aperçu d&apos;un échantillon synthétique avec ses <strong>labels</strong> : 8 coins du cube
            (vert = visible, rouge = caché/hors-cadre) + faces visibles. Pose, lumières, fond, schéma
            (black/white/no-gap) et <strong>mains</strong> sont randomisés à chaque tirage.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={regen} disabled={!ready} className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
              Régénérer un échantillon
            </button>
            <label className="cursor-pointer rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
              Charger des fonds ({bgCount})
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => loadBackgrounds(e.target.files)} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-slate-600 dark:text-slate-400">Taille du dataset :</label>
            <input type="number" min={10} max={100000} value={count} onChange={(e) => setCount(Math.max(1, +e.target.value | 0))}
              className="w-28 rounded-lg border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800" />
            <button onClick={exportBatch} disabled={!ready || progress !== null} className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50">
              {progress !== null ? `Génération… ${progress}/${count}` : "Générer + exporter"}
            </button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Export : choisis un dossier (Chrome/Edge) → écrit <code>cube_XXXXX.png</code> + <code>labels.jsonl</code>
            (1 JSON par image : <code>{`{file, corners:[{x,y,v}]×8, faces:[v]×6, scheme}`}</code>). Coords normalisées 0-1.
            Charge tes fonds (maison/bureaux) pour combler l&apos;écart sim→réel. Image {RENDER_W}×{RENDER_H}.
          </p>
        </div>
      </div>
    </div>
  );
}
