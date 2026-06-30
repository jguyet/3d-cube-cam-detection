import sharp from "sharp";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DATASET_ROOT = "/Users/jeremyguyet/Desktop/cube";
const BUILD_ROOT = path.join(ROOT, ".tmp-eval");

const cases = [
  { cube: "black-gap", file: "1.png", expected: 1 },
  { cube: "black-gap", file: "2.png", expected: 2 },
  { cube: "black-gap", file: "3.png", expected: 3 },
  { cube: "white-gap", file: "1.png", expected: 1 },
  { cube: "white-gap", file: "2.png", expected: 2 },
  { cube: "white-gap", file: "3.png", expected: 3 },
  { cube: "no-gap", file: "1.png", expected: 1 },
  { cube: "no-gap", file: "2.png", expected: 2 },
  { cube: "no-gap", file: "3.png", expected: 3 },
];

function relImport(p) {
  return pathToFileURL(path.join(BUILD_ROOT, p)).href;
}

async function loadImageData(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

async function main() {
  const [{ RubikFaceDetector }, { CubeTracker }] = await Promise.all([
    import(relImport("core/RubikFaceDetector.js")),
    import(relImport("core/CubeTracker.js")),
  ]);

  let ok = 0;
  for (const item of cases) {
    const file = path.join(DATASET_ROOT, item.cube, item.file);
    const image = await loadImageData(file);
    const detector = new RubikFaceDetector();
    const tracker = new CubeTracker();
    const raw = detector.process(image);
    const det = tracker.update(raw);
    const pass = det.nFaces === item.expected;
    if (pass) ok++;
    console.log(
      [
        pass ? "OK " : "BAD",
        item.cube.padEnd(9),
        item.file,
        `expected=${item.expected}`,
        `got=${det.nFaces}`,
        `corners=${raw.corners}`,
        `balance=${raw.balance.toFixed(3)}`,
        `sup2=${raw.sup2.toFixed(3)}`,
        `fill=${raw.fillFrac.toFixed(3)}`,
      ].join("  "),
    );
    detector.dispose();
  }

  console.log(`\nscore ${ok}/${cases.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
