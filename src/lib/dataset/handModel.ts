// Procedural "hand" occluders gripping the cube (parented to the cube so they
// co-rotate). Not anatomically perfect — the goal is realistic partial sticker/
// corner occlusion for domain randomisation.

import * as THREE from "three";

const SKIN = [0xe8b48f, 0xd99e76, 0xc98a5e, 0x8d5a3b, 0xf0c8a0, 0xb07a52];

function finger(skin: number, len: number, rad: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CapsuleGeometry(rad, len, 4, 8),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75 }),
  );
  return m;
}

// Builds a hand gripping one side of the unit cube. Returns a group in cube-local
// space. `rng` drives all randomisation.
export function buildHand(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const skin = SKIN[(rng() * SKIN.length) | 0];

  // pick a grip side (which face the palm is behind) and an up axis
  const sides = [
    { n: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) }, // from below
    { n: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },  // from right
    { n: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) }, // from left
  ];
  const side = sides[(rng() * sides.length) | 0];
  const n = side.n, up = side.up;
  const tangent = new THREE.Vector3().crossVectors(n, up).normalize();

  // palm: a flattened box just outside the grip face
  const palm = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.95, 0.42),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.8 }),
  );
  const palmPos = n.clone().multiplyScalar(0.62);
  palm.position.copy(palmPos);
  palm.lookAt(palmPos.clone().add(n));
  palm.rotateZ((rng() - 0.5) * 0.5);
  g.add(palm);

  // 3-4 fingers curling from the palm over the near edge onto the front (+z) face
  const nFingers = 3 + ((rng() * 2) | 0);
  for (let i = 0; i < nFingers; i++) {
    const f = finger(skin, 0.55 + rng() * 0.35, 0.085 + rng() * 0.03);
    const spread = (i - (nFingers - 1) / 2) * (0.22 + rng() * 0.05);
    // start near the grip edge, point toward +z (front) crossing the cube
    const base = n.clone().multiplyScalar(0.5)
      .add(up.clone().multiplyScalar(0.45 - rng() * 0.2))
      .add(tangent.clone().multiplyScalar(spread))
      .add(new THREE.Vector3(0, 0, 0.15));
    f.position.copy(base);
    // orient the capsule (its length is along local Y) toward the front, with curl
    const dir = new THREE.Vector3(0, 0, 1).add(n.clone().multiplyScalar(-0.4)).add(up.clone().multiplyScalar(-0.3 - rng() * 0.4)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    f.quaternion.copy(q);
    g.add(f);
  }

  // thumb on the opposite edge
  const thumb = finger(skin, 0.5 + rng() * 0.25, 0.1);
  const tbase = n.clone().multiplyScalar(0.5).add(up.clone().multiplyScalar(-0.45)).add(new THREE.Vector3(0, 0, 0.1));
  thumb.position.copy(tbase);
  const tdir = new THREE.Vector3(0, 0, 1).add(up.clone().multiplyScalar(0.5)).normalize();
  thumb.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tdir));
  g.add(thumb);

  g.traverse((o) => { o.name = "hand"; });
  return g;
}
