// 3D cube simulation beside the camera: a Rubik's cube that FILLS IN as faces are
// scanned (indexed by centre colour) and TRACKS the real cube's orientation in real time
// (the "gyroscope"). Self-driven render loop with quaternion slerp for smooth motion.

import * as THREE from "three";
import { colourHex, type CubeColour } from "@/lib/ml/stickerColor";

// standard scheme: each centre colour owns one cube face
const SCHEME: Record<string, number> = { white: 0, yellow: 1, green: 2, blue: 3, red: 4, orange: 5 };
// face i: outward normal + in-plane axes (u = grid +x, v = grid +y)
const FACES: { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }[] = [
  { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },   // 0 white  (U +y)
  { n: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1) },  // 1 yellow (D -y)
  { n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, -1, 0) },   // 2 green  (F +z)
  { n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, -1, 0) }, // 3 blue   (B -z)
  { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, -1, 0) },  // 4 red    (R +x)
  { n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, -1, 0) },  // 5 orange (L -x)
];

export class CubeSim {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private group: THREE.Group;
  private facelets: THREE.Mesh[][] = [];      // [faceIdx][cell 0..8]
  private state: (CubeColour | null)[][] = Array.from({ length: 6 }, () => Array(9).fill(null));
  private target = new THREE.Quaternion();
  private scanned = new Set<number>();
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.2);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(2, 3, 4); this.scene.add(dir);

    this.group = new THREE.Group(); this.scene.add(this.group);
    // black body
    this.group.add(new THREE.Mesh(new THREE.BoxGeometry(0.99, 0.99, 0.99), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })));
    // facelets
    const step = 1 / 3, size = step * 0.86, out = 0.502;
    const geo = new THREE.PlaneGeometry(size, size);
    FACES.forEach((f, fi) => {
      this.facelets[fi] = [];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.45, side: THREE.DoubleSide });
        const m = new THREE.Mesh(geo, mat);
        const pos = f.n.clone().multiplyScalar(out)
          .add(f.u.clone().multiplyScalar((i - 1) * step))
          .add(f.v.clone().multiplyScalar((j - 1) * step));
        m.position.copy(pos);
        m.lookAt(pos.clone().add(f.n));
        this.group.add(m); this.facelets[fi][i + j * 3] = m;
      }
    });
    this.loop();
  }

  resize(w: number, h: number) { this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  private CUBE = new Set<CubeColour>(["white", "yellow", "red", "orange", "green", "blue"]);

  // colour one face from a scan (cells ordered by gx + gy*3); centre colour selects it.
  // Only real cube colours are stored/painted — completion only ever grows.
  setFace(centre: CubeColour, cells: CubeColour[]) {
    const fi = SCHEME[centre]; if (fi === undefined) return;
    this.scanned.add(fi);
    for (let k = 0; k < 9 && k < cells.length; k++) {
      const c = cells[k]; if (!this.CUBE.has(c)) continue;
      this.state[fi][k] = c;
      const mesh = this.facelets[fi][k]; if (mesh) (mesh.material as THREE.MeshStandardMaterial).color.set(colourHex(c));
    }
  }

  // fraction of the 54 stickers known
  completion(): number { let n = 0; for (const f of this.state) for (const c of f) if (c) n++; return n / 54; }

  colourCounts(): Record<string, number> {
    const m: Record<string, number> = {};
    for (const f of this.state) for (const c of f) if (c) m[c] = (m[c] ?? 0) + 1;
    return m;
  }

  // Rubik LAWS: every colour appears EXACTLY 9× (≤9 while scanning); centres all distinct
  // (guaranteed by the scheme). Returns a status + reason for the UI.
  validity(): { status: "valid" | "invalid" | "partial"; msg: string } {
    const m = this.colourCounts();
    for (const c of Object.keys(m)) if (m[c] > 9) return { status: "invalid", msg: `trop de ${c} (${m[c]}/9)` };
    let filled = 0; for (const c of Object.keys(m)) filled += m[c];
    if (filled === 54) return { status: "valid", msg: "cube complet & valide ✓" };
    return { status: "partial", msg: `${Object.keys(m).length}/6 couleurs vues` };
  }

  setOrientation(q: { x: number; y: number; z: number; w: number }) { this.target.set(q.x, q.y, q.z, q.w); }
  scannedCount() { return this.scanned.size; }
  reset() { this.scanned.clear(); this.state = Array.from({ length: 6 }, () => Array(9).fill(null)); for (const f of this.facelets) for (const m of f) (m.material as THREE.MeshStandardMaterial).color.set(0x2a2f3a); }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.group.quaternion.slerp(this.target, 0.2);   // smooth gyroscope
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); });
  }
}
