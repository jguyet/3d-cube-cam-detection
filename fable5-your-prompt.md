You are a fresh, senior computer-vision + ML mind brought in to review a markerless Rubik's-cube camera detector and spot anything the team has MISSED. Be critical, original, concrete. Do NOT just validate — find blind spots, simpler paths, better formulations. Give real algorithms/math, not generic advice.

## Goal
Overlay an exact 3D cube (orientation + 8 corners) on a real Rubik's cube held on a webcam, real-time in-browser.

## Journey so far
1. Pure classical CV: brittle on full real scenes.
2. ML on SYNTHETIC data (WebGL: randomized pose/lights/real-photo backgrounds/procedural hands/glossy HDR stickers/realistic t-shirt torso; pixel-perfect labels; tens of thousands of images; + real Kaggle no-cube crops as hard negatives).
3. Model: MobileNetV3-large + spatial HEATMAP decoder (48x80) + soft-argmax → 8 corner heatmaps + per-corner visibility + 6 face flags + 1 presence. ONNX in browser.
4. Verified findings (real Kaggle IoU benchmark + real hand-held images):
   - Presence + cube-ZONE localization TRANSFER GREAT to real (finds where the cube is, ~0 false positives after real negatives).
   - Exact CORNER positions do NOT transfer: imprecise/uncertain on real; hidden back corners hallucinated.
   - Bigger backbone (EffNet-B1/B3) did NOT help corner precision (synthetic coordMSE saturated) → capacity is not the bottleneck; sim2real corner ambiguity is.
   - Adding scene complexity (distractors/close-ups/solved/torsos) REGRESSES the clean case at ~5M params.
5. Current HYBRID (works well): ML gives cube ZONE → classical ShapeDetector (color-edge quads) run RESTRICTED to that zone detects the cube's STICKER quads VERY reliably ("shapes perfect", user-confirmed). Each Shape = 4 ordered corners of one 3x3-grid sticker. Faces are rejected (no sticker grid = not a cube).
6. Open problem (being solved by another agent workflow): reconstruct exact 3D cube pose (orientation + 8 valid corners) FROM the precise sticker quads using cube priors (equal faces, 90-deg angles, 3x3 grid, 3 vanishing points, faces meet at one corner).

## Answer concretely
1. Given sticker quads are essentially PERFECT, what is the SIMPLEST + most ROBUST way to get exact orientation + 8 corners? Any elegant formulation being overlooked (e.g. each face's 3x3 grid yields MANY collinear/parallel constraints → very stable vanishing points; sticker SIZE gradient encodes depth; direct 3x3x3 lattice fit; using the sticker-grid line intersections as dense correspondences for a homography-then-decompose)?
2. Was deprioritizing the model for corners a mistake? Would a different training TARGET transfer to real far better (face/sticker segmentation, sticker-center heatmaps, edge/line maps, or direct pose params)? Symmetry pitfalls for pose regression on a cube?
3. Any fundamentally SIMPLER end-to-end path missed (skip 8-corner idea; track the sticker grid + Kalman/pose filter; use the 3 vanishing points directly as orientation and never ML-predict corners)?
4. Blind spots/risks in the current hybrid: temporal stability, which-face ambiguity, color/scheme independence, gyroscope/orientation sign ambiguities, near-face-on degeneracies.
5. If shipping a rock-solid version this week, what EXACT pipeline would you build?

Return a PRIORITIZED list of the most valuable insights, clearly marking any the team likely has NOT considered. Be specific and technical.

---

### Data contract (for any code you propose)

```ts
type Point2 = { x: number; y: number };            // image pixels
interface Shape {
  corners: [Point2, Point2, Point2, Point2];        // one sticker quad, ordered TL,TR,BR,BL
  center: Point2;
  area: number;
  fill: number;                                      // 0..1
}
// You are given: shapes: Shape[]  (detected stickers of 1-3 visible faces), image W, H.
// Desired: function cubePoseFromStickers(shapes, W, H) -> { corners: Point2[8], edges:[number,number][12], faces:number, confidence:number } | null
```
