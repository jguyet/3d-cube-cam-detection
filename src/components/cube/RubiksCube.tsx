"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import CubeScene, { type CubeController } from "./CubeScene";
import { invertAlgorithm, parseAlgorithm } from "@/lib/cube/notation";

interface RubiksCubeProps {
  /** The algorithm to teach, in standard notation. */
  algorithm: string;
  /**
   * Optional explicit setup. If omitted, the inverse of the algorithm is used,
   * which guarantees the cube returns to solved when the algorithm is played.
   */
  setup?: string;
  /**
   * Optional mid-solve context applied before the inverse in "case" mode, so
   * the demo ends in a realistic unsolved state instead of a finished cube.
   */
  context?: string;
  className?: string;
}

const SPEEDS = [
  { label: "Lent", value: 1.2 },
  { label: "Normal", value: 2.4 },
  { label: "Rapide", value: 4 },
];

export default function RubiksCube({ algorithm, setup, context, className }: RubiksCubeProps) {
  const ctrl = useRef<CubeController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [mounted, setMounted] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  // "apply" = start solved and apply the algorithm (see its effect).
  // "case"  = start from the case (inverse) and let the algorithm solve it.
  const [mode, setMode] = useState<"apply" | "case">("apply");

  // The WebGL canvas is client-only — avoid rendering it during SSR.
  useEffect(() => setMounted(true), []);

  const caseSetup =
    setup ??
    (context ? `${context} ${invertAlgorithm(algorithm)}` : invertAlgorithm(algorithm));
  const resolvedSetup = mode === "case" ? caseSetup : "";
  const tokens = parseAlgorithm(algorithm).map((s) => s.token);

  // Push setup + speed to the controller whenever they change.
  useEffect(() => {
    ctrl.current?.setSetup(resolvedSetup);
  }, [resolvedSetup]);

  useEffect(() => {
    ctrl.current?.setSpeed(SPEEDS[speedIdx].value);
  }, [speedIdx]);

  return (
    <div className={className}>
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 ring-1 ring-white/10">
        {mounted && (
          <Canvas camera={{ position: [4.2, 3.6, 5.2], fov: 38 }} dpr={[1, 2]}>
            <CubeScene
              setup={resolvedSetup}
              onReady={(c) => {
                ctrl.current = c;
                c.setSpeed(SPEEDS[speedIdx].value);
              }}
              onPlayingChange={setPlaying}
              onStep={setActiveStep}
            />
          </Canvas>
        )}
        {!mounted && (
          <div className="flex h-full items-center justify-center text-sm text-white/40">
            Chargement du cube 3D…
          </div>
        )}
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/40 px-2.5 py-1 text-xs font-medium text-white/70 backdrop-blur">
          Glisse pour tourner le cube
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/40 px-2.5 py-1 text-xs font-medium text-white/80 backdrop-blur">
          {mode === "apply" ? "Départ : cube résolu" : "Départ : le cas à résoudre"}
        </div>
      </div>

      {/* Mode selector — what the demo starts from */}
      <div className="mt-3 inline-flex rounded-lg bg-slate-100 p-0.5 text-xs ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        <button
          onClick={() => setMode("apply")}
          className={`rounded-md px-3 py-1.5 font-semibold transition ${
            mode === "apply"
              ? "bg-white text-indigo-600 shadow dark:bg-slate-600 dark:text-white"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
          }`}
        >
          Voir l&apos;effet de l&apos;algo
        </button>
        <button
          onClick={() => setMode("case")}
          className={`rounded-md px-3 py-1.5 font-semibold transition ${
            mode === "case"
              ? "bg-white text-indigo-600 shadow dark:bg-slate-600 dark:text-white"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
          }`}
        >
          Résoudre le cas
        </button>
      </div>

      {/* Notation — the active move lights up in sync with the cube */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {tokens.map((t, i) => {
          const active = i === activeStep;
          return (
            <span
              key={i}
              className={`rounded-md px-2 py-1 font-mono text-sm font-semibold ring-1 transition-colors ${
                active
                  ? "scale-105 bg-indigo-600 text-white ring-indigo-600 shadow-sm"
                  : "bg-slate-100 text-slate-800 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
              }`}
            >
              {t}
            </span>
          );
        })}
      </div>

      {/* Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => ctrl.current?.play(algorithm)}
          disabled={playing}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlayIcon /> {playing ? "Lecture…" : "Jouer l'algo"}
        </button>
        <button
          onClick={() => ctrl.current?.reset()}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
        >
          <ResetIcon /> Réinitialiser
        </button>

        <div className="ml-auto inline-flex rounded-lg bg-slate-100 p-0.5 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          {SPEEDS.map((s, i) => (
            <button
              key={s.label}
              onClick={() => setSpeedIdx(i)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                i === speedIdx
                  ? "bg-white text-indigo-600 shadow dark:bg-slate-600 dark:text-white"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
