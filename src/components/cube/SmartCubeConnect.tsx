"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import CubeScene, { type CubeController } from "./CubeScene";
import FaceletEditor from "./FaceletEditor";
import { readGan356iFacelets } from "@/lib/cube/gan356i";

type Status = "idle" | "connecting" | "connected" | "error";

const SOLVED = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

// Loose shape of a cubing.js BluetoothPuzzle (typed minimally; imported dynamically).
interface SmartPuzzle {
  name?: () => string | undefined;
  disconnect: () => void;
  reset?: () => Promise<void>;
  addAlgLeafListener: (l: (e: { latestAlgLeaf: unknown }) => void) => void;
  addOrientationListener?: (
    l: (e: { quaternion: { x: number; y: number; z: number; w: number } }) => void,
  ) => void;
  // GAN 356 i internals (present at runtime on the GanCube instance).
  server?: BluetoothRemoteGATTServer;
  readFaceletStatus1Characteristic?: () => Promise<ArrayBufferLike>;
}

export default function SmartCubeConnect() {
  const puzzle = useRef<SmartPuzzle | null>(null);
  const ctrl = useRef<CubeController | null>(null);

  const [mounted, setMounted] = useState(false);
  const [supported, setSupported] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [moves, setMoves] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [debug, setDebug] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const lastFacelets = useRef(SOLVED);

  const dbg = (s: string) => setDebug((d) => [...d, s].slice(-10));

  useEffect(() => {
    setMounted(true);
    setSupported(typeof navigator !== "undefined" && "bluetooth" in navigator);
    return () => {
      try {
        puzzle.current?.disconnect();
      } catch {}
    };
  }, []);

  // Read the cube's tracked state and paint the 3D cube with it.
  const applyRealState = async () => {
    const gan = puzzle.current;
    if (!gan?.readFaceletStatus1Characteristic || !gan.server || !ctrl.current) return;
    try {
      const { facelets, info } = await readGan356iFacelets({
        server: gan.server,
        readFaceletStatus1Characteristic: gan.readFaceletStatus1Characteristic.bind(gan),
      });
      dbg(`stickers ${info.counts} ${info.ok ? "✅" : "⚠️ invalide"}`);
      dbg("facelets " + facelets);
      if (info.ok) {
        lastFacelets.current = facelets;
        ctrl.current.setFacelets(facelets);
      }
    } catch (e) {
      dbg("ERREUR: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const connect = async () => {
    setError(null);
    setStatus("connecting");
    setDebug([]);
    try {
      const { connectSmartPuzzle } = await import("cubing/bluetooth");
      const p = (await connectSmartPuzzle()) as unknown as SmartPuzzle;
      puzzle.current = p;
      setName(p.name?.() ?? "Cube connecté");
      setMoves([]);
      setCount(0);
      setStatus("connected");

      await applyRealState();

      p.addAlgLeafListener((e) => {
        const leaf = e.latestAlgLeaf as { toString?: () => string };
        const mv = String(leaf?.toString?.() ?? leaf);
        if (!mv) return;
        setMoves((m) => [mv, ...m].slice(0, 60));
        setCount((c) => c + 1);
        ctrl.current?.queueMoves(mv);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|user|chooser/i.test(msg)) setStatus("idle");
      else {
        setError(msg);
        setStatus("error");
      }
      puzzle.current = null;
    }
  };

  const disconnect = () => {
    try {
      puzzle.current?.disconnect();
    } catch {}
    puzzle.current = null;
    setStatus("idle");
  };

  // Physical cube is solved → reset both the 3D cube and the cube's reference.
  const markSolved = () => {
    lastFacelets.current = SOLVED;
    ctrl.current?.setFacelets(SOLVED);
    try {
      puzzle.current?.reset?.();
    } catch {}
    setMoves([]);
    setCount(0);
  };

  // Manual resync: paint the real state and apply it to the 3D mirror.
  const applyManual = (facelets: string) => {
    lastFacelets.current = facelets;
    ctrl.current?.setFacelets(facelets);
    setMoves([]);
    setCount(0);
    setEditing(false);
  };

  if (!supported) {
    return (
      <div className="rounded-2xl bg-amber-50 p-6 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
        <h3 className="font-bold">Web Bluetooth non disponible</h3>
        <p className="mt-2 text-sm">
          Utilise <strong>Chrome</strong>, <strong>Edge</strong> ou <strong>Opera</strong> sur
          ordinateur ou Android. Safari, Firefox et iOS ne sont pas compatibles.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left: controls + live data */}
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          {status !== "connected" ? (
            <button
              onClick={connect}
              disabled={status === "connecting"}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
            >
              <BluetoothIcon className="h-5 w-5" />
              {status === "connecting" ? "Connexion…" : "Connecter mon cube"}
            </button>
          ) : (
            <>
              <button
                onClick={disconnect}
                className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
              >
                Déconnecter
              </button>
              <button
                onClick={applyRealState}
                className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500"
                title="Relire l'état suivi par le cube et le réafficher"
              >
                Lire l&apos;état du cube
              </button>
              <button
                onClick={markSolved}
                className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                title="Quand ton cube physique est résolu, clique ici pour recaler la référence"
              >
                Mon cube est résolu ✓
              </button>
            </>
          )}
          <StatusBadge status={status} />
        </div>

        {status === "connected" ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900">
              Le cube 3D affiche l&apos;<strong>état suivi</strong> par ton cube. Le 356 i n&apos;a
              pas de capteurs de couleur&nbsp;: il déduit l&apos;état des mouvements. S&apos;il est
              décalé (ex. batterie vidée), resynchronise&nbsp;:
              <strong> « Mon cube est résolu&nbsp;✓ »</strong> (si tu le résous), ou saisis
              l&apos;état à la main ci-dessous.
            </div>
            <button
              onClick={() => setEditing((v) => !v)}
              className="text-sm font-semibold text-indigo-600 transition hover:text-indigo-500 dark:text-indigo-400"
            >
              {editing ? "← Masquer la saisie manuelle" : "Mon cube est désynchronisé → saisir l'état à la main"}
            </button>
            {editing && (
              <FaceletEditor
                initial={lastFacelets.current}
                onApply={applyManual}
                onCancel={() => setEditing(false)}
              />
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Connexion <strong>100 % automatique</strong> — aucune adresse MAC à saisir. Compatible
            GAN, GiiKER et GoCube.
          </p>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
            {error}
          </p>
        )}

        {status === "connected" && (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Appareil" value={name || "—"} />
            <Info label="Coups détectés" value={String(count)} />
          </dl>
        )}

        {debug.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded-xl bg-slate-950 p-3 text-[10px] leading-relaxed text-slate-200">
            {debug.join("\n")}
          </pre>
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            Flux des mouvements
          </h3>
          <div className="flex min-h-[3rem] flex-wrap gap-1.5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            {moves.length === 0 ? (
              <span className="text-sm text-slate-400">
                {status === "connected"
                  ? "Tourne une face de ton cube…"
                  : "Connecte ton cube pour voir tes mouvements en direct."}
              </span>
            ) : (
              moves.map((m, i) => (
                <span
                  key={count - i}
                  className={`rounded-md px-2 py-1 font-mono text-sm font-semibold ring-1 ${
                    i === 0
                      ? "bg-indigo-600 text-white ring-indigo-600"
                      : "bg-white text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
                  }`}
                >
                  {m}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right: live 3D mirror */}
      <div>
        <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 ring-1 ring-white/10">
          {mounted && (
            <Canvas camera={{ position: [4.2, 3.6, 5.2], fov: 38 }} dpr={[1, 2]}>
              <CubeScene
                setup=""
                onReady={(c) => {
                  ctrl.current = c;
                  c.setSpeed(4);
                }}
              />
            </Canvas>
          )}
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/40 px-2.5 py-1 text-xs font-medium text-white/70 backdrop-blur">
            Miroir 3D en direct
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
          État réel à la connexion · tes mouvements rejoués en temps réel.
        </p>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map = {
    idle: { t: "Déconnecté", c: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
    connecting: { t: "Connexion…", c: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" },
    connected: { t: "Connecté", c: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" },
    error: { t: "Erreur", c: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${map.c}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" /> {map.t}
    </span>
  );
}

function BluetoothIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="m7 7 10 10-5 4V3l5 4L7 17" />
    </svg>
  );
}
