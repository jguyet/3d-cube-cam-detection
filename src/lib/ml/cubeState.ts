// Temporal cube state — CONTINUOUS multi-frame detection. Each face is identified by its
// centre colour (fixed on a standard cube), and each of its 9 cells VOTES its colour over
// frames. A cell only COMMITS once it has enough consistent votes, so transient misreads
// during a face change / rotation never flash into the state. Low-quality frames (a face
// mid-turn with few clean cells) are rejected so they can't pollute the votes.

import type { CubeColour } from "@/lib/ml/stickerColor";
import { checkSolvable, type Solvable } from "@/lib/ml/cubeSolvable";

export const SCHEME: Record<string, number> = { white: 0, yellow: 1, green: 2, blue: 3, red: 4, orange: 5 };
export const CENTRE: CubeColour[] = ["white", "yellow", "green", "blue", "red", "orange"];   // by faceId
const CUBE = new Set<CubeColour>(["white", "yellow", "red", "orange", "green", "blue"]);

export class CubeState {
  private votes: Record<string, number>[][] = Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => ({})));
  seen = new Set<number>();          // faces observed at least once
  lastFace = -1;                     // for face-change detection
  private minVotes = 3;              // a cell commits after this many votes for its top colour…
  private minAgree = 0.6;            // …AND at least this fraction agreement
  private minCells = 5;              // reject a frame whose face has fewer clean cells (mid-turn)

  // Feed one detected face (cells ordered gx + gy*3). Returns { faceId, changed } or null if
  // the frame was rejected (unknown centre / too few clean cells).
  observe(centre: CubeColour, cells: CubeColour[]): { faceId: number; changed: boolean } | null {
    const fi = SCHEME[centre]; if (fi === undefined) return null;
    let clean = 0; for (let k = 0; k < 9; k++) if (k !== 4 && CUBE.has(cells[k])) clean++;
    if (clean < this.minCells) return null;                 // low-quality frame — don't vote
    this.seen.add(fi);
    for (let k = 0; k < 9 && k < cells.length; k++) {
      if (k === 4) continue;                                // centre is fixed by the scheme
      const c = cells[k]; if (!CUBE.has(c)) continue;
      const v = this.votes[fi][k]; v[c] = (v[c] ?? 0) + 1;
    }
    const changed = fi !== this.lastFace; this.lastFace = fi;
    return { faceId: fi, changed };
  }

  // committed colour of a cell (mode) once confident, else null; centre is always its scheme colour
  colour(fi: number, k: number): CubeColour | null {
    if (k === 4) return CENTRE[fi];
    const v = this.votes[fi][k]; let best: CubeColour | null = null, bc = 0, tot = 0;
    for (const name of Object.keys(v)) { tot += v[name]; if (v[name] > bc) { bc = v[name]; best = name as CubeColour; } }
    return best && bc >= this.minVotes && bc / tot >= this.minAgree ? best : null;
  }
  confidence(fi: number, k: number): number {
    if (k === 4) return 1; const v = this.votes[fi][k]; let bc = 0, tot = 0;
    for (const name of Object.keys(v)) { tot += v[name]; if (v[name] > bc) bc = v[name]; }
    return tot ? bc / tot : 0;
  }

  // the confirmed 9 colours of a face (null where not yet confident)
  faceColours(fi: number): (CubeColour | null)[] { return Array.from({ length: 9 }, (_, k) => this.colour(fi, k)); }

  completion(): number { let n = 0; for (let fi = 0; fi < 6; fi++) for (let k = 0; k < 9; k++) if (this.colour(fi, k)) n++; return n / 54; }

  colourCounts(): Record<string, number> {
    const m: Record<string, number> = {};
    for (let fi = 0; fi < 6; fi++) for (let k = 0; k < 9; k++) { const c = this.colour(fi, k); if (c) m[c] = (m[c] ?? 0) + 1; }
    return m;
  }

  // Rubik laws: every colour ≤9 (→invalid if a misdetection pushes one over), all 54 → valid
  validity(): { status: "valid" | "invalid" | "partial"; msg: string } {
    const m = this.colourCounts();
    for (const c of Object.keys(m)) if (m[c] > 9) return { status: "invalid", msg: `trop de ${c} (${m[c]}/9)` };
    let filled = 0; for (const c of Object.keys(m)) filled += m[c];
    if (filled === 54) return { status: "valid", msg: "cube complet & valide" };
    return { status: "partial", msg: `${this.seen.size}/6 faces vues` };
  }

  // PHYSICAL solvability of the confirmed state (the 3 deep laws). Returns null while the
  // scan is incomplete. faceId→Kociemba face offset: U/white 0, R/red 9, F/green 18,
  // D/yellow 27, L/orange 36, B/blue 45.
  private static OFF = [0, 27, 18, 45, 9, 36];   // by faceId (white,yellow,green,blue,red,orange)
  solvable(): Solvable | null {
    const f: (CubeColour | null)[] = new Array(54).fill(null);
    for (let fi = 0; fi < 6; fi++) for (let k = 0; k < 9; k++) f[CubeState.OFF[fi] + k] = this.colour(fi, k);
    if (f.some((x) => !x)) return null;      // incomplete
    return checkSolvable(f);
  }

  reset() { this.votes = Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => ({}))); this.seen.clear(); this.lastFace = -1; }
}
