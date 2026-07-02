// Classify the colour inside a detected quad → one of the 6 Rubik colours, or
// SKIN (beige/brown = a finger, not a sticker) so the caller can drop it. Pure,
// no deps; works on a flat RGBA frame buffer.

export type CubeColour = "white" | "yellow" | "red" | "orange" | "green" | "blue" | "skin" | "dark" | "unknown";

export interface Pt { x: number; y: number }

const HEX: Record<CubeColour, string> = {
  white: "#f8fafc", yellow: "#facc15", red: "#ef4444", orange: "#fb923c",
  green: "#22c55e", blue: "#3b82f6", skin: "#d8a878", dark: "#1e293b", unknown: "#94a3b8",
};
export const colourHex = (c: CubeColour) => HEX[c];

// median RGB over an interior grid of a quad (TL,TR,BR,BL), robust to a stray edge
export function sampleQuadRGB(q: readonly Pt[], data: Uint8ClampedArray, W: number, H: number): [number, number, number] | null {
  if (q.length < 4) return null;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const [A, B, C, D] = q;
  for (let u = 0.25; u <= 0.8; u += 0.11) for (let v = 0.25; v <= 0.8; v += 0.11) {
    const x = Math.round((1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x);
    const y = Math.round((1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  if (rs.length < 3) return null;
  const med = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

// Classify a median RGB. SKIN is the warm, MODERATELY-saturated band that cube
// stickers avoid (they are vivid or clean white) — this is what separates fingers
// from an orange/red/yellow sticker.
export function classifyColour(rgb: [number, number, number]): CubeColour {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);   // v already in 0..1
  if (s < 0.16 && v > 0.55) return "white";
  // very dark = black / dark-brown → hair or deep shadow, never a lit sticker
  if (v < 0.25) return "dark";
  // dark-brown hair that isn't quite black: warm, low-ish sat, still fairly dark
  if (h >= 6 && h <= 45 && s <= 0.55 && v < 0.42) return "dark";
  // skin / beige: warm hue, not-too-saturated, mid→bright
  if (h >= 6 && h <= 50 && s >= 0.15 && s <= 0.62 && v >= 0.25 && v <= 0.93) return "skin";
  if (s < 0.22) return v > 0.5 ? "white" : "unknown";   // greyish, not a vivid sticker
  if (h < 12 || h >= 345) return "red";
  if (h < 42) return "orange";
  if (h < 75) return "yellow";
  if (h < 170) return "green";
  if (h < 265) return "blue";
  return "red";                                          // magenta wraps to red
}

// ---- COLOUR MEMORY: a cube always has the SAME six colours, so learn each one's
// actual appearance from confident detections and classify against THIS cube's
// palette. Nails the red↔orange split (fixed hue thresholds can't) and gets more
// certain over time. Persists to localStorage.
const CHROMATIC: CubeColour[] = ["white", "yellow", "red", "orange", "green", "blue"];
interface Ref { r: number; g: number; b: number; n: number }
// brightness-invariant chromaticity (r,g fractions) — separates red from orange
function chroma(r: number, g: number, b: number): [number, number] { const s = r + g + b + 1e-6; return [r / s, g / s]; }

export class ColourMemory {
  refs: Partial<Record<CubeColour, Ref>> = {};
  private alpha = 0.06;           // EMA rate
  private tol = 0.09;             // max chromaticity distance to trust a learned ref

  // Feed a confident sticker RGB. Skip the ambiguous red↔orange hue band and
  // low-saturation samples so the learned centroids stay clean.
  learn(rgb: [number, number, number]): void {
    const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    const c = classifyColour(rgb);
    if (c === "skin" || c === "dark" || c === "unknown") return;
    if (c !== "white" && s < 0.45) return;               // too washed out to trust
    if (c === "white" && v < 0.55) return;
    if (h >= 20 && h <= 32) return;                       // red/orange overlap → don't learn
    const cur = this.refs[c];
    if (!cur) this.refs[c] = { r: rgb[0], g: rgb[1], b: rgb[2], n: 1 };
    else { const a = this.alpha; cur.r += a * (rgb[0] - cur.r); cur.g += a * (rgb[1] - cur.g); cur.b += a * (rgb[2] - cur.b); cur.n++; }
  }

  // Classify against the learned palette; fall back to the fixed heuristic.
  classify(rgb: [number, number, number]): CubeColour {
    const fixed = classifyColour(rgb);
    if (fixed === "skin" || fixed === "dark") return fixed;   // structural — never override
    const [cr, cg] = chroma(rgb[0], rgb[1], rgb[2]);
    let best: CubeColour | null = null, bd = Infinity;
    for (const name of CHROMATIC) {
      const ref = this.refs[name];
      if (!ref || ref.n < 4) continue;
      const [rr, rg] = chroma(ref.r, ref.g, ref.b);
      const d = Math.hypot(cr - rr, cg - rg);
      if (d < bd) { bd = d; best = name; }
    }
    return best && bd < this.tol ? best : fixed;
  }

  ready(): number { return CHROMATIC.filter((c) => (this.refs[c]?.n ?? 0) >= 4).length; }

  load(key = "rubix-palette"): void {
    try { const s = typeof localStorage !== "undefined" && localStorage.getItem(key); if (s) this.refs = JSON.parse(s); } catch { /* ignore */ }
  }
  save(key = "rubix-palette"): void {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(this.refs)); } catch { /* ignore */ }
  }
}
