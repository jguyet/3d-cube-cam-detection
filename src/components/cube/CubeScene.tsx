"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { parseAlgorithm, type MoveStep } from "@/lib/cube/notation";
import { faceletIndex, FACELET_COLOR, type Dir } from "@/lib/cube/faceletMap";

// Standard speedcubing orientation: yellow on top (the last-layer face for
// OLL/PLL), white on the bottom, green front, blue back, red right, orange left.
const COLORS = {
  R: "#d50000", // right  - red
  L: "#ff7100", // left   - orange
  U: "#ffd500", // up     - yellow
  D: "#ffffff", // down   - white
  F: "#00a651", // front  - green
  B: "#0047ab", // back   - blue
  body: "#15151a",
};

// Cubie body is 0.96 wide (half = 0.48); place stickers just proud of the
// surface to avoid z-fighting with the rounded box faces.
const STICKER = 0.502;

interface StickerDef {
  dir: Dir;
  pos: [number, number, number];
  rot: [number, number, number];
  color: string;
}

// Build sticker definitions for a cubie at its SOLVED logical position.
function stickersFor(x: number, y: number, z: number): StickerDef[] {
  const s: StickerDef[] = [];
  if (x === 1) s.push({ dir: "R", pos: [STICKER, 0, 0], rot: [0, Math.PI / 2, 0], color: COLORS.R });
  if (x === -1) s.push({ dir: "L", pos: [-STICKER, 0, 0], rot: [0, -Math.PI / 2, 0], color: COLORS.L });
  if (y === 1) s.push({ dir: "U", pos: [0, STICKER, 0], rot: [-Math.PI / 2, 0, 0], color: COLORS.U });
  if (y === -1) s.push({ dir: "D", pos: [0, -STICKER, 0], rot: [Math.PI / 2, 0, 0], color: COLORS.D });
  if (z === 1) s.push({ dir: "F", pos: [0, 0, STICKER], rot: [0, 0, 0], color: COLORS.F });
  if (z === -1) s.push({ dir: "B", pos: [0, 0, -STICKER], rot: [0, Math.PI, 0], color: COLORS.B });
  return s;
}

interface Cubie {
  solved: THREE.Vector3; // immutable solved position (for sticker colouring)
  pos: THREE.Vector3; // current logical position (-1,0,1 components)
  orientation: THREE.Quaternion; // current orientation
  group: THREE.Group | null;
}

const AXES: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

export interface CubeController {
  play: (algorithm: string) => void;
  reset: () => void;
  setSetup: (setup: string) => void;
  setSpeed: (turnsPerSecond: number) => void;
  /** Colour the cube from a 54-char Kociemba facelet string (live mirror). */
  setFacelets: (facelets: string) => void;
  /** Append moves to the animation queue without resetting (live mirror mode). */
  queueMoves: (notation: string) => void;
}

interface CubeSceneProps {
  /** Notation applied instantly to create the starting case. */
  setup: string;
  /** Registers imperative controls with the parent. */
  onReady: (ctrl: CubeController) => void;
  /** Fired when the playing state changes. */
  onPlayingChange?: (playing: boolean) => void;
  /** Fired with the index of the move currently executing (null when idle). */
  onStep?: (index: number | null) => void;
}

const HIGHLIGHT = new THREE.Color(0x6366f1);
const NO_EMISSIVE = new THREE.Color(0x000000);

/** Toggle a soft glow on every mesh of a cubie group. */
function setHighlight(group: THREE.Group | null, on: boolean) {
  if (!group) return;
  group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      mat.emissive.copy(on ? HIGHLIGHT : NO_EMISSIVE);
      mat.emissiveIntensity = on ? 0.45 : 1;
    }
  });
}

export default function CubeScene({ setup, onReady, onPlayingChange, onStep }: CubeSceneProps) {
  // Build the 27 cubies once.
  const cubies = useMemo<Cubie[]>(() => {
    const list: Cubie[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          list.push({
            solved: new THREE.Vector3(x, y, z),
            pos: new THREE.Vector3(x, y, z),
            orientation: new THREE.Quaternion(),
            group: null,
          });
        }
    return list;
  }, []);

  // Animation state held in refs (lives across frames without re-render).
  const queue = useRef<MoveStep[]>([]);
  const current = useRef<{
    step: MoveStep;
    axisVec: THREE.Vector3;
    target: number;
    angle: number;
    affected: Cubie[];
  } | null>(null);
  const speed = useRef(2.2); // turns per second
  const setupRef = useRef(setup);
  const playingRef = useRef(false);
  const playedCount = useRef(0); // index of the move within the current play

  // Reusable temporaries to avoid per-frame allocations.
  const tmpQuat = useRef(new THREE.Quaternion());
  const tmpVec = useRef(new THREE.Vector3());

  // Sticker materials, keyed by `${cubieIndex}:${dir}`, for live recolouring.
  const stickerMats = useRef(new Map<string, THREE.MeshStandardMaterial>());

  const syncMesh = (c: Cubie) => {
    if (!c.group) return;
    c.group.position.copy(c.pos);
    c.group.quaternion.copy(c.orientation);
  };

  // Instantly apply a move to the logical model (used for setup / reset).
  const applyInstant = (step: MoveStep) => {
    const axisVec = AXES[step.axis];
    const q = new THREE.Quaternion().setFromAxisAngle(axisVec, step.angle);
    for (const c of cubies) {
      if (step.layers.includes(Math.round(c.pos.getComponent(axisIndex(step.axis))))) {
        c.pos.applyQuaternion(q).round();
        c.orientation.premultiply(q).normalize();
      }
    }
  };

  const resetTo = (setupStr: string) => {
    // Clear any in-flight highlight.
    if (current.current) for (const c of current.current.affected) setHighlight(c.group, false);
    queue.current = [];
    current.current = null;
    playedCount.current = 0;
    for (const c of cubies) {
      c.pos.copy(c.solved);
      c.orientation.identity();
    }
    for (const step of parseAlgorithm(setupStr)) applyInstant(step);
    for (const c of cubies) syncMesh(c);
    onStep?.(null);
    if (playingRef.current) {
      playingRef.current = false;
      onPlayingChange?.(false);
    }
  };

  // Register the controller.
  useEffect(() => {
    const ctrl: CubeController = {
      play: (algorithm: string) => {
        // Restart from the case, then enqueue the algorithm.
        resetTo(setupRef.current);
        queue.current = parseAlgorithm(algorithm);
        playedCount.current = 0;
        if (queue.current.length && !playingRef.current) {
          playingRef.current = true;
          onPlayingChange?.(true);
        }
      },
      reset: () => resetTo(setupRef.current),
      setSetup: (s: string) => {
        setupRef.current = s;
        resetTo(s);
      },
      setSpeed: (t: number) => {
        speed.current = t;
      },
      queueMoves: (notation: string) => {
        const steps = parseAlgorithm(notation);
        if (!steps.length) return;
        queue.current.push(...steps);
        if (!playingRef.current) {
          playingRef.current = true;
          onPlayingChange?.(true);
        }
      },
      setFacelets: (facelets: string) => {
        if (facelets.length < 54) return;
        // Snap to solved (identity) so each sticker faces its own direction…
        if (current.current) for (const c of current.current.affected) setHighlight(c.group, false);
        queue.current = [];
        current.current = null;
        for (const c of cubies) {
          c.pos.copy(c.solved);
          c.orientation.identity();
          syncMesh(c);
        }
        // …then colour every sticker from the facelet string.
        const FACES: Dir[] = ["U", "R", "F", "D", "L", "B"];
        cubies.forEach((c, i) => {
          for (const dir of FACES) {
            const idx = faceletIndex(dir, c.solved.x, c.solved.y, c.solved.z);
            if (idx === undefined) continue;
            // Unknown facelets (not yet observed) render as neutral grey.
            const color = FACELET_COLOR[facelets[idx]] ?? "#2a2a30";
            const mat = stickerMats.current.get(`${i}:${dir}`);
            if (mat) mat.color.set(color);
          }
        });
        if (playingRef.current) {
          playingRef.current = false;
          onPlayingChange?.(false);
        }
      },
    };
    onReady(ctrl);
    resetTo(setupRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply when the setup prop changes (navigating between algos).
  useEffect(() => {
    setupRef.current = setup;
    resetTo(setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  useFrame((_, delta) => {
    // Start the next move if idle.
    if (!current.current && queue.current.length > 0) {
      const step = queue.current.shift()!;
      const idx = axisIndex(step.axis);
      const affected = cubies.filter((c) =>
        step.layers.includes(Math.round(c.pos.getComponent(idx))),
      );
      current.current = {
        step,
        axisVec: AXES[step.axis],
        target: step.angle,
        angle: 0,
        affected,
      };
      // Highlight the turning layer and report the active move.
      for (const c of affected) setHighlight(c.group, true);
      onStep?.(playedCount.current);
    }

    const cur = current.current;
    if (!cur) return;

    // Advance angle. Speed scales with the magnitude (180° takes ~2x longer).
    const dir = Math.sign(cur.target) || 1;
    const step = speed.current * Math.PI * delta; // radians/sec
    cur.angle += dir * step;

    const done = Math.abs(cur.angle) >= Math.abs(cur.target);
    const angleNow = done ? cur.target : cur.angle;

    const q = tmpQuat.current.setFromAxisAngle(cur.axisVec, angleNow);
    for (const c of cur.affected) {
      if (!c.group) continue;
      // position = rest position rotated about the pivot axis
      tmpVec.current.copy(c.pos).applyQuaternion(q);
      c.group.position.copy(tmpVec.current);
      // orientation = pivot rotation composed with resting orientation
      c.group.quaternion.copy(q).multiply(c.orientation);
    }

    if (done) {
      // Bake the rotation into the logical model.
      const qf = new THREE.Quaternion().setFromAxisAngle(cur.axisVec, cur.target);
      for (const c of cur.affected) {
        c.pos.applyQuaternion(qf).round();
        c.orientation.premultiply(qf).normalize();
        setHighlight(c.group, false);
        syncMesh(c);
      }
      current.current = null;
      playedCount.current += 1;
      if (queue.current.length === 0 && playingRef.current) {
        playingRef.current = false;
        playedCount.current = 0;
        onPlayingChange?.(false);
        onStep?.(null);
      }
    }
  });

  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[5, 8, 6]} intensity={1.1} />
      <directionalLight position={[-6, -3, -5]} intensity={0.4} />
      <group rotation={[0.45, -0.6, 0]}>
        {cubies.map((c, i) => (
          <group
            key={i}
            ref={(el) => {
              c.group = el;
              if (el) syncMesh(c);
            }}
          >
            <RoundedBox args={[0.96, 0.96, 0.96]} radius={0.08} smoothness={3}>
              <meshStandardMaterial color={COLORS.body} roughness={0.4} metalness={0.1} />
            </RoundedBox>
            {stickersFor(c.solved.x, c.solved.y, c.solved.z).map((s) => (
              <mesh key={s.dir} position={s.pos} rotation={s.rot}>
                <planeGeometry args={[0.8, 0.8]} />
                <meshStandardMaterial
                  color={s.color}
                  roughness={0.35}
                  ref={(m) => {
                    if (m) stickerMats.current.set(`${i}:${s.dir}`, m as THREE.MeshStandardMaterial);
                  }}
                />
              </mesh>
            ))}
          </group>
        ))}
      </group>
      <OrbitControls enablePan={false} minDistance={4} maxDistance={12} enableDamping />
    </>
  );
}

function axisIndex(axis: string): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}
