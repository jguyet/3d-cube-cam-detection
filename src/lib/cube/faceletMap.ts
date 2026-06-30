// Maps a standard 54-char Kociemba facelet string (URFDLB face order, 9 stickers
// per face, row-major) to 3D sticker positions on our cube model.
//
// Coordinate system (matches CubeScene): x = R(+1)/L(-1), y = U(+1)/D(-1),
// z = F(+1)/B(-1). A sticker is identified by its cubie's solved position and
// the outward face direction.

export type Dir = "U" | "R" | "F" | "D" | "L" | "B";

// Physical colour scheme (white on top), so the mirror matches a real cube.
export const FACELET_COLOR: Record<string, string> = {
  U: "#ffffff", // white
  R: "#d50000", // red
  F: "#00a651", // green
  D: "#ffd500", // yellow
  L: "#ff7100", // orange
  B: "#0047ab", // blue
};

interface Cell {
  dir: Dir;
  x: number;
  y: number;
  z: number;
}

// The 54 facelets in order: U(0-8) R(9-17) F(18-26) D(27-35) L(36-44) B(45-53).
const CELLS: Cell[] = [
  // U face (y = 1): back row first, left→right
  { dir: "U", x: -1, y: 1, z: -1 }, { dir: "U", x: 0, y: 1, z: -1 }, { dir: "U", x: 1, y: 1, z: -1 },
  { dir: "U", x: -1, y: 1, z: 0 },  { dir: "U", x: 0, y: 1, z: 0 },  { dir: "U", x: 1, y: 1, z: 0 },
  { dir: "U", x: -1, y: 1, z: 1 },  { dir: "U", x: 0, y: 1, z: 1 },  { dir: "U", x: 1, y: 1, z: 1 },
  // R face (x = 1): top row first; columns front→back
  { dir: "R", x: 1, y: 1, z: 1 },  { dir: "R", x: 1, y: 1, z: 0 },  { dir: "R", x: 1, y: 1, z: -1 },
  { dir: "R", x: 1, y: 0, z: 1 },  { dir: "R", x: 1, y: 0, z: 0 },  { dir: "R", x: 1, y: 0, z: -1 },
  { dir: "R", x: 1, y: -1, z: 1 }, { dir: "R", x: 1, y: -1, z: 0 }, { dir: "R", x: 1, y: -1, z: -1 },
  // F face (z = 1): top row first; left→right
  { dir: "F", x: -1, y: 1, z: 1 }, { dir: "F", x: 0, y: 1, z: 1 }, { dir: "F", x: 1, y: 1, z: 1 },
  { dir: "F", x: -1, y: 0, z: 1 }, { dir: "F", x: 0, y: 0, z: 1 }, { dir: "F", x: 1, y: 0, z: 1 },
  { dir: "F", x: -1, y: -1, z: 1 }, { dir: "F", x: 0, y: -1, z: 1 }, { dir: "F", x: 1, y: -1, z: 1 },
  // D face (y = -1): front row first; left→right
  { dir: "D", x: -1, y: -1, z: 1 }, { dir: "D", x: 0, y: -1, z: 1 }, { dir: "D", x: 1, y: -1, z: 1 },
  { dir: "D", x: -1, y: -1, z: 0 }, { dir: "D", x: 0, y: -1, z: 0 }, { dir: "D", x: 1, y: -1, z: 0 },
  { dir: "D", x: -1, y: -1, z: -1 }, { dir: "D", x: 0, y: -1, z: -1 }, { dir: "D", x: 1, y: -1, z: -1 },
  // L face (x = -1): top row first; columns back→front
  { dir: "L", x: -1, y: 1, z: -1 }, { dir: "L", x: -1, y: 1, z: 0 }, { dir: "L", x: -1, y: 1, z: 1 },
  { dir: "L", x: -1, y: 0, z: -1 }, { dir: "L", x: -1, y: 0, z: 0 }, { dir: "L", x: -1, y: 0, z: 1 },
  { dir: "L", x: -1, y: -1, z: -1 }, { dir: "L", x: -1, y: -1, z: 0 }, { dir: "L", x: -1, y: -1, z: 1 },
  // B face (z = -1): top row first; columns from R-side(+x) to L-side(-x)
  { dir: "B", x: 1, y: 1, z: -1 }, { dir: "B", x: 0, y: 1, z: -1 }, { dir: "B", x: -1, y: 1, z: -1 },
  { dir: "B", x: 1, y: 0, z: -1 }, { dir: "B", x: 0, y: 0, z: -1 }, { dir: "B", x: -1, y: 0, z: -1 },
  { dir: "B", x: 1, y: -1, z: -1 }, { dir: "B", x: 0, y: -1, z: -1 }, { dir: "B", x: -1, y: -1, z: -1 },
];

const key = (dir: Dir, x: number, y: number, z: number) => `${dir}|${x}|${y}|${z}`;

const INDEX_OF = new Map<string, number>();
CELLS.forEach((c, i) => INDEX_OF.set(key(c.dir, c.x, c.y, c.z), i));

/** Facelet-string index for the sticker facing `dir` on the cubie at solved (x,y,z). */
export function faceletIndex(dir: Dir, x: number, y: number, z: number): number | undefined {
  return INDEX_OF.get(key(dir, x, y, z));
}
