// Parametric Rubik's cube for synthetic dataset generation.
// Unit cube centred at the origin (edge = 1). Schemes: black-gap, white-gap,
// no-gap. Stickers are randomly coloured (scrambled look).

import * as THREE from "three";

export type Scheme = "black" | "white" | "none";

// 8 cube corners in local space (±0.5), order i*4+j*2+k with i,j,k ∈ {0,1}.
export const CUBE_CORNERS: [number, number, number][] = [];
for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) CUBE_CORNERS.push([x, y, z]);

// 6 faces: outward normal + the 2 in-plane unit axes.
export const CUBE_FACES: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
];

const PALETTE = [0xffffff, 0xffd500, 0xc41e3a, 0xff5800, 0x009e60, 0x0051ba]; // W Y R O G B

export function buildCube(scheme: Scheme, rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = scheme === "white" ? 0xe9e9e9 : 0x0c0c0c;

  // glossy black/white plastic body (visible in the gaps between stickers)
  const bodySize = scheme === "none" ? 0.999 : 0.985;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(bodySize, bodySize, bodySize),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35 + rng() * 0.15, metalness: 0.0, envMapIntensity: 0.9 }),
  );
  body.name = "cube-body";
  g.add(body);

  const step = 1 / 3;
  const sticker = scheme === "none" ? step * 0.99 : step * 0.86; // gap size
  const out = 0.5 + 0.004;
  // slight per-cube gloss so the dataset spans matte→shiny real cubes
  const baseRough = 0.16 + rng() * 0.22;

  CUBE_FACES.forEach((f, fi) => {
    const n = new THREE.Vector3(...f.n), u = new THREE.Vector3(...f.u), v = new THREE.Vector3(...f.v);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const col = new THREE.Color(PALETTE[(rng() * PALETTE.length) | 0]);
        col.offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.06); // subtle real-world variation
        const mat = new THREE.MeshStandardMaterial({
          color: col, roughness: baseRough + (rng() - 0.5) * 0.08, metalness: 0.0, envMapIntensity: 1.1,
        });
        // rounded sticker (real cubes have rounded-corner stickers with a bevel gap)
        const geo = new THREE.PlaneGeometry(sticker, sticker);
        const plane = new THREE.Mesh(geo, mat);
        const pos = new THREE.Vector3()
          .addScaledVector(n, out)
          .addScaledVector(u, i * step)
          .addScaledVector(v, j * step);
        plane.position.copy(pos);
        plane.lookAt(pos.clone().add(n));
        plane.name = "sticker";
        plane.userData = { face: fi, gi: i, gj: j };   // for sticker-centre labels
        g.add(plane);
      }
  });
  return g;
}
