// 3D cube simulation beside the camera: a Rubik's cube that FILLS IN as faces are
// scanned (indexed by centre colour) and TRACKS the real cube's orientation in real time
// (the "gyroscope"). Self-driven render loop with quaternion slerp for smooth motion.

import * as THREE from "three";
import { colourHex, type CubeColour } from "@/lib/ml/stickerColor";

// face i: outward normal + in-plane axes (u = grid +x, v = grid +y). faceIdx matches
// CubeState.SCHEME (white 0, yellow 1, green 2, blue 3, red 4, orange 5).
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
  private target = new THREE.Quaternion();
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
    this.paintCentres();   // the 6 centres are FIXED and known a priori — show them at once
    this.loop();
  }

  // face i (by SCHEME) owns this centre colour — the standard scheme, always the same
  private static CENTRE: CubeColour[] = ["white", "yellow", "green", "blue", "red", "orange"];
  private paintCentres() {
    CubeSim.CENTRE.forEach((c, fi) => (this.facelets[fi][4].material as THREE.MeshStandardMaterial).color.set(colourHex(c)));
  }

  resize(w: number, h: number) { this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  // Pure renderer: paint a face's 9 cells from the CONFIRMED colours (null → unknown/dark).
  // The temporal voting/consensus lives in CubeState; this just displays it.
  applyFace(fi: number, colours: (CubeColour | null)[]) {
    if (fi < 0 || fi > 5) return;
    for (let k = 0; k < 9; k++) {
      const c = colours[k]; const mesh = this.facelets[fi][k]; if (!mesh) continue;
      (mesh.material as THREE.MeshStandardMaterial).color.set(c ? colourHex(c) : (k === 4 ? colourHex(CubeSim.CENTRE[fi]) : 0x2a2f3a));
    }
  }

  setOrientation(q: { x: number; y: number; z: number; w: number }) { this.target.set(q.x, q.y, q.z, q.w); }
  reset() { for (const f of this.facelets) for (const m of f) (m.material as THREE.MeshStandardMaterial).color.set(0x2a2f3a); this.paintCentres(); }

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
