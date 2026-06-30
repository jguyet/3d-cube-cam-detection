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
}

let seed = 1234567;
function rng(): number { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
export function reseed(s: number) { seed = s >>> 0 || 1; }

const SCHEMES: Scheme[] = ["black", "white", "none"];

export class DatasetEngine {
  readonly size: number;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig = new THREE.Group();      // holds cube + hands; gets the random pose
  private cube: THREE.Group | null = null;
  private lights = new THREE.Group();
  private ray = new THREE.Raycaster();
  private bgItems: BgItem[] = [];
  private lastScheme: Scheme = "black";

  constructor(canvas: HTMLCanvasElement, size = 256) {
    this.size = size;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(size, size, false);
    this.renderer.setPixelRatio(1);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.scene.add(this.rig);
    this.scene.add(this.lights);
  }

  setBackgrounds(items: BgItem[]) { this.bgItems = items; }

  randomize(): Sample {
    // ---- cube + scheme ----
    if (this.cube) { this.rig.remove(this.cube); this.disposeGroup(this.cube); }
    this.rig.clear();
    const scheme = SCHEMES[(rng() * SCHEMES.length) | 0];
    this.lastScheme = scheme;
    this.cube = buildCube(scheme, rng);
    this.rig.add(this.cube);

    // ---- hands (0-2) gripping the cube ----
    const nHands = rng() < 0.85 ? 1 : (rng() < 0.5 ? 0 : 2);
    for (let i = 0; i < nHands; i++) {
      const h = buildHand(rng);
      if (i === 1) h.scale.x *= -1; // mirror for a second hand
      this.cube.add(h);
    }

    // ---- random rotation ----
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (rng() - 0.5) * Math.PI * 1.2, rng() * Math.PI * 2, (rng() - 0.5) * Math.PI * 0.6));
    this.rig.quaternion.copy(q);

    // ---- lights ----
    this.lights.clear();
    this.lights.add(new THREE.AmbientLight(0xffffff, 0.25 + rng() * 0.5));
    const nL = 1 + ((rng() * 2) | 0);
    for (let i = 0; i < nL; i++) {
      const col = new THREE.Color().setHSL(rng(), 0.2 + rng() * 0.5, 0.5 + rng() * 0.3);
      const dl = new THREE.DirectionalLight(col, 0.5 + rng() * 1.2);
      dl.position.set((rng() - 0.5) * 6, (rng() - 0.5) * 6, 2 + rng() * 5);
      this.lights.add(dl);
    }

    // ---- background + placement ----
    // When the background carries the original cube's bbox, place our cube over
    // it (covers the blurred-out zone, realistic location). Otherwise random.
    const item = (this.bgItems.length && rng() < 0.92) ? this.bgItems[(rng() * this.bgItems.length) | 0] : null;
    this.scene.background = item ? item.tex : this.proceduralBg();
    const t = Math.tan((35 * Math.PI / 180) / 2);
    if (item && item.bbox) {
      const D = 4 + rng() * 2, b = item.bbox;
      const jx = (rng() - 0.5) * 0.04, jy = (rng() - 0.5) * 0.04, js = 0.9 + rng() * 0.35;
      this.camera.position.set(0, 0, D); this.camera.lookAt(0, 0, 0);
      this.rig.position.set((2 * (b.cx + jx) - 1) * D * t, (1 - 2 * (b.cy + jy)) * D * t, 0);
      this.rig.scale.setScalar(Math.max(b.w, b.h) * 2 * D * t / 1.3 * js);
    } else {
      const D = 3.2 + rng() * 2.2;
      this.camera.position.set(0, 0, D); this.camera.lookAt(0, 0, 0);
      this.rig.scale.setScalar(0.85 + rng() * 0.7);
      this.rig.position.set((rng() - 0.5) * 1.4, (rng() - 0.5) * 1.0, 0);
    }

    this.rig.updateMatrixWorld(true);
    return this.labels();
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

    return { corners, faces, scheme: this.lastScheme };
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
