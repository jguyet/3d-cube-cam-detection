// Rubik's cube move notation parser.
//
// A move is decomposed into:
//   - axis:   which axis the layer turns around ('x' | 'y' | 'z')
//   - layers: which logical layers are affected (values among -1, 0, 1)
//   - dir:    base rotation sign about the POSITIVE axis (right-hand rule)
//
// Modifiers: ' inverts direction, 2 doubles the angle (180°).

export type Axis = "x" | "y" | "z";

export interface MoveStep {
  /** Original token, e.g. "R'", "U2", "x". */
  token: string;
  axis: Axis;
  /** Logical layers affected (subset of -1, 0, 1). */
  layers: number[];
  /** Signed rotation in radians about the positive axis. */
  angle: number;
}

interface BaseMove {
  axis: Axis;
  layers: number[];
  /** Base direction (sign) for a single clockwise face turn. */
  dir: 1 | -1;
}

const HALF = Math.PI / 2;

// Standard colour scheme: White Up, Yellow Down, Green Front, Blue Back,
// Red Right, Orange Left. Clockwise = looking at the face from outside.
const BASE: Record<string, BaseMove> = {
  R: { axis: "x", layers: [1], dir: -1 },
  L: { axis: "x", layers: [-1], dir: 1 },
  U: { axis: "y", layers: [1], dir: -1 },
  D: { axis: "y", layers: [-1], dir: 1 },
  F: { axis: "z", layers: [1], dir: -1 },
  B: { axis: "z", layers: [-1], dir: 1 },
  // Slices
  M: { axis: "x", layers: [0], dir: 1 }, // follows L
  E: { axis: "y", layers: [0], dir: 1 }, // follows D
  S: { axis: "z", layers: [0], dir: -1 }, // follows F
  // Wide (two layers)
  r: { axis: "x", layers: [0, 1], dir: -1 },
  l: { axis: "x", layers: [-1, 0], dir: 1 },
  u: { axis: "y", layers: [0, 1], dir: -1 },
  d: { axis: "y", layers: [-1, 0], dir: 1 },
  f: { axis: "z", layers: [0, 1], dir: -1 },
  b: { axis: "z", layers: [-1, 0], dir: 1 },
  // Whole-cube rotations
  x: { axis: "x", layers: [-1, 0, 1], dir: -1 },
  y: { axis: "y", layers: [-1, 0, 1], dir: -1 },
  z: { axis: "z", layers: [-1, 0, 1], dir: -1 },
};

/** Parse an algorithm string into a flat list of animatable steps. */
export function parseAlgorithm(input: string): MoveStep[] {
  if (!input) return [];
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const steps: MoveStep[] = [];

  for (const token of tokens) {
    const m = token.match(/^([RLUDFBMESrludfbxyz])(['2]?)$/);
    if (!m) {
      // Tolerate "2'" combos and unknown tokens by skipping.
      continue;
    }
    const [, letter, mod] = m;
    const base = BASE[letter];
    if (!base) continue;

    let magnitude = HALF;
    let sign = base.dir;
    if (mod === "2") magnitude = Math.PI;
    if (mod === "'") sign = (sign * -1) as 1 | -1;

    steps.push({
      token,
      axis: base.axis,
      layers: base.layers,
      angle: sign * magnitude,
    });
  }
  return steps;
}

/** Invert an algorithm string (reverse order + invert each move). */
export function invertAlgorithm(input: string): string {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  return tokens
    .reverse()
    .map((token) => {
      if (token.endsWith("2")) return token; // self-inverse
      if (token.endsWith("'")) return token.slice(0, -1);
      return token + "'";
    })
    .join(" ");
}

export { HALF };
