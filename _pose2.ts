import sharp from "sharp";
import { Silhouette } from "./src/lib/rubik-detector/core/Silhouette";
import { CubePoseFitter } from "./src/lib/rubik-detector/core/CubePoseFitter";

const OUT = "/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SRC = "/Users/jeremyguyet/Desktop/cube";
const W = 360;

async function load(path: string) {
  const meta = await sharp(path).metadata();
  const H = Math.round((W * (meta.height as number)) / (meta.width as number));
  const { data } = await sharp(path).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: W, height: H, data: new Uint8ClampedArray(data) };
}

async function main() {
  for (const folder of ["black-gap", "no-gap", "white-gap"]) {
    for (const n of ["1", "2", "3"]) {
      const path = `${SRC}/${folder}/${n}.png`;
      const img = await load(path);
      const sil = new Silhouette();
      const res = sil.detect(img as unknown as ImageData);
      const fitter = new CubePoseFitter();
      const pose = res.hull ? fitter.fit(res.hull, img.width, img.height) : null;
      const pct = pose ? (pose.score * 100).toFixed(0) : "-";
      console.log(`${folder}/${n}: score ${pct}%${pose && pose.score >= 0.75 ? "  ✓ PLACED" : ""}`);
      let svg = "";
      if (res.hull) svg += `<polygon points="${res.hull.map((p) => `${p.x | 0},${p.y | 0}`).join(" ")}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1"/>`;
      if (pose && pose.score >= 0.75) {
        const c = pose.corners2d;
        pose.edges.forEach(([i, j], k) => {
          const vis = pose.visibleEdge[k];
          svg += `<line x1="${c[i].x | 0}" y1="${c[i].y | 0}" x2="${c[j].x | 0}" y2="${c[j].y | 0}" stroke="${vis ? "#00ffd0" : "#0a7"}" stroke-width="${vis ? 2.5 : 1}" stroke-dasharray="${vis ? "" : "4 4"}"/>`;
        });
      }
      const base = await sharp(path).resize(W, img.height).png().toBuffer();
      await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${img.height}">${svg}</svg>`), top: 0, left: 0 }]).png().toFile(`${OUT}/pose2-${folder}-${n}.png`);
    }
  }
}
main();
