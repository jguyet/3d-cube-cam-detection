// Synthetic dataset engine (three.js). Renders a randomised cube (scheme,
// pose, lights, background, hands) and computes per-sample labels:
//   - 8 cube corners: normalised (x,y) + visibility (on-screen & not occluded)
//   - 6 faces: visibility (camera-facing)
// Domain randomisation -> a small net can learn cube pose + faces from this.

import * as THREE from "three";
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
  private lights = new THREE.Group();
  private ray = new THREE.Raycaster();
  private bgItems: BgItem[] = [];
  private lastScheme: Scheme = "black";

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
    this.scene.add(this.lights);
  }

  setBackgrounds(items: BgItem[]) { this.bgItems = items; }

  randomize(): Sample {
    if (this.cube) { this.rig.remove(this.cube); this.disposeGroup(this.cube); this.cube = null; }
    this.rig.clear();

    // ~18% NEGATIVE frames: a realistic background (sometimes a lone hand) and
    // NO cube. Teaches the net "no cube here" so it stops firing on everything.
    if (rng() < 0.18) return this.negativeSample();

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
    if (this.cube) { this.rig.remove(this.cube); this.disposeGroup(this.cube); }
    this.rig.clear();
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

  // Background-only frame (no cube), sometimes with a lone floating hand so the
  // net learns skin/hands aren't cubes. Labels: present=0, all corners hidden.
  private negativeSample(): Sample {
    this.cube = null;
    if (rng() < 0.4) {
      const h = buildHand(rng);
      h.position.set((rng() - 0.5) * 1.5, (rng() - 0.5) * 1.2, 0);
      h.scale.setScalar(0.6 + rng() * 0.8);
      this.rig.add(h);
    }
    this.rig.quaternion.copy(new THREE.Quaternion().setFromEuler(
      new THREE.Euler((rng() - 0.5) * 2, rng() * Math.PI * 2, (rng() - 0.5) * 2)));
    this.lights.clear();
    this.lights.add(new THREE.AmbientLight(0xffffff, 0.4 + rng() * 0.5));
    const dl = new THREE.DirectionalLight(0xffffff, 0.5 + rng() * 0.8);
    dl.position.set((rng() - 0.5) * 6, (rng() - 0.5) * 6, 3 + rng() * 4);
    this.lights.add(dl);
    const item = (this.bgItems.length && rng() < 0.92) ? this.bgItems[(rng() * this.bgItems.length) | 0] : null;
    this.scene.background = item ? item.tex : this.proceduralBg();
    this.camera.position.set(0, 0, 3.5 + rng() * 2.5); this.camera.lookAt(0, 0, 0);
    this.rig.position.set((rng() - 0.5) * 1.2, (rng() - 0.5) * 0.9, 0);
    this.rig.scale.setScalar(0.8 + rng() * 0.6);
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
