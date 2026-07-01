# Review: markerless Rubik's-cube detector — fresh-eyes CV/ML review (Fable 5)

Response to `fable5-your-prompt.md`.

---

## TL;DR

You don't have a "reconstruction" problem — you have a **PnP problem with a known CAD model**. Sticker quads give you dense, exact 2D↔3D correspondences to the cube lattice; once cell assignment is solved (easy), pose is a solved, boring problem. The two silent killers likely NOT handled yet are (a) **unknown focal length** and (b) **the planar two-fold pose ambiguity** when one face is visible. And one genuinely elegant trick is being missed: **sticker centers, recovered as the quad's diagonal intersection, are parameter-free exact model points.**

---

## Prioritized insights

### 1. Reframe: this is PnP against a known model, not geometry-stacking ⚠️ *core reframe*

Stop thinking "enforce cube constraints (equal faces, 90°, vanishing points)". A Rubik's cube is a **known 3D object**: in model units (sticker pitch p = 1, cube edge E = 3), every sticker center of face +Z is at `(i, j, 1.5)` for `i, j ∈ {−1, 0, 1}`. Once each detected quad is assigned to a `(face, i, j)` cell, you have N point correspondences → `solvePnP` (EPnP/homography init + a 10-line Gauss-Newton refine over R, t). All the priors listed in the prompt (vanishing points, size gradient, lattice fit) are *implicitly and optimally* enforced by minimizing reprojection error against the model. Don't build bespoke VP geometry as the estimator — use VPs only for initialization and focal calibration (below).

### 2. Sticker centers = diagonal intersections are the best correspondences ✅ *likely not considered*

Two subtleties, both valuable:

- **Sticker centers are invariant to sticker size and gap.** Corners of a sticker depend on the unknown sticker-width/pitch ratio w/p (varies by cube brand, stickerless vs stickered). Centers sit exactly at the lattice points `(i·p, j·p)` no matter what. So a center-only PnP has **zero unknown shape parameters**. Use corners only as a refinement after w/p is estimated (it's one global scalar; fit it once, it's constant for the session).
- **Don't use the centroid of the 4 corners as the center.** The centroid is only correct under affine projection; under perspective it's biased. The **intersection of the two quad diagonals is projectively exact** — it is the true image of the square's center under any homography. One cross-product per quad, and the correspondences become bias-free:

```
c = intersect( line(TL,BR), line(TR,BL) )   // exact projected sticker center
```

With up to 9 centers × 3 faces = 27 exact correspondences, pose is massively overdetermined even with fingers occluding half the stickers.

### 3. Unknown focal length is the silent error source ⚠️ *likely not considered*

Every homography decomposition and PnP needs intrinsics K. Assuming a default FOV makes the cube subtly skew/breathe — and the detector gets blamed. Estimate f in closed form when ≥2 faces are visible: each face homography H gives two vanishing points `v1 = H·(1,0,0)ᵀ`, `v2 = H·(0,1,0)ᵀ`; for two orthogonal directions with principal point c at image center:

```
f² = −(v1 − c)·(v2 − c)
```

Take the median over all orthogonal VP pairs and frames, EMA it, then **lock f** (it's constant per device). A 3×3 grid gives 8+ nearly-parallel lines per direction per face, so these VPs are extremely stable — this is where the "many collinear constraints" insight from the prompt actually pays off, not in pose estimation itself.

### 4. Single-face case: handle the IPPE two-fold ambiguity explicitly ⚠️

One planar face near fronto-parallel has a classic **mirror-pose ambiguity** (two R solutions with nearly equal reprojection error — see IPPE, Collins & Bartoli 2014). Symptoms: the extruded cube "pops" between tilting left and tilting right. Fixes, in order: (a) if a second face has even 2–3 stickers, joint PnP kills it; (b) otherwise pick the solution closest to the previous frame's pose; (c) sticker-size gradient as tiebreak — note it vanishes exactly at fronto-parallel, which is also where the ambiguity is worst, so temporal continuity is the real answer. Also: at fronto-parallel, f is unobservable from that frame — coast on the locked f.

### 5. Cell assignment (the actual "hard" part) is a small combinatorial problem

- **Face clustering:** graph over quads; connect two quads if center distance < ~1.8× median quad diagonal AND their edge directions agree within ~15°. Connected components = faces (1–3). Perspective keeps adjacent-face sticker orientations distinct enough; if not, a cheap 4-point homography consistency check per component splits merged clusters.
- **Grid indexing:** per face, take the two dominant edge directions (average of quad edges, or first homography estimate), project centers onto both axes, and round the normalized coordinates to {−1, 0, 1}. Missing stickers are fine — fit the homography per face with whatever's there (4+ points).
- **Inter-face labeling:** you can't know which face is "white" without color, and *you don't need to* — for drawing the box, pick any consistent labeling: first face = +Z, second face = whichever neighbor shares the border edge direction. Enforce handedness by requiring all assigned face normals to point toward the camera (`R·n_face · view < 0`). The 24-fold symmetry is a rendering non-issue; it only bites ML pose regression (see #7).

### 6. Filter the pose, not the pixels ⚠️ *current v3 does the opposite*

Temporal smoothing of hull/corner pixels (current v3) produces non-rigid "swimming" — corners lag differently and the shape stops being a cube. Filter in **pose space**: quaternion + translation (+ locked f), constant-velocity EKF or even a simple SLERP/EMA complementary filter, with a gate on reprojection RMS to reject bad frames, and coasting (predict-only) for dropouts < ~300 ms. The overlay then stays rigid by construction. Also note the convex hull of *sticker* corners systematically **underestimates** the cube silhouette (the plastic border is outside the stickers) — pose-projected model corners fix that for free, with `E/2 = 1.5p·γ`, γ ≈ 1.0–1.1 fit once alongside w/p.

### 7. Was deprioritizing ML corners a mistake? No — it was structurally doomed

- **Hidden corners are unobservable.** No training target fixes hallucination of points with zero image evidence; heatmap + soft-argmax will confidently invent them. The finding that capacity didn't help is exactly what unobservability predicts.
- **Cube-corner appearance is weak evidence** (black plastic corner against arbitrary background), unlike stickers which are high-contrast local structure. That's why zone transfers and corners don't.
- If ML is ever revisited, the targets that *would* transfer are **dense and local**: sticker segmentation masks, sticker-center heatmaps (27 channels max), or line/edge probability maps — because supervision matches local appearance. But the classical detector already produces exactly that output reliably, so there's nothing to buy.
- **Direct pose regression is a trap** on a cube: 24-fold rotational symmetry means the loss must be `min over 24 symmetries` of the geodesic distance (else gradients average across symmetric modes and the net predicts garbage means), and predicted translation entangles with unknown FOV. Skip permanently.

The current decomposition — ML for *where* (robust, transfers), geometry for *exact* (precise, provable) — is the right architecture. Don't renegotiate it.

### 8. Remaining blind spots (quick hits)

- **Corner ordering:** the detector's TL,TR,BR,BL is view-dependent; re-derive ordering from the face's dominant axes before matching to canonical cell corners, or use centers only (immune).
- **Motion blur / rolling shutter** during fast hand rotation warps quads; the EKF gate + coast handles it, but also keep last-frame LK tracking of sticker corners as a cheap detector-dropout bridge.
- **Specular blowout** on glossy stickers kills individual quads — filter with the existing `fill` field; PnP redundancy absorbs the loss.
- **Two faces exactly edge-on** (cube edge pointing at camera): one face's homography is degenerate; weight faces by their quad aspect/conditioning in the joint fit.

---

## The ship-this-week pipeline

1. ML zone → ShapeDetector → quads (existing, keep).
2. Centers via **diagonal intersection**; face clustering (graph); grid indexing (axis projection + rounding).
3. Per face: DLT homography from centers → VPs → update/lock **f**.
4. Correspondences (all centers, all faces) → PnP: homography/IPPE init, joint Gauss-Newton refine over (R, t); include sticker corners once w/p converges; fit γ once.
5. Single-face frames: IPPE both solutions, choose by temporal continuity.
6. Quaternion+translation EKF, reprojection gate, coast ≤300 ms.
7. Render: project the 8 model corners `(±1.5γ, ±1.5γ, ±1.5γ)` with (R, t, K). Confidence = f(#stickers, #faces, reprojection RMS / median quad size).

Everything here is a few hundred lines of plain TypeScript with no heavy dependencies — the only numerics are a 4-point DLT, a 3×3 SVD (or quaternion-based orthonormalization), and Gauss-Newton on 6 parameters.

**The single highest-leverage change if only one thing is done: switch the correspondence set to diagonal-intersection sticker centers and solve PnP with a calibrated-once focal length.** Most of the jitter and skew being fought downstream originates there.
