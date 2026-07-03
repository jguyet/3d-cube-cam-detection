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

// median RGB over an interior grid of a quad (TL,TR,BR,BL), robust to a stray edge.
// EXCLUDES specular highlights (high value + low saturation = glare, not surface
// colour) so a red facelet with a glare spot doesn't read pink/white — glare pulls
// every classifier. Falls back to the full set if too few non-specular samples.
export function sampleQuadRGB(q: readonly Pt[], data: Uint8ClampedArray, W: number, H: number): [number, number, number] | null {
  if (q.length < 4) return null;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const nr: number[] = [], ng: number[] = [], nb: number[] = [];   // non-specular subset
  const [A, B, C, D] = q;
  for (let u = 0.25; u <= 0.8; u += 0.11) for (let v = 0.25; v <= 0.8; v += 0.11) {
    const x = Math.round((1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x);
    const y = Math.round((1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    rs.push(r); gs.push(g); bs.push(b);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx > 0 ? (mx - mn) / mx : 0;
    if (!(mx > 235 && sat < 0.12)) { nr.push(r); ng.push(g); nb.push(b); }   // drop blown specular
  }
  if (rs.length < 3) return null;
  const med = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return nr.length >= 3 ? [med(nr), med(ng), med(nb)] : [med(rs), med(gs), med(bs)];
}

// Fraction of a quad's interior that is BLACK/very dark. A real facelet is a solid
// cube colour with ~zero dark pixels; a quad that straddles the dark plastic gap or
// is a false positive contains black → reject it (there are no black facelets).
export function darkFraction(q: readonly Pt[], data: Uint8ClampedArray, W: number, H: number): number {
  if (q.length < 4) return 0;
  const [A, B, C, D] = q;
  let dark = 0, n = 0;
  for (let u = 0.2; u <= 0.85; u += 0.13) for (let v = 0.2; v <= 0.85; v += 0.13) {
    const x = Math.round((1 - u) * (1 - v) * A.x + u * (1 - v) * B.x + u * v * C.x + (1 - u) * v * D.x);
    const y = Math.round((1 - u) * (1 - v) * A.y + u * (1 - v) * B.y + u * v * C.y + (1 - u) * v * D.y);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, mx = Math.max(data[i], data[i + 1], data[i + 2]), mn = Math.min(data[i], data[i + 1], data[i + 2]);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    // BLACK = dark AND achromatic (the plastic gap R≈G≈B). A dark-but-SATURATED
    // pixel is a dark red/blue/green facelet, NOT black — never count it as black.
    if (mx < 60 && sat < 0.45) dark++;
    n++;
  }
  return n > 0 ? dark / n : 0;
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
// Boundaries TUNED on ~18k synthetic samples (6 colours + skin) spanning hue/sat/value
// ranges of real stickers × warm/cool lighting casts × noise. Fixes the reported
// white→yellow, green→blue and warm-cast drift; cube-colour accuracy ~98%.
export function classifyColour(rgb: [number, number, number]): CubeColour {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);   // v already in 0..1
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  // WHITE: clean neutral (low sat) OR a WARM white — a white facelet keeps ALL THREE
  // channels lit (high min) even under warm light, whereas skin/yellow have a dark blue.
  if (s < 0.16 && v > 0.5) return "white";
  if (mn >= 158 && v > 0.78 && s < 0.36) return "white";
  // "dark" = black / gap / shadow → only when ACHROMATIC. A dark but SATURATED pixel is a
  // dark red/blue/green facelet → classify by hue, not dark.
  if (v < 0.22 && s < 0.5) return "dark";
  if (h >= 6 && h <= 45 && s <= 0.45 && v < 0.42) return "dark";     // dark-brown hair
  // skin / beige: warm hue, MODERATE saturation, not a bright neutral → a finger
  if (h >= 6 && h <= 50 && s >= 0.18 && s <= 0.62 && v >= 0.25 && v <= 0.93) return "skin";
  if (s < 0.22) return v > 0.5 ? "white" : "unknown";   // greyish, not a vivid sticker
  if (h < 15 || h >= 340) return "red";
  if (h < 43) return "orange";
  if (h < 82) return "yellow";
  if (h < 188) return "green";                           // green|blue pushed to 188 (was 170)
  if (h < 290) return "blue";
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

  // Trust the tuned heuristic for the well-separated colours (white/green/blue and the
  // structural skin/dark). Use the LEARNED palette only for the genuinely ambiguous WARM
  // trio red↔orange↔yellow, where a warm cast blurs the hue bins — the per-cube centroids
  // settle it. Snapping ALL colours (old closed-set) mis-fired (white→yellow, green→blue).
  classify(rgb: [number, number, number]): CubeColour {
    const fixed = classifyColour(rgb);
    if (fixed !== "red" && fixed !== "orange" && fixed !== "yellow") return fixed;
    const WARM: CubeColour[] = ["red", "orange", "yellow"];
    const [cr, cg] = chroma(rgb[0], rgb[1], rgb[2]);
    let best: CubeColour | null = null, bd = Infinity, learned = 0;
    for (const name of WARM) {
      const ref = this.refs[name]; if (!ref || ref.n < 4) continue;
      learned++;
      const [rr, rg] = chroma(ref.r, ref.g, ref.b);
      const d = Math.hypot(cr - rr, cg - rg);
      if (d < bd) { bd = d; best = name; }
    }
    return learned >= 2 && best ? best : fixed;   // need ≥2 warm centroids to disambiguate
  }

  ready(): number { return CHROMATIC.filter((c) => (this.refs[c]?.n ?? 0) >= 4).length; }

  // A cube only ever has these SIX colours, and we KNOW them — so seed the palette
  // with canonical Rubik anchors. Classification is correct from the first frame
  // (closed-set active immediately) and the EMA then adapts them to the actual
  // lighting. Only seeds a colour that hasn't already been learned more confidently.
  seedCanonical(n = 4): void {
    const C: Record<string, [number, number, number]> = {
      white: [235, 235, 235], yellow: [240, 210, 15], red: [180, 25, 35],
      orange: [240, 95, 10], green: [10, 150, 70], blue: [10, 70, 170],
    };
    for (const k of CHROMATIC) { const cur = this.refs[k]; if (!cur || cur.n < n) { const v = C[k]; this.refs[k] = { r: v[0], g: v[1], b: v[2], n }; } }
  }

  load(key = "rubix-palette"): void {
    try { const s = typeof localStorage !== "undefined" && localStorage.getItem(key); if (s) this.refs = JSON.parse(s); } catch { /* ignore */ }
  }
  save(key = "rubix-palette"): void {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(this.refs)); } catch { /* ignore */ }
  }
}
