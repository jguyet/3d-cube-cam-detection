import sharp from "sharp";
const OUT = "/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SRC = "/Users/jeremyguyet/Desktop/cube";
const W = 360;
type P = { x: number; y: number };
const centroid = (p: P[]) => { let x = 0, y = 0; for (const q of p) { x += q.x; y += q.y; } return { x: x / p.length, y: y / p.length }; };
function convexHull(points: P[]): P[] { if (points.length < 3) return points.slice(); const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y)); const cr = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); const lo: P[] = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); } const up: P[] = []; for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); } lo.pop(); up.pop(); return lo.concat(up); }
function pointInPoly(px: number, py: number, poly: P[]): boolean { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
function polygonArea(pts: P[]) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; }
function dilate(m: Uint8Array, w: number, h: number, it: number) { for (let k = 0; k < it; k++) { const o = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (m[i] || m[i - 1] || m[i + 1] || m[i - w] || m[i + w] || m[i - w - 1] || m[i - w + 1] || m[i + w - 1] || m[i + w + 1]) o[i] = 1; } m = o; } return m; }
function erode(m: Uint8Array, w: number, h: number, it: number) { for (let k = 0; k < it; k++) { const o = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] && m[i - w - 1] && m[i - w + 1] && m[i + w - 1] && m[i + w + 1]) o[i] = 1; } m = o; } return m; }
function largest(m: Uint8Array, w: number, h: number): P[] | null { const vis = new Uint8Array(w * h); const st: number[] = []; let best: P[] | null = null, bn = 0; for (let s = 0; s < w * h; s++) { if (!m[s] || vis[s]) continue; vis[s] = 1; st.length = 0; st.push(s); const pts: P[] = []; while (st.length) { const n = st.pop()!; const nx = n % w, ny = (n / w) | 0; pts.push({ x: nx, y: ny }); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const mx = nx + dx, my = ny + dy; if (mx < 0 || my < 0 || mx >= w || my >= h) continue; const mm = my * w + mx; if (m[mm] && !vis[mm]) { vis[mm] = 1; st.push(mm); } } } if (pts.length > bn) { bn = pts.length; best = pts; } } return best; }
function isSkin(r: number, g: number, b: number) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn; const s = mx === 0 ? 0 : dl / mx; const v = mx / 255; let h = 0; if (dl) { if (mx === r) h = ((g - b) / dl) % 6; else if (mx === g) h = (b - r) / dl + 2; else h = (r - g) / dl + 4; h *= 60; if (h < 0) h += 360; } const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b; const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b; const y = 0.299 * r + 0.587 * g + 0.114 * b; const warmRgb = r >= g * 0.9 && g >= b * 0.88 && r - b >= 18; const warmHue = (h <= 48 || h >= 350) && s >= 0.12 && s <= 0.58 && v >= 0.28; const skinYcc = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 183 && y >= 55; return (warmRgb && warmHue) || (skinYcc && s <= 0.62 && r > b); }

async function load(path: string) { const meta = await sharp(path).metadata(); const H = Math.round(W * (meta.height as number) / (meta.width as number)); const { data } = await sharp(path).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: W, h: H }; }

async function main() {
for (const folder of ["black-gap", "no-gap", "white-gap"]) {
  for (const n of ["1", "2", "3"]) {
    const path = `${SRC}/${folder}/${n}.png`;
    const { data, w, h } = await load(path);
    const color = new Uint8Array(w * h), white = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
      const s = mx === 0 ? 0 : dl / mx, v = mx / 255;
      if (isSkin(r, g, b)) continue;
      if (s > 0.5 && v > 0.25) { color[j] = 1; continue; }
      // neutral bright = white sticker candidate
      if (dl <= 80 && v >= 0.5 && mn >= 95) white[j] = 1;
    }
    // dominant coloured cluster = cube anchor (background is never saturated)
    const colorDil = dilate(color, w, h, 7);
    const colorBlob = largest(colorDil, w, h);
    if (!colorBlob || colorBlob.length < w * h * 0.004) { console.log(`${folder}/${n}: NO COLOUR SEED`); continue; }
    const cHull = convexHull(colorBlob);
    // "near the coloured cube" = filled coloured hull, expanded. White inside
    // this band and bounded (not bleeding to the frame border) = a cube face.
    let bbx0 = w, bby0 = h, bbx1 = 0, bby1 = 0; for (const p of cHull) { bbx0 = Math.min(bbx0, p.x); bby0 = Math.min(bby0, p.y); bbx1 = Math.max(bbx1, p.x); bby1 = Math.max(bby1, p.y); }
    const hullMask = new Uint8Array(w * h);
    for (let y = Math.max(0, bby0 | 0); y <= Math.min(h - 1, bby1 | 0); y++) for (let x = Math.max(0, bbx0 | 0); x <= Math.min(w - 1, bbx1 | 0); x++) if (pointInPoly(x, y, cHull)) hullMask[y * w + x] = 1;
    const nearHull = dilate(hullMask, w, h, 20);
    const mask = new Uint8Array(w * h); for (let i = 0; i < color.length; i++) if (color[i]) mask[i] = 1;
    const vis = new Uint8Array(w * h), st: number[] = [];
    const maxFace = w * h * 0.22;
    for (let s = 0; s < w * h; s++) {
      if (!white[s] || vis[s]) continue;
      vis[s] = 1; st.length = 0; st.push(s); const comp: number[] = []; let inNear = 0, border = 0;
      while (st.length) { const nn = st.pop()!; comp.push(nn); const nx = nn % w, ny = (nn / w) | 0;
        if (nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1) border++;
        if (nearHull[nn]) inNear++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const mx = nx + dx, my = ny + dy; if (mx < 0 || my < 0 || mx >= w || my >= h) continue; const mm = my * w + mx; if (white[mm] && !vis[mm]) { vis[mm] = 1; st.push(mm); } } }
      const bounded = comp.length <= maxFace && border <= 4;
      const inside = inNear >= comp.length * 0.6;
      if (bounded && inside) for (const i of comp) mask[i] = 1;
    }
    const m = dilate(mask, w, h, 5);
    const blob = largest(m, w, h); if (!blob) { console.log(`${folder}/${n}: NO BLOB`); continue; }
    const hull = convexHull(blob);
    console.log(`${folder}/${n}: frac ${(polygonArea(hull) / (w * h)).toFixed(2)}  (colourSeed ${(polygonArea(cHull) / (w * h)).toFixed(2)})`);
    const svg = `<polygon points="${hull.map(p => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="rgba(0,255,200,0.18)" stroke="#00ffd0" stroke-width="2"/>`;
    const base = await sharp(path).resize(W, h).png().toBuffer();
    await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}">${svg}</svg>`), top: 0, left: 0 }]).png().toFile(`${OUT}/wb-${folder}-${n}.png`);
  }
}
}
main();
