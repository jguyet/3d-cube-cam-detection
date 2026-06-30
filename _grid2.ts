import sharp from "sharp";
import { RubikFaceDetector } from "./src/lib/rubik-detector/core/RubikFaceDetector";
import { ShapeDetector } from "./src/lib/rubik-detector/core/ShapeDetector";

const OUT = "/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SRC = "/Users/jeremyguyet/Desktop/cube";
const W = 360;
type P = { x: number; y: number };

async function load(path: string) {
  const meta = await sharp(path).metadata();
  const H = Math.round((W * (meta.height as number)) / (meta.width as number));
  const { data } = await sharp(path).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: W, height: H, data: new Uint8ClampedArray(data) };
}

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// Merged same-colour shapes are integer multiples of a unit cell. Split each
// shape into its unit cells using its (well-oriented) corners.
function subdivide(shapes: { corners: P[] }[]): P[] {
  const sides: number[] = [];
  for (const s of shapes) {
    const [tl, tr, br, bl] = s.corners;
    sides.push((dist(tl, tr) + dist(bl, br)) / 2, (dist(tl, bl) + dist(tr, br)) / 2);
  }
  if (!sides.length) return [];
  const sorted = sides.slice().sort((a, b) => a - b);
  const unit = sorted[Math.floor(sorted.length * 0.15)]; // smallest sides ≈ one cell
  const cells: P[] = [];
  for (const s of shapes) {
    const [tl, tr, br, bl] = s.corners;
    const wSide = (dist(tl, tr) + dist(bl, br)) / 2;
    const hSide = (dist(tl, bl) + dist(tr, br)) / 2;
    const nc = Math.max(1, Math.round(wSide / unit));
    const nr = Math.max(1, Math.round(hSide / unit));
    for (let a = 0; a < nc; a++)
      for (let b = 0; b < nr; b++) {
        const top = lerp(tl, tr, (a + 0.5) / nc), bot = lerp(bl, br, (a + 0.5) / nc);
        cells.push(lerp(top, bot, (b + 0.5) / nr));
      }
  }
  return cells;
}

// Fit the dominant 2-direction lattice to sticker centres.
function fitLattice(centers: P[]) {
  const n = centers.length;
  if (n < 4) return null;
  // cell size = median nearest-neighbour distance
  const nn: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = 0; j < n; j++) if (i !== j) m = Math.min(m, dist(centers[i], centers[j]));
    nn.push(m);
  }
  const cell = nn.slice().sort((a, b) => a - b)[nn.length >> 1];

  // candidate step vectors between near neighbours (fold sign: dir in [0,180))
  const steps: { ang: number; len: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dv = sub(centers[j], centers[i]);
      const len = Math.hypot(dv.x, dv.y);
      if (len < 0.7 * cell || len > 1.25 * cell) continue;
      let ang = (Math.atan2(dv.y, dv.x) * 180) / Math.PI;
      if (ang < 0) ang += 180;
      steps.push({ ang, len, dx: dv.x, dy: dv.y });
    }
  if (steps.length < 2) return null;

  // cluster step directions into families (15° tol), keeping lengths/angles
  const fams: { ang: number; n: number; lens: number[]; angs: number[] }[] = [];
  for (const s of steps) {
    let placed = false;
    for (const f of fams) {
      let dd = Math.abs(f.ang - s.ang); dd = Math.min(dd, 180 - dd);
      if (dd < 15) { f.lens.push(s.len); f.angs.push(s.ang); f.n++; f.ang = (f.ang * (f.n - 1) + s.ang) / f.n; placed = true; break; }
    }
    if (!placed) fams.push({ ang: s.ang, n: 1, lens: [s.len], angs: [s.ang] });
  }
  fams.sort((a, b) => b.n - a.n);
  if (fams.length < 2) return null;
  // basis = median length × unit(median angle) — robust to a few stray steps
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const toVec = (f: { lens: number[]; angs: number[] }) => {
    const L = med(f.lens), A = (med(f.angs) * Math.PI) / 180;
    return { x: L * Math.cos(A), y: L * Math.sin(A) };
  };
  const u = toVec(fams[0]);
  const v = toVec(fams[1]);

  // assign integer (i,j) to each centre: solve c - o = i*u + j*v
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 1e-3) return null;
  // origin = centre with min (i+j) → top-left; first use centroid as ref
  let cx = 0, cy = 0; for (const c of centers) { cx += c.x; cy += c.y; } cx /= n; cy /= n;
  const coords = centers.map((c) => {
    const dx = c.x - cx, dy = c.y - cy;
    const i = Math.round((dx * v.y - dy * v.x) / det);
    const j = Math.round((u.x * dy - u.y * dx) / det);
    return { c, i, j };
  });
  // normalise so min i,j = 0
  let mi = Infinity, mj = Infinity;
  for (const k of coords) { mi = Math.min(mi, k.i); mj = Math.min(mj, k.j); }
  for (const k of coords) { k.i -= mi; k.j -= mj; }

  return { cell, u, v, coords, angleU: fams[0].ang, angleV: fams[1].ang };
}

// From two image vectors U,V (projections of two orthogonal equal cube edges),
// recover the cube under orthographic projection and return its 8 corners.
function reconstructCube(TL: P, U: P, V: P): P[] | null {
  const uu = U.x * U.x + U.y * U.y, vv = V.x * V.x + V.y * V.y;
  const cross = U.x * V.y - U.y * V.x;
  // |U×V|² x² − (|U|²+|V|²) x + 1 = 0,  x = 1/L²
  const A = cross * cross, B = -(uu + vv), C = 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-9) return null;
  const lim = 1 / Math.max(uu, vv) + 1e-9;
  const x1 = (-B - Math.sqrt(disc)) / (2 * A), x2 = (-B + Math.sqrt(disc)) / (2 * A);
  const x = (x1 > 0 && x1 <= lim) ? x1 : x2;
  if (!(x > 0)) return null;
  const L = 1 / Math.sqrt(x);
  const ax = U.x / L, ay = U.y / L, bx = V.x / L, by = V.y / L;
  let uz = Math.sqrt(Math.max(0, 1 - (ax * ax + ay * ay)));
  let vz = Math.sqrt(Math.max(0, 1 - (bx * bx + by * by)));
  if (ax * bx + ay * by > 0) vz = -vz; // enforce orthogonality sign
  // third axis w = a × b, its image projection scaled by L
  const wx = ay * vz - uz * by, wy = uz * bx - ax * vz;
  const W = { x: L * wx, y: L * wy };
  const f0 = TL, f1 = { x: TL.x + U.x, y: TL.y + U.y }, f2 = { x: TL.x + U.x + V.x, y: TL.y + U.y + V.y }, f3 = { x: TL.x + V.x, y: TL.y + V.y };
  const bk = (p: P): P => ({ x: p.x + W.x, y: p.y + W.y });
  return [f0, f1, f2, f3, bk(f0), bk(f1), bk(f2), bk(f3)];
}
const CUBE_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

async function main() {
  for (const [folder, n] of [["no-gap", "1"], ["no-gap", "2"], ["black-gap", "1"], ["white-gap", "3"]] as const) {
    const path = `${SRC}/${folder}/${n}.png`;
    const img = await load(path);
    const det = new RubikFaceDetector();
    const r = det.process(img as unknown as ImageData);
    if (!r.hull) { console.log(`${folder}/${n}: no cube`); continue; }
    const sd = new ShapeDetector();
    const shapes = sd.detect(img as unknown as ImageData, 160, r.hull);
    const centers = subdivide(shapes); // split merged same-colour shapes into unit cells
    const lat = fitLattice(centers);
    if (!lat) { console.log(`${folder}/${n}: ${shapes.length} stickers, lattice FAIL`); continue; }
    const cols = Math.max(...lat.coords.map((k) => k.i)) + 1;
    const rows = Math.max(...lat.coords.map((k) => k.j)) + 1;
    console.log(`${folder}/${n}: ${shapes.length} stickers → grid ${cols}x${rows}, axes ${lat.angleU.toFixed(0)}°/${lat.angleV.toFixed(0)}°`);

    let svg = `<polygon points="${r.hull.map((p: P) => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>`;
    for (const s of shapes) svg += `<polygon points="${s.corners.map((p: P) => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="none" stroke="rgba(0,255,200,0.7)" stroke-width="1.5"/>`;
    for (const k of lat.coords) svg += `<text x="${k.c.x | 0}" y="${k.c.y | 0}" fill="#ff0" font-size="9" text-anchor="middle">${k.i}${k.j}</text>`;
    // draw u/v axes from centroid
    let cx = 0, cy = 0; for (const c of centers) { cx += c.x; cy += c.y; } cx /= centers.length; cy /= centers.length;
    svg += `<line x1="${cx | 0}" y1="${cy | 0}" x2="${(cx + lat.u.x) | 0}" y2="${(cy + lat.u.y) | 0}" stroke="#f00" stroke-width="2.5"/>`;
    svg += `<line x1="${cx | 0}" y1="${cy | 0}" x2="${(cx + lat.v.x) | 0}" y2="${(cy + lat.v.y) | 0}" stroke="#0f0" stroke-width="2.5"/>`;
    // reconstruct + draw the 3D cube from the lattice (orthographic)
    let mI = 0, mJ = 0; for (const k of lat.coords) { mI += k.i; mJ += k.j; } mI /= lat.coords.length; mJ /= lat.coords.length;
    const Oc = { x: cx - mI * lat.u.x - mJ * lat.v.x, y: cy - mI * lat.u.y - mJ * lat.v.y }; // (0,0) cell centre
    const TL = { x: Oc.x - 0.5 * lat.u.x - 0.5 * lat.v.x, y: Oc.y - 0.5 * lat.u.y - 0.5 * lat.v.y };
    const Uedge = { x: 3 * lat.u.x, y: 3 * lat.u.y }, Vedge = { x: 3 * lat.v.x, y: 3 * lat.v.y };
    const cube = reconstructCube(TL, Uedge, Vedge);
    if (cube) for (const [i, j] of CUBE_EDGES) svg += `<line x1="${cube[i].x | 0}" y1="${cube[i].y | 0}" x2="${cube[j].x | 0}" y2="${cube[j].y | 0}" stroke="#ff30e0" stroke-width="2.5"/>`;
    const base = await sharp(path).resize(W, img.height).png().toBuffer();
    await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${img.height}">${svg}</svg>`), top: 0, left: 0 }]).png().toFile(`${OUT}/grid2-${folder}-${n}.png`);
  }
}
main();
