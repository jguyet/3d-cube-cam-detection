// Convert a cubing.js 3×3×3 KPattern (from BluetoothPuzzle.getPattern(), e.g. a GiiKER
// which reports its ABSOLUTE state) into the 54-char URFDLB facelet string the app uses.
// Inverse of cubing's getPatternData: at each slot the sticker letters are
// rotateLeft(pieceHomeName, orientation), written into the standard Kociemba facelet
// positions (U 0-8, R 9-17, F 18-26, D 27-35, L 36-44, B 45-53).

const EDGE_ORDER = "UF UR UB UL DF DR DB DL FR FL BR BL".split(" ");
const CORNER_ORDER = "UFR URB UBL ULF DRF DFL DLB DBR".split(" ");

// slot → its facelet indices, ORDERED to match the slot-name letters
const EDGE_FL: Record<string, number[]> = {
  UF: [7, 19], UR: [5, 10], UB: [1, 46], UL: [3, 37], DF: [28, 25], DR: [32, 16],
  DB: [34, 52], DL: [30, 43], FR: [23, 12], FL: [21, 41], BR: [48, 14], BL: [50, 39],
};
const CORNER_FL: Record<string, number[]> = {
  UFR: [8, 20, 9], URB: [2, 11, 45], UBL: [0, 47, 36], ULF: [6, 38, 18],
  DRF: [29, 15, 26], DFL: [27, 24, 44], DLB: [33, 42, 53], DBR: [35, 51, 17],
};
const rotL = (s: string, i: number) => s.slice(i) + s.slice(0, i);

interface Orbit { pieces: number[]; orientation: number[] }
interface PatternData { EDGES: Orbit; CORNERS: Orbit }

export function patternToFacelets(pattern: { patternData?: PatternData } | PatternData): string {
  const pd = ("patternData" in pattern && pattern.patternData ? pattern.patternData : pattern) as PatternData;
  const f = new Array<string>(54);
  f[4] = "U"; f[13] = "R"; f[22] = "F"; f[31] = "D"; f[40] = "L"; f[49] = "B";   // centres
  for (let s = 0; s < 12; s++) {
    const colours = rotL(EDGE_ORDER[pd.EDGES.pieces[s]], pd.EDGES.orientation[s]);
    const fl = EDGE_FL[EDGE_ORDER[s]];
    f[fl[0]] = colours[0]; f[fl[1]] = colours[1];
  }
  for (let s = 0; s < 8; s++) {
    const colours = rotL(CORNER_ORDER[pd.CORNERS.pieces[s]], pd.CORNERS.orientation[s]);
    const fl = CORNER_FL[CORNER_ORDER[s]];
    f[fl[0]] = colours[0]; f[fl[1]] = colours[1]; f[fl[2]] = colours[2];
  }
  return f.join("");
}
