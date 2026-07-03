// COMPLETE test: (A) real dataset faces still reach 9/9 (no regression from the
// square gate), (B) injected out-of-cube FPs (irregular blobs / off-grid squares)
// never enter the output, (C) temporal-persistence logic unit test.
import sharp from "sharp";
import { ShapeDetector } from "../src/lib/rubik-detector/core/ShapeDetector";
import { analyze } from "../src/lib/ml/hybridAnalyze";
import { faceLatticesFromStickers } from "../src/lib/ml/cubePoseFromStickers";

const P = "public/dataset-tests", W = 640;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL " + m); } };

// ---- (A) real dataset: no regression
async function realDataset() {
  console.log("\n(A) REAL DATASET — faces reach 9/9 (square gate must not regress):");
  const det = new ShapeDetector();
  for (const f of ["IMG_20250201_214957.jpg", "IMG_20250202_105725.jpg", "IMG_20250202_105721.jpg", "IMG_20250202_105730.jpg", "IMG_20250202_105737.jpg", "IMG_20250201_214953.jpg"]) {
    const meta = await sharp(`${P}/${f}`).metadata(); const H = Math.round(W * (meta.height! / meta.width!));
    const buf = await sharp(`${P}/${f}`).resize(W, H, { kernel: "cubic" }).ensureAlpha().raw().toBuffer();
    const d = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length);
    const r = analyze(det, { width: W, height: H, data: d } as unknown as ImageData, { findMissing: true });
    const comp = r.lattices.some((_, i) => r.cells.filter((c) => c.li === i).length === 9);
    ok(comp, `${f.slice(-10)} → a face reaches 9/9 (cells ${r.cells.length})`);
  }
}

// ---- (B) out-of-cube FP rejection (grid membership + square gate)
function fpRejection() {
  console.log("\n(B) OUT-OF-CUBE FP REJECTION:");
  const sq = (cx: number, cy: number, s: number, fill = 0.9) => ({ corners: [{ x: cx - s / 2, y: cy - s / 2 }, { x: cx + s / 2, y: cy - s / 2 }, { x: cx + s / 2, y: cy + s / 2 }, { x: cx - s / 2, y: cy + s / 2 }] as [import("../src/lib/rubik-detector/types").Point2, ...import("../src/lib/rubik-detector/types").Point2[]], center: { x: cx, y: cy }, area: s * s, fill });
  // a clean 3x3 face
  const face: ReturnType<typeof sq>[] = [];
  for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) face.push(sq(80 + gx * 45, 80 + gy * 45, 34));
  // scattered off-grid FP squares far from the face (not on any 3x3)
  const fps = [sq(300, 60, 34), sq(340, 300, 34), sq(60, 320, 34)];
  const lats = faceLatticesFromStickers([...face, ...fps] as never[]);
  const totalCells = lats.reduce((a, l) => a + l.count, 0);
  ok(lats.length === 1 && lats[0].count === 9, `face + 3 scattered FPs → 1 face of 9 (got ${lats.length} face(s), ${totalCells} cells) — FPs not grouped`);
  // FPs alone (no face) → no coherent grid
  const only = faceLatticesFromStickers(fps as never[]);
  ok(only.length === 0, `3 scattered FPs alone → 0 faces (got ${only.length})`);
}

// ---- (C) temporal persistence unit (mirror of the HybridScanner logic)
function persistence() {
  console.log("\n(C) TEMPORAL PERSISTENCE — flickering FP never confirmed:");
  type T = { c: { x: number; y: number }; ttl: number; hits: number };
  let tracks: T[] = [];
  const TTL = 12;
  const step = (dets: { x: number; y: number; side: number }[]) => {
    for (const t of tracks) t.ttl--;
    for (const s of dets) {
      let best: T | null = null, bd = Infinity;
      for (const t of tracks) { const d = Math.hypot(t.c.x - s.x, t.c.y - s.y); if (d < bd) { bd = d; best = t; } }
      if (best && bd < 0.9 * s.side) { best.c = { x: s.x, y: s.y }; best.ttl = TTL; best.hits = Math.min(20, best.hits + 1); }
      else tracks.push({ c: { x: s.x, y: s.y }, ttl: TTL, hits: 1 });
    }
    tracks = tracks.filter((t) => t.ttl > 0);
    return tracks.filter((t) => t.hits >= 3).length;
  };
  // a stable real sticker at (100,100) every frame + a MOVING flicker FP that jumps
  // to a totally different spot each appearance (transient noise, never re-matches).
  let confirmedSeen = 0;
  for (let f = 0; f < 12; f++) {
    const dets = [{ x: 100, y: 100, side: 30 }];                 // stable sticker (every frame)
    dets.push({ x: 250 + f * 40, y: 250, side: 30 });            // DRIFTING noise FP (40px/frame > 0.9*side → never re-matches)
    confirmedSeen = step(dets);
  }
  ok(confirmedSeen === 1, `drifting noise FP never confirmed → only the stable sticker (got ${confirmedSeen})`);
}

async function main() {
  await realDataset();
  fpRejection();
  persistence();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.log("ERR", e.message); process.exitCode = 1; });
