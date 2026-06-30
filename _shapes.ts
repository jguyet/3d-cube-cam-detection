import sharp from "sharp";
import { ShapeDetector } from "./src/lib/rubik-detector/core/ShapeDetector";
import { ShapeTracker } from "./src/lib/rubik-detector/core/ShapeTracker";

const OUT = "/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SRC = "/Users/jeremyguyet/Desktop/cube";
const W = 360;

async function load(path: string) {
  const meta = await sharp(path).metadata();
  const H = Math.round((W * (meta.height as number)) / (meta.width as number));
  const { data } = await sharp(path).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: W, height: H, data: new Uint8ClampedArray(data) };
}

function quadSvg(corners: { x: number; y: number }[], color: string, wdt = 2) {
  return `<polygon points="${corners.map((p) => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${wdt}"/>`;
}

async function main() {
  // 1) per-frame detection on the dataset (fresh detector each → no bg model)
  for (const folder of ["black-gap", "no-gap", "white-gap"]) {
    for (const n of ["1", "2", "3"]) {
      const path = `${SRC}/${folder}/${n}.png`;
      const img = await load(path);
      const det = new ShapeDetector();
      const shapes = det.detect(img as unknown as ImageData, Number(process.env.CT||300));
      console.log(`${folder}/${n}: ${shapes.length} shapes`);
      let svg = "";
      for (const s of shapes) svg += quadSvg(s.corners, "rgba(0,255,200,0.9)");
      const base = await sharp(path).resize(W, img.height).png().toBuffer();
      await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${img.height}">${svg}</svg>`), top: 0, left: 0 }]).png().toFile(`${OUT}/shapes-${folder}-${n}.png`);
    }
  }

  // 2) temporal tracking on a burst sequence
  const seqPath = "/Users/jeremyguyet/Downloads/cube-seq-24x360x203.png";
  try {
    const { data } = await sharp(seqPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const fw = 360, fh = 203, NF = 24;
    const seqDet = new ShapeDetector();
    const tracker = new ShapeTracker();
    let rawCount = 0;
    let lastTracked: ReturnType<ShapeTracker["update"]> = [];
    let mid: Buffer | null = null;
    for (let f = 0; f < NF; f++) {
      const fd = Buffer.alloc(fw * fh * 4);
      for (let y = 0; y < fh; y++) data.copy(fd, y * fw * 4, (f * fh + y) * fw * 4, (f * fh + y + 1) * fw * 4);
      const img = { width: fw, height: fh, data: new Uint8ClampedArray(fd) };
      const shapes = seqDet.detect(img as unknown as ImageData, Number(process.env.CT||300));
      if (f === 20) rawCount = shapes.length;
      lastTracked = tracker.update(shapes);
      if (f === 20) mid = fd;
    }
    console.log(`sequence frame20: ${rawCount} shapes after bg-subtraction → ${lastTracked.length} tracked`);
    if (mid) {
      let svg = "";
      for (const t of lastTracked) {
        svg += quadSvg(t.corners, "rgba(0,255,200,0.95)", 2);
        svg += `<text x="${t.center.x | 0}" y="${t.center.y | 0}" fill="#ff0" font-size="9">${t.id}</text>`;
      }
      await sharp(mid, { raw: { width: fw, height: fh, channels: 4 } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${svg}</svg>`), top: 0, left: 0 }]).png().toFile(`${OUT}/shapes-seq.png`);
    }
  } catch (e) {
    console.log("sequence skipped:", (e as Error).message);
  }
}
main();
