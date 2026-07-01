// Synthetic dataset engine (three.js). Renders a randomised cube (scheme,
// pose, lights, background, hands) and computes per-sample labels:
//   - 8 cube corners: normalised (x,y) + visibility (on-screen & not occluded)
//   - 6 faces: visibility (camera-facing)
// Domain randomisation -> a small net can learn cube pose + faces from this.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { buildCube, CUBE_CORNERS, CUBE_FACES, type Scheme } from "./cubeModel";
import { buildHand } from "./handModel";

export interface BgItem { tex: THREE.Texture; bbox?: { cx: number; cy: number; w: number; h: number } }
export interface Corner { x: number; y: number; v: 0 | 1 }
export interface Sample {
  corners: Corner[];   // 8
  faces: (0 | 1)[];    // 6 (order of CUBE_FACES)
  scheme: Scheme;
  present: 0 | 1;      // 0 = negative frame (no cube)
}

let seed = 1234567;
function rng(): number { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
export function reseed(s: number) { seed = s >>> 0 || 1; }

const SCHEMES: Scheme[] = ["black", "white", "none"];

export class DatasetEngine {
  readonly width: number;
  readonly height: number;
  private readonly fov = 38;            // vertical FOV
  private readonly aspect: number;
  private readonly tanHalf: number;     // tan(fovV/2)
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig = new THREE.Group();      // holds cube + hands; gets the random pose
  private cube: THREE.Group | null = null;
  private person = new THREE.Group();   // t-shirt torso behind the cube (realism)
  private lights = new THREE.Group();
  private ray = new THREE.Raycaster();
  private bgItems: BgItem[] = [];
  private lastScheme: Scheme = "black";
  private shirts: THREE.Object3D[] = [];
  private fabric: { albedo: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture } | null = null;
  private mockupReady = false;

  // 16:9 landscape to match a real webcam (no square-stretch of the cube).
  constructor(canvas: HTMLCanvasElement, width = 480, height = 270) {
    this.width = width;
    this.height = height;
    this.aspect = width / height;
    this.tanHalf = Math.tan((this.fov * Math.PI / 180) / 2);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(1);
    this.camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.1, 100);
    this.scene.add(this.rig);
    this.scene.add(this.person);
    this.scene.add(this.lights);
    // Image-based lighting → realistic glossy plastic reflections on the stickers
    // (the biggest sim2real cue for a real Rubik's cube).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  }

  setBackgrounds(items: BgItem[]) { this.bgItems = items; }

  // Load the t-shirt torso GLB(s) + fabric textures + (optionally) a studio HDR,
  // so positives can render a realistic clothed torso behind the cube — matching
  // the real "person holding a cube" scenario. Call before generating.
  async loadMockup(shirtUrls: string[], hdrUrl?: string) {
    const tl = new THREE.TextureLoader();
    const [albedo, normal, rough] = await Promise.all([
      tl.loadAsync("/mockup/models/tshirt_albedo.png"),
      tl.loadAsync("/mockup/models/tshirt_normal.png"),
      tl.loadAsync("/mockup/models/tshirt_roughness.png"),
    ]);
    albedo.colorSpace = THREE.SRGBColorSpace;
    for (const t of [albedo, normal, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    this.fabric = { albedo, normal, rough };
    if (hdrUrl) {
      try {
        const hdr = await new RGBELoader().loadAsync(hdrUrl);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      } catch { /* keep RoomEnvironment */ }
    }
    const gl = new GLTFLoader();
    for (const u of shirtUrls) {
      try {
        const g = await gl.loadAsync(u);
        const box = new THREE.Box3().setFromObject(g.scene);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        // normalise: recentre and scale so the garment is ~1 unit tall
        const wrap = new THREE.Group();
        g.scene.position.sub(center);
        g.scene.scale.multiplyScalar(1 / (size.y || 1));
        wrap.add(g.scene);
        this.shirts.push(wrap);
      } catch { /* skip */ }
    }
    this.mockupReady = this.shirts.length > 0;
    return this.mockupReady;
  }

  randomize(): Sample {
    this.disposeGroup(this.rig); this.rig.clear(); this.cube = null;
    this.person.clear();   // clones share the template's geometry → don't dispose

    // ~15% synthetic NEGATIVE frames (real Kaggle no-cube crops are added to the
    // dataset separately and do the heavy lifting; keep synth negatives modest so
    // presence recall on real cubes isn't over-suppressed).
    if (rng() < 0.15) return this.negativeSample();

    // Build a positive; retry if the cube ends up mostly hidden by a hand. Later
    // attempts drop the hands, so an over-occluding hand can't produce a bad label.
    let last: Sample | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      this.buildPositive(attempt);
      this.rig.updateMatrixWorld(true);
      const s = this.labels();
      last = s;
      const vis = s.corners.reduce((n, c) => n + c.v, 0);
      if (vis >= 3) return s;   // cube adequately visible → keep it
    }
    return last!;               // rare fallback
  }

  private buildPositive(attempt: number) {
    this.disposeGroup(this.rig); this.rig.clear();
    this.rig.position.set(0, 0, 0);
    this.rig.scale.setScalar(1);

    const scheme = SCHEMES[(rng() * SCHEMES.length) | 0];
    this.lastScheme = scheme;
    this.cube = buildCube(scheme, rng);
    this.rig.add(this.cube);

    // hands (0-2) gripping the cube; dropped entirely on later retries so a hand
    // that covers the cube from the front can't force a "present but invisible" case
    const nHands = attempt >= 2 ? 0 : (rng() < 0.8 ? 1 : (rng() < 0.5 ? 0 : 2));
    for (let i = 0; i < nHands; i++) {
      const h = buildHand(rng);
      if (i === 1) h.scale.x *= -1;
      this.cube.add(h);
    }

    // random rotation
    this.rig.quaternion.copy(new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (rng() - 0.5) * Math.PI * 1.2, rng() * Math.PI * 2, (rng() - 0.5) * Math.PI * 0.6)));

    // lights
    this.lights.clear();
    this.lights.add(new THREE.AmbientLight(0xffffff, 0.25 + rng() * 0.5));
    const nL = 1 + ((rng() * 2) | 0);
    for (let i = 0; i < nL; i++) {
      const col = new THREE.Color().setHSL(rng(), 0.2 + rng() * 0.5, 0.5 + rng() * 0.3);
      const dl = new THREE.DirectionalLight(col, 0.5 + rng() * 1.2);
      dl.position.set((rng() - 0.5) * 6, (rng() - 0.5) * 6, 2 + rng() * 5);
      this.lights.add(dl);
    }

    // ---- background + placement (cube anywhere in frame, but ALWAYS fully inside) ----
    const item = (this.bgItems.length && rng() < 0.92) ? this.bgItems[(rng() * this.bgItems.length) | 0] : null;
    this.scene.background = item ? item.tex : this.proceduralBg();
    const t = this.tanHalf;
    const D = 2.8 + rng() * 2.4;          // closer camera → bigger cubes on average
    this.camera.position.set(0, 0, D); this.camera.lookAt(0, 0, 0);

    // choose an apparent size: 25% snap onto the background's original-cube bbox
    // (covers the blur), otherwise a large-skewed random size with a solid floor
    // so the cube is always a good, clearly-visible size (never tiny).
    const useBbox = !!(item && item.bbox && rng() < 0.25);
    let s = useBbox
      ? Math.max(item!.bbox!.w, item!.bbox!.h) * 2 * D * t / 1.3 * (1.0 + rng() * 0.5)
      : 0.9 + Math.pow(rng(), 0.55) * 1.7;

    // Bounding-sphere radius = 0.866·s. Shrink if it can't fit; then bound the
    // center so the WHOLE cube stays on-screen (fixes "cube leaves the frame").
    const margin = 0.08;   // keep the cube well clear of every edge
    const rY0 = (0.866 * s) / (D * t);
    if (rY0 > 1 - margin) s *= (1 - margin) / rY0;
    this.rig.scale.setScalar(s);
    const rYn = (0.866 * s) / (D * t);
    const rXn = rYn / this.aspect;
    const okX = Math.max(0, 1 - margin - rXn);
    const okY = Math.max(0, 1 - margin - rYn);

    let nx: number, ny: number;
    if (useBbox) {
      nx = Math.max(-okX, Math.min(okX, 2 * item!.bbox!.cx - 1));
      ny = Math.max(-okY, Math.min(okY, 1 - 2 * item!.bbox!.cy));
    } else {
      nx = (rng() * 2 - 1) * okX;
      ny = (rng() * 2 - 1) * okY;
    }
    // NDC → world at z=0 (x scaled by aspect for the 16:9 frame)
    this.rig.position.set(nx * D * t * this.aspect, ny * D * t, 0);

    // ~65%: a realistic t-shirt TORSO behind the cube (matches "person holding a
    // cube in a room" — the biggest remaining sim2real gap vs crude procedural hands)
    if (this.mockupReady && rng() < 0.65) this.addShirt(nx, ny, D, t, s);
  }

  private addShirt(nx: number, ny: number, D: number, t: number, s: number) {
    const shirt = this.shirts[(rng() * this.shirts.length) | 0].clone(true);
    const col = new THREE.Color().setHSL(rng(), 0.3 + rng() * 0.55, 0.25 + rng() * 0.55);
    const mat = new THREE.MeshStandardMaterial({
      color: col, map: this.fabric!.albedo, normalMap: this.fabric!.normal,
      roughnessMap: this.fabric!.rough, roughness: 0.9, metalness: 0.0, envMapIntensity: 0.8,
    });
    shirt.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = mat; });
    const sc = (2.9 + rng() * 1.8) * s;                       // torso ~3-4.5× the cube (fills bg)
    shirt.scale.setScalar(sc);
    shirt.position.set(nx * D * t * this.aspect + (rng() - 0.5) * 0.3 * s,
      ny * D * t - (0.2 + rng() * 0.4) * s, -(0.5 + rng() * 0.7) * s);    // just behind, slightly lower
    shirt.rotation.set((rng() - 0.5) * 0.22, (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.15); // mostly front-facing
    this.person.add(shirt);
    this.person.updateMatrixWorld(true);
  }

  render() { this.renderer.render(this.scene, this.camera); }

  toBlob(): Promise<Blob | null> {
    return new Promise((res) => this.renderer.domElement.toBlob((b) => res(b), "image/png"));
  }

  private labels(): Sample {
    const occ: THREE.Object3D[] = [];
    this.cube!.traverse((o) => { if ((o as THREE.Mesh).isMesh) occ.push(o); });
    const cam = this.camera, cm = this.cube!.matrixWorld;

    const corners: Corner[] = CUBE_CORNERS.map((c) => {
      const w = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(cm);
      const ndc = w.clone().project(cam);
      const x = ndc.x * 0.5 + 0.5, y = -ndc.y * 0.5 + 0.5;
      const onscreen = x >= 0 && x <= 1 && y >= 0 && y <= 1 && ndc.z < 1;
      let occluded = false;
      if (onscreen) {
        const dir = w.clone().sub(cam.position).normalize();
        this.ray.set(cam.position, dir);
        const hits = this.ray.intersectObjects(occ, false);
        const dist = w.distanceTo(cam.position);
        occluded = hits.length > 0 && hits[0].distance < dist - 0.03;
      }
      return { x: +x.toFixed(4), y: +y.toFixed(4), v: (onscreen && !occluded ? 1 : 0) as 0 | 1 };
    });

    const faces: (0 | 1)[] = CUBE_FACES.map((f) => {
      const wn = new THREE.Vector3(f.n[0], f.n[1], f.n[2]).transformDirection(cm).normalize();
      const wc = new THREE.Vector3(f.n[0] * 0.5, f.n[1] * 0.5, f.n[2] * 0.5).applyMatrix4(cm);
      const toCam = cam.position.clone().sub(wc).normalize();
      return (wn.dot(toCam) > 0.08 ? 1 : 0) as 0 | 1;
    });

    return { corners, faces, scheme: this.lastScheme, present: 1 };
  }

  // Background-only frame (no cube). Populated with a lone hand and/or HARD
  // NEGATIVE distractors — colourful boxes/spheres/cylinders — so the net learns
  // "colourful clutter ≠ a 3×3 Rubik's cube" and stops firing on busy scenes.
  private negativeSample(): Sample {
    this.cube = null;
    this.rig.position.set(0, 0, 0); this.rig.scale.setScalar(1); this.rig.quaternion.identity();
    const D = 3.2 + rng() * 2.6;
    this.camera.position.set(0, 0, D); this.camera.lookAt(0, 0, 0);
    const t = this.tanHalf, ax = t * this.aspect;
    const place = (o: THREE.Object3D, sc: number) => {
      const nx = (rng() * 2 - 1) * 0.75, ny = (rng() * 2 - 1) * 0.75;
      o.position.set(nx * D * ax, ny * D * t, 0);
      o.scale.setScalar(sc);
      o.quaternion.setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6));
    };
    if (rng() < 0.35) { const h = buildHand(rng); place(h, 0.6 + rng() * 0.8); this.rig.add(h); }
    const nd = 1 + ((rng() * 3) | 0);   // 1-3 distractor objects
    for (let i = 0; i < nd; i++) {
      const kind = rng();
      const geo = kind < 0.5 ? new THREE.BoxGeometry(0.5 + rng() * 1.3, 0.5 + rng() * 1.3, 0.5 + rng() * 1.3)
        : kind < 0.8 ? new THREE.SphereGeometry(0.4 + rng() * 0.6, 16, 16)
          : new THREE.CylinderGeometry(0.3 + rng() * 0.4, 0.3 + rng() * 0.4, 0.6 + rng() * 1.0, 16);
      const col = new THREE.Color().setHSL(rng(), 0.4 + rng() * 0.5, 0.35 + rng() * 0.45);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.3 + rng() * 0.5, metalness: 0.03 }));
      place(mesh, 0.7 + rng() * 1.1);
      this.rig.add(mesh);
    }
    this.lights.clear();
    this.lights.add(new THREE.AmbientLight(0xffffff, 0.35 + rng() * 0.5));
    const dl = new THREE.DirectionalLight(0xffffff, 0.5 + rng() * 0.9);
    dl.position.set((rng() - 0.5) * 6, (rng() - 0.5) * 6, 3 + rng() * 4);
    this.lights.add(dl);
    const item = (this.bgItems.length && rng() < 0.92) ? this.bgItems[(rng() * this.bgItems.length) | 0] : null;
    this.scene.background = item ? item.tex : this.proceduralBg();
    this.rig.updateMatrixWorld(true);
    const corners: Corner[] = Array.from({ length: 8 }, () => ({ x: 0.5, y: 0.5, v: 0 as 0 }));
    return { corners, faces: [0, 0, 0, 0, 0, 0], scheme: "black", present: 0 };
  }

  private proceduralBg(): THREE.CanvasTexture {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d")!;
    const mode = (rng() * 3) | 0;
    if (mode === 0) {
      const g = x.createLinearGradient(0, 0, 128, 128 * rng());
      g.addColorStop(0, `hsl(${rng() * 360},${40 + rng() * 50}%,${30 + rng() * 50}%)`);
      g.addColorStop(1, `hsl(${rng() * 360},${40 + rng() * 50}%,${30 + rng() * 50}%)`);
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    } else {
      x.fillStyle = `hsl(${rng() * 360},${rng() * 60}%,${20 + rng() * 60}%)`; x.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 30; i++) {
        x.fillStyle = `hsla(${rng() * 360},${rng() * 80}%,${rng() * 80}%,${0.3 + rng() * 0.5})`;
        x.fillRect(rng() * 128, rng() * 128, 4 + rng() * 40, 4 + rng() * 40);
      }
    }
    return new THREE.CanvasTexture(c);
  }

  private disposeGroup(g: THREE.Object3D) {
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry?.dispose(); const mat = m.material; Array.isArray(mat) ? mat.forEach((x) => x.dispose()) : mat?.dispose(); }
    });
  }

  dispose() { this.renderer.dispose(); }
}
