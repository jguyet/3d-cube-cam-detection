"use strict";
// Temporal smoothing across video frames. A single frame is noisy; the cube's
// face count and geometry are stable. We median-filter the decision signals
// over a short window and apply hysteresis so the face count doesn't flicker.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CubeTracker = void 0;
const WINDOW = 8; // frames of history for median smoothing
const COMMIT = 2; // consecutive frames a new count must hold before switching
const MAX_LOST = 6; // frames the cube may vanish before we drop the lock
// Thresholds (validated on real photos): high balance ⇒ 3 faces; otherwise a
// strongly-supported internal edge ⇒ 2 faces; else a single flat face.
const BALANCE_3 = 0.42;
const SUP2_2 = 0.64;
function median(xs) {
    if (!xs.length)
        return 0;
    const s = xs.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
}
class CubeTracker {
    constructor() {
        this.balHist = [];
        this.sup2Hist = [];
        this.fillHist = [];
        this.committedN = 0;
        this.pendingN = 0;
        this.pendingCount = 0;
        this.lost = 0;
        this.last = null;
    }
    update(f) {
        if (!f.hull) {
            this.lost++;
            if (this.last && this.lost <= MAX_LOST)
                return this.last; // brief dropout → hold
            this.reset();
            return { hull: null, faces: [], nFaces: 0, center: null, confidence: 0 };
        }
        this.lost = 0;
        this.push(this.balHist, f.balance);
        this.push(this.sup2Hist, f.sup2);
        this.push(this.fillHist, f.fillFrac);
        const balance = median(this.balHist);
        const sup2 = median(this.sup2Hist);
        const fillFrac = median(this.fillHist);
        // Decide on the smoothed signals.
        let target;
        if (balance > BALANCE_3 && f.cand3)
            target = 3;
        else if (sup2 > SUP2_2 && f.cand2)
            target = 2;
        else
            target = 1;
        // Hysteresis: require the new count to persist before committing.
        if (target === this.committedN) {
            this.pendingN = target;
            this.pendingCount = 0;
        }
        else if (target === this.pendingN) {
            if (++this.pendingCount >= COMMIT) {
                this.committedN = target;
                this.pendingCount = 0;
            }
        }
        else {
            this.pendingN = target;
            this.pendingCount = 1;
        }
        if (this.committedN === 0)
            this.committedN = target; // first lock is immediate
        const n = this.committedN;
        let faces = f.cand1, center = null;
        if (n === 3 && f.cand3) {
            faces = f.cand3.faces;
            center = f.cand3.center;
        }
        else if (n === 2 && f.cand2) {
            faces = f.cand2;
        }
        const det = {
            hull: f.hull,
            faces,
            nFaces: n,
            center,
            confidence: Math.min(1, fillFrac / 0.16),
            debug: { corners: f.corners, balance, sup2, weak2: f.weak2, fillFrac, smoothed: true },
        };
        this.last = det;
        return det;
    }
    push(arr, v) {
        arr.push(v);
        if (arr.length > WINDOW)
            arr.shift();
    }
    reset() {
        this.balHist = [];
        this.sup2Hist = [];
        this.fillHist = [];
        this.committedN = 0;
        this.pendingN = 0;
        this.pendingCount = 0;
        this.lost = 0;
        this.last = null;
    }
}
exports.CubeTracker = CubeTracker;
