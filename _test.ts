import sharp from "sharp";
import { Silhouette } from "./src/lib/rubik-detector/core/Silhouette";

const OUT = "/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SRC = "/Users/jeremyguyet/Desktop/cube";
const W = 360;

async function load(path: string) {
  const meta = await sharp(path).metadata();
  const H = Math.round((W * (meta.height as number)) / (meta.width as number));
  const { data } = await sharp(path).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: W, height: H, data: new Uint8ClampedArray(data) };
}

const FOLDERS = ["black-gap", "no-gap", "white-gap"];
async function main() {
for (const folder of FOLDERS) {
  for (const n of ["1", "2", "3"]) {
    const path = `${SRC}/${folder}/${n}.png`;
    const img = await load(path);
    const sil = new Silhouette();
    const res = sil.detect(img as unknown as ImageData);
    const info = res.hull ? `hull ${res.hull.length}pts frac ${res.fillFrac.toFixed(2)}` : "NO HULL";
    console.log(`${folder}/${n}: ${info}`);
    let svg = "";
    if (res.hull) {
      svg = `<polygon points="${res.hull.map((p) => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="rgba(0,255,200,0.18)" stroke="#00ffd0" stroke-width="2"/>`;
    }
    const base = await sharp(path).resize(W, img.height).png().toBuffer();
    await sharp(base)
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${img.height}">${svg}</svg>`), top: 0, left: 0 }])
      .png()
      .toFile(`${OUT}/cur-${folder}-${n}.png`);
  }
}
}
main();
