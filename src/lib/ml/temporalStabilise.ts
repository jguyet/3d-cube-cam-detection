// Pure temporal-stability helpers for the live scanner. Kept dependency-free and
// side-effect-free so the same logic can be unit-tested on a synthetic frame
// sequence offline (the React loop itself isn't importable).

export interface Zone { x0: number; y0: number; x1: number; y1: number; miss: number }

// Stabilise the ML operating-zone bbox across frames. A raw per-frame bbox jumps,
// shrinks, or collapses to the upper rows when the model only fires on the top
// corners — corrupting the crop, sticker detection, lattice and pose. Reject such
// a candidate and HOLD the last good zone (up to `maxMiss` frames), otherwise
// accept with an EMA; snap-relock once we've rejected several in a row.
export function stabiliseZone(prev: Zone | null, cand: Omit<Zone, "miss">, maxMiss = 6): Zone {
  if (!prev) return { ...cand, miss: 0 };
  const cW = cand.x1 - cand.x0, cH = cand.y1 - cand.y0;
  const pW = prev.x1 - prev.x0, pH = prev.y1 - prev.y0;
  const cCx = (cand.x0 + cand.x1) / 2, cCy = (cand.y0 + cand.y1) / 2;
  const pCx = (prev.x0 + prev.x1) / 2, pCy = (prev.y0 + prev.y1) / 2;
  const cArea = cW * cH, pArea = pW * pH, pDiag = Math.hypot(pW, pH);
  const cAsp = cW / (cH || 1), pAsp = pW / (pH || 1);
  const bad =
    (cH < 0.62 * pH && Math.abs(cCx - pCx) < 0.30 * pW) ||   // top-crop: much shorter, centre stable
    cArea < 0.50 * pArea ||                                  // collapsed
    cAsp / pAsp > 1.7 || pAsp / cAsp > 1.7 ||                // aspect jump
    Math.hypot(cCx - pCx, cCy - pCy) > 0.6 * pDiag;          // positional jump
  if (bad && prev.miss < maxMiss) return { ...prev, miss: prev.miss + 1 };
  // accept: snap (a=1) for the first frame or after several rejects, else EMA
  const a = prev.miss >= 4 ? 1 : 0.35;
  return {
    x0: prev.x0 + a * (cand.x0 - prev.x0),
    y0: prev.y0 + a * (cand.y0 - prev.y0),
    x1: prev.x1 + a * (cand.x1 - prev.x1),
    y1: prev.y1 + a * (cand.y1 - prev.y1),
    miss: 0,
  };
}
