// Classify the colour inside a detected quad → one of the 6 Rubik colours, or
// SKIN (beige/brown = a finger, not a sticker) so the caller can drop it. Pure,
// no deps; works on a flat RGBA frame buffer.

export type CubeColour = "white" | "yellow" | "red" | "orange" | "green" | "blue" | "skin" | "unknown";

export interface Pt { x: number; y: number }

const HEX: Record<CubeColour, string> = {
  white: "#f8fafc", yellow: "#facc15", red: "#ef4444", orange: "#fb923c",
  green: "#22c55e", blue: "#3b82f6", skin: "#d8a878", unknown: "#94a3b8",
};
export const colourHex = (c: CubeColour) => HEX[c];

// median RGB over an interior grid of a quad (TL,TR,BR,BL), robust to a stray edge
export function sampleQuadRGB(q: [Pt, Pt, Pt, Pt], data: Uint8ClampedArray, W: number, H: number): [number, number, number] | null {
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
  // skin / beige / brown: warm hue, not-too-saturated, spanning shadowed→bright
  if (h >= 6 && h <= 50 && s >= 0.15 && s <= 0.62 && v >= 0.18 && v <= 0.93) return "skin";
  if (s < 0.22) return v > 0.5 ? "white" : "unknown";   // greyish, not a vivid sticker
  if (h < 12 || h >= 345) return "red";
  if (h < 42) return "orange";
  if (h < 75) return "yellow";
  if (h < 170) return "green";
  if (h < 265) return "blue";
  return "red";                                          // magenta wraps to red
}
