// Headless dataset generator: drives /dataset/headless in a headless Chrome,
// writes cube_XXXXXX.png + labels.jsonl to disk. No browser window needed.
//
//   node training/gen_headless.mjs --out dataset-2 --n 20000 --batch 40 --bg 500
//
// Requires the dev server running (npm run dev) and puppeteer installed.

import puppeteer from "puppeteer";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const A = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? "true"])
);
const OUT = A.out || "dataset-2";
const N = parseInt(A.n || "20000", 10);
const BATCH = parseInt(A.batch || "40", 10);
const BG = parseInt(A.bg || "500", 10);
const SEED = parseInt(A.seed || String((Date.now() & 0x7fffffff) || 1), 10);
const URL = (A.url || "http://localhost:3000").replace(/\/$/, "");

async function main() {
  await mkdir(OUT, { recursive: true });
  const labelsPath = path.join(OUT, "labels.jsonl");
  await writeFile(labelsPath, ""); // truncate

  console.log(`gen → ${OUT}  n=${N}  batch=${BATCH}  bg=${BG}  seed=${SEED}`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-dev-shm-usage",
      "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("  [page]", m.text()); });
    await page.goto(`${URL}/dataset/headless?bg=${BG}&seed=${SEED}`, {
      waitUntil: "domcontentloaded", timeout: 60000,
    });
    console.log("page loaded, waiting for backgrounds + WebGL…");
    await page.waitForFunction("window.__cube && window.__cube.ready === true", { timeout: 300000 });
    const info = await page.evaluate(() => ({ bg: window.__cube.bgCount, err: window.__cube.error }));
    if (info.err) throw new Error("page error: " + info.err);
    console.log(`ready — ${info.bg} backgrounds loaded`);

    const t0 = Date.now();
    let idx = 0;
    while (idx < N) {
      const k = Math.min(BATCH, N - idx);
      const batch = await page.evaluate((kk) => window.__cube.genBatch(kk), k);
      let lines = "";
      for (const { png, label } of batch) {
        const name = `cube_${String(idx).padStart(6, "0")}.png`;
        await writeFile(path.join(OUT, name), Buffer.from(png.split(",")[1], "base64"));
        lines += JSON.stringify({ file: name, ...label }) + "\n";
        idx++;
      }
      await appendFile(labelsPath, lines);
      if (idx % 500 < BATCH || idx === N) {
        const rate = idx / ((Date.now() - t0) / 1000);
        const eta = Math.round((N - idx) / Math.max(rate, 1));
        console.log(`  ${idx}/${N}  (${rate.toFixed(0)}/s, eta ${eta}s)`);
      }
    }
    console.log(`done — ${idx} images in ${OUT}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
