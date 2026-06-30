"use strict";
// Turns a cube silhouette (convex hull) into candidate face decompositions and
// the signals used to choose between them. The final 1/2/3 decision is made by
// CubeTracker, which smooths these signals across video frames.
//
// A cube projects to a hexagon. We simplify the hull to its corners, then build:
//   • cand1 — one flat face (min-area rectangle).
//   • cand2 — two parallelograms split along the best-supported internal edge.
//   • cand3 — three parallelograms meeting at a shared near-corner.
// Signals: `balance` (area balance of the 3-way split — high ⇒ 3 faces) and
// `sup2` (image-gradient support of the internal edge — high ⇒ ≥2 faces).
Object.defineProperty(exports, "__esModule", { value: true });
exports.FaceDecomposer = void 0;
const geometry_1 = require("../utils/geometry");
class FaceDecomposer {
    gradient(img) {
        const w = img.width, h = img.height, d = img.data;
        const g = new Float32Array(w * h);
        for (let i = 0, j = 0; i < d.length; i += 4, j++)
            g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const mag = new Float32Array(w * h);
        const gxMap = new Float32Array(w * h);
        const gyMap = new Float32Array(w * h);
        let mx = 1;
        for (let y = 1; y < h - 1; y++)
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
                const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
                const m = Math.hypot(gx, gy);
                gxMap[i] = gx;
                gyMap[i] = gy;
                mag[i] = m;
                if (m > mx)
                    mx = m;
            }
        return { mag, gx: gxMap, gy: gyMap, w, h, mx };
    }
    analyze(hull, grad) {
        const rect = (0, geometry_1.minAreaRect)(hull);
        const cand1 = [rect ? rect.corners : hull.slice(0, 4)];
        const peri = hull.reduce((s, p, i) => s + (0, geometry_1.dist)(p, hull[(i + 1) % hull.length]), 0);
        const P = this.simplifyCorners(hull, peri);
        if (P.length < 6) {
            return {
                corners: P.length,
                balance: 0,
                sup2: 0,
                weak2: 0,
                cand1,
                cand2: null,
                cand3: null,
            };
        }
        const d3 = this.decompose3(P);
        const areas = d3.faces.map((f) => (0, geometry_1.polygonArea)(f)).sort((a, b) => a - b);
        const balance = areas[2] ? areas[0] / areas[2] : 0;
        const diags = [[0, 3], [1, 4], [2, 5]];
        let sup2 = 0, bestDiag = diags[0];
        for (const [i, j] of diags) {
            const su = this.edgeSupport(P[i], P[j], grad);
            if (su > sup2) {
                sup2 = su;
                bestDiag = [i, j];
            }
        }
        const [i, j] = bestDiag;
        const q1 = [], q2 = [];
        for (let k = i; k !== j; k = (k + 1) % 6)
            q1.push(P[k]);
        q1.push(P[j]);
        for (let k = j; k !== i; k = (k + 1) % 6)
            q2.push(P[k]);
        q2.push(P[i]);
        const strongCand2 = q1.length === 4 && q2.length === 4 ? [q1, q2] : null;
        return {
            corners: P.length,
            balance,
            sup2,
            weak2: 0,
            cand1,
            cand2: strongCand2,
            cand3: { faces: d3.faces, center: d3.center },
        };
    }
    decompose3(V) {
        const phases = [[0, 2, 4], [1, 3, 5]];
        let bestC = null, bestVar = Infinity, bestFar = [0, 2, 4];
        for (const far of phases) {
            const ests = far.map((f) => (0, geometry_1.sub)((0, geometry_1.add)(V[(f + 1) % 6], V[(f + 5) % 6]), V[f]));
            const v = (0, geometry_1.variance)(ests), c = (0, geometry_1.centroid)(ests);
            if ((0, geometry_1.pointInPoly)(c, V) && v < bestVar) {
                bestVar = v;
                bestC = c;
                bestFar = far;
            }
        }
        const C = bestC ?? (0, geometry_1.centroid)(V);
        const faces = bestFar.map((f) => [V[f], V[(f + 1) % 6], C, V[(f + 5) % 6]]);
        return { faces, center: C };
    }
    simplifyCorners(hull, peri) {
        const epsilons = [0.0225, 0.018, 0.014].map((k) => k * peri);
        let best = [];
        for (const eps of epsilons) {
            let poly = (0, geometry_1.dpClosed)(hull, eps);
            if (poly.length > 6)
                poly = (0, geometry_1.topKCorners)(poly, 6);
            if (poly.length > best.length)
                best = poly;
            if (poly.length >= 6)
                return poly;
        }
        return best;
    }
    edgeSupport(a, b, G, trim = 0.18) {
        const N = 40;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        let hit = 0, cnt = 0, sum = 0;
        for (let t = trim; t <= 1 - trim; t += (1 - 2 * trim) / N) {
            const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
            let best = 0;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 1 || yy < 1 || xx >= G.w - 1 || yy >= G.h - 1)
                        continue;
                    const i = yy * G.w + xx;
                    const oriented = Math.abs(G.gx[i] * nx + G.gy[i] * ny) / G.mx;
                    const v = 0.75 * oriented + 0.25 * (G.mag[i] / G.mx);
                    if (v > best)
                        best = v;
                }
            cnt++;
            sum += Math.min(1, best / 0.42);
            if (best > 0.18)
                hit++;
        }
        return cnt ? 0.55 * (hit / cnt) + 0.45 * (sum / cnt) : 0;
    }
}
exports.FaceDecomposer = FaceDecomposer;
