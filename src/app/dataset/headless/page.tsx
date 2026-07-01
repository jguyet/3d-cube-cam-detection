"use client";

// Headless dataset generation endpoint. Driven by training/gen_headless.mjs via
// a headless Chrome: it loads the real backgrounds, sets up the WebGL engine and
// exposes window.__cube.genBatch(n) → [{png(dataURL), label}]. Dev-only helper.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { DatasetEngine, reseed, type BgItem } from "@/lib/dataset/engine";

const RENDER_W = 480, RENDER_H = 270;   // 16:9, matches DatasetEngine default

function bboxFromName(name: string): BgItem["bbox"] {
  const m = name.match(/__([\d.]+)_([\d.]+)_([\d.]+)_([\d.]+)\.jpe?g$/i);
  return m ? { cx: +m[1], cy: +m[2], w: +m[3], h: +m[4] } : undefined;
}

export default function HeadlessGen() {
  const ran = useRef(false);
  const [msg, setMsg] = useState("init…");

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const p = new URLSearchParams(window.location.search);
    const bgCap = Math.max(0, parseInt(p.get("bg") || "500", 10));
    const seed = parseInt(p.get("seed") || "1", 10) || 1;

    const canvas = document.createElement("canvas");
    canvas.width = RENDER_W; canvas.height = RENDER_H;
    const engine = new DatasetEngine(canvas, RENDER_W, RENDER_H);
    reseed(seed);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = window as any;
    W.__cube = {
      ready: false,
      error: null as string | null,
      bgCount: 0,
      genBatch(n: number) {
        const out: { png: string; label: unknown }[] = [];
        for (let i = 0; i < n; i++) {
          const label = engine.randomize();
          engine.render();
          out.push({ png: canvas.toDataURL("image/png"), label });
        }
        return out;
      },
    };

    (async () => {
      try {
        const res = await fetch("/backgrounds/manifest.json");
        let files: string[] = res.ok ? await res.json() : [];
        // shuffle (seeded) + cap to keep GPU memory sane in headless
        let s = seed >>> 0 || 1;
        const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
        files = files.slice().sort(() => rnd() - 0.5);
        if (bgCap) files = files.slice(0, bgCap);

        const loader = new THREE.TextureLoader();
        const items: BgItem[] = [];
        for (let i = 0; i < files.length; i++) {
          const name = files[i];
          try {
            const tex = await new Promise<THREE.Texture>((ok, no) =>
              loader.load(`/backgrounds/${name}`, ok, undefined, no));
            tex.colorSpace = THREE.SRGBColorSpace;
            items.push({ tex, bbox: bboxFromName(name) });
          } catch { /* skip */ }
          if (i % 50 === 0) setMsg(`loading backgrounds ${i}/${files.length}`);
        }
        if (items.length) engine.setBackgrounds(items);
        W.__cube.bgCount = items.length;
        W.__cube.ready = true;
        setMsg(`ready — ${items.length} backgrounds`);
      } catch (e) {
        W.__cube.error = e instanceof Error ? e.message : String(e);
        W.__cube.ready = true; // unblock driver; it can decide
        setMsg("error: " + W.__cube.error);
      }
    })();

    return () => engine.dispose();
  }, []);

  return <pre style={{ padding: 16, fontFamily: "monospace" }}>headless dataset generator — {msg}</pre>;
}
