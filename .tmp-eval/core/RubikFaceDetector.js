"use strict";
// Per-frame analysis (pure JS): ImageData → saturation silhouette → candidate
// face decompositions + decision signals. The 1/2/3 decision is left to
// CubeTracker, which smooths these across video frames.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RubikFaceDetector = void 0;
const Silhouette_1 = require("./Silhouette");
const FaceDecomposer_1 = require("./FaceDecomposer");
class RubikFaceDetector {
    constructor() {
        this.silhouette = new Silhouette_1.Silhouette();
        this.decomposer = new FaceDecomposer_1.FaceDecomposer();
    }
    process(image) {
        const sil = this.silhouette.detect(image);
        if (!sil.hull) {
            return { hull: null, fillFrac: 0, corners: 0, balance: 0, sup2: 0, weak2: 0, cand1: [], cand2: null, cand3: null };
        }
        const grad = this.decomposer.gradient(image);
        const a = this.decomposer.analyze(sil.hull, grad);
        return {
            hull: sil.hull,
            fillFrac: sil.fillFrac,
            corners: a.corners,
            balance: a.balance,
            sup2: a.sup2,
            weak2: a.weak2,
            cand1: a.cand1,
            cand2: a.cand2,
            cand3: a.cand3,
        };
    }
    dispose() {
        this.silhouette.reset();
    }
}
exports.RubikFaceDetector = RubikFaceDetector;
