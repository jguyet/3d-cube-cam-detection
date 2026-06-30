"use client";

import { useEffect, useRef, useState } from "react";
import {
  connectGanCube,
  type GanCubeConnection,
  type GanCubeEvent,
  type MacAddressProvider,
} from "gan-web-bluetooth";
import type { Subscription } from "rxjs";

// Kociemba facelet letter -> sticker colour (native GAN scheme: white up).
const FACE_COLORS: Record<string, string> = {
  U: "#ffffff",
  R: "#d50000",
  F: "#00a651",
  D: "#ffd500",
  L: "#ff7100",
  B: "#0047ab",
};
const SOLVED = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

interface Hardware {
  hardwareName?: string;
  softwareVersion?: string;
  hardwareVersion?: string;
  gyroSupported?: boolean;
}

type Status = "idle" | "connecting" | "connected" | "error";

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const MAC_KEY = "gan-cube-mac";

export default function GanConnect() {
  const [supported, setSupported] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [deviceMAC, setDeviceMAC] = useState("");
  const [battery, setBattery] = useState<number | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [moves, setMoves] = useState<string[]>([]);
  const [moveCount, setMoveCount] = useState(0);
  const [facelets, setFacelets] = useState(SOLVED);
  const [gyro, setGyro] = useState<{ x: number; y: number; z: number; w: number } | null>(null);

  const [macInput, setMacInput] = useState("");

  const conn = useRef<GanCubeConnection | null>(null);
  const sub = useRef<Subscription | null>(null);
  const macRef = useRef("");

  // Keep a ref in sync so the MAC provider closure always sees the latest value.
  useEffect(() => {
    macRef.current = macInput;
  }, [macInput]);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "bluetooth" in navigator);
    try {
      const saved = localStorage.getItem(MAC_KEY);
      if (saved) setMacInput(saved);
    } catch {}
    return () => {
      sub.current?.unsubscribe();
      conn.current?.disconnect().catch(() => {});
    };
  }, []);

  // Provider: prefer the saved/typed MAC; only prompt as a last resort.
  const macProvider: MacAddressProvider = async (_device, isFallbackCall) => {
    const v = macRef.current.trim();
    if (MAC_RE.test(v)) return v;
    if (!isFallbackCall) return null; // let the library try auto-detection first
    const typed = window.prompt(
      "Adresse MAC du cube (format AA:BB:CC:DD:EE:FF).\n" +
        "Sur Mac elle n'est pas détectable automatiquement — récupère-la via nRF Connect (Android) " +
        "ou un PC Windows, puis colle-la ici (elle sera mémorisée) :",
    );
    return typed && MAC_RE.test(typed.trim()) ? typed.trim() : null;
  };

  const handleEvent = (event: GanCubeEvent) => {
    switch (event.type) {
      case "MOVE":
        setMoves((m) => [event.move, ...m].slice(0, 48));
        setMoveCount((c) => c + 1);
        break;
      case "FACELETS":
        setFacelets(event.facelets);
        break;
      case "GYRO":
        setGyro(event.quaternion);
        break;
      case "BATTERY":
        setBattery(event.batteryLevel);
        break;
      case "HARDWARE":
        setHardware({
          hardwareName: event.hardwareName,
          softwareVersion: event.softwareVersion,
          hardwareVersion: event.hardwareVersion,
          gyroSupported: event.gyroSupported,
        });
        break;
      case "DISCONNECT":
        cleanup();
        break;
    }
  };

  const connect = async () => {
    setError(null);
    setStatus("connecting");
    try {
      const c = await connectGanCube(macProvider);
      conn.current = c;
      setDeviceName(c.deviceName);
      setDeviceMAC(c.deviceMAC);
      // Remember the working MAC so the prompt never appears again.
      if (MAC_RE.test(c.deviceMAC)) {
        setMacInput(c.deviceMAC);
        try {
          localStorage.setItem(MAC_KEY, c.deviceMAC);
        } catch {}
      }
      sub.current = c.events$.subscribe(handleEvent);
      setStatus("connected");
      // Pull initial state.
      await c.sendCubeCommand({ type: "REQUEST_HARDWARE" });
      await c.sendCubeCommand({ type: "REQUEST_BATTERY" });
      await c.sendCubeCommand({ type: "REQUEST_FACELETS" });
    } catch (e) {
      // User cancelling the chooser throws — treat as a soft return to idle.
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|user/i.test(msg)) {
        setStatus("idle");
      } else {
        setError(msg);
        setStatus("error");
      }
      conn.current = null;
    }
  };

  const cleanup = () => {
    sub.current?.unsubscribe();
    sub.current = null;
    conn.current = null;
    setStatus("idle");
    setGyro(null);
  };

  const disconnect = async () => {
    await conn.current?.disconnect().catch(() => {});
    cleanup();
  };

  const reset = () => {
    setMoves([]);
    setMoveCount(0);
    conn.current?.sendCubeCommand({ type: "REQUEST_RESET" }).catch(() => {});
    setFacelets(SOLVED);
  };

  if (!supported) {
    return (
      <div className="rounded-2xl bg-amber-50 p-6 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
        <h3 className="font-bold">Web Bluetooth non disponible</h3>
        <p className="mt-2 text-sm">
          Ton navigateur ne supporte pas le Bluetooth web. Utilise <strong>Chrome</strong>,{" "}
          <strong>Edge</strong> ou <strong>Opera</strong> sur ordinateur (Windows / macOS / Linux)
          ou sur Android. Safari et Firefox ne sont pas compatibles, et l&apos;iPhone/iPad ne
          permet pas cette connexion en web.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left: connection + info */}
      <div className="space-y-5">
        {status !== "connected" && (
          <div>
            <label className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-400">
              Adresse MAC du cube{" "}
              <span className="font-normal text-slate-400">(obligatoire sur Mac)</span>
            </label>
            <input
              value={macInput}
              onChange={(e) => {
                const v = e.target.value;
                setMacInput(v);
                try {
                  if (MAC_RE.test(v.trim())) localStorage.setItem(MAC_KEY, v.trim());
                } catch {}
              }}
              placeholder="AA:BB:CC:DD:EE:FF"
              spellCheck={false}
              className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm outline-none transition focus:ring-2 dark:bg-slate-900 ${
                macInput && !MAC_RE.test(macInput.trim())
                  ? "border-red-300 focus:ring-red-200 dark:border-red-800"
                  : "border-slate-300 focus:ring-indigo-200 dark:border-slate-700"
              }`}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Récupère-la une fois via <strong>nRF Connect</strong> (Android) ou un <strong>PC
              Windows</strong>, colle-la ici : elle est mémorisée et le popup ne reviendra plus.
            </p>
          </div>
        )}

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
            <button
              onClick={disconnect}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            >
              Déconnecter
            </button>
          )}
          {status === "connected" && (
            <button
              onClick={reset}
              className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
            >
              Remettre à zéro
            </button>
          )}
          <StatusBadge status={status} />
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">
            {error}
          </p>
        )}

        {status === "connected" && (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Appareil" value={deviceName || "—"} />
            <Info label="MAC" value={deviceMAC || "—"} mono />
            <Info
              label="Batterie"
              value={battery != null ? `${battery}%` : "…"}
            />
            <Info
              label="Modèle"
              value={hardware?.hardwareName ?? "…"}
            />
            <Info label="Firmware" value={hardware?.softwareVersion ?? "…"} mono />
            <Info
              label="Gyroscope"
              value={hardware ? (hardware.gyroSupported ? "Oui" : "Non") : "…"}
            />
            <Info label="Coups détectés" value={String(moveCount)} />
            <Info
              label="Orientation"
              value={
                gyro
                  ? `x${gyro.x.toFixed(2)} y${gyro.y.toFixed(2)} z${gyro.z.toFixed(2)}`
                  : "—"
              }
              mono
            />
          </dl>
        )}

        {/* Live move stream */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            Flux des mouvements
          </h3>
          <div className="flex min-h-[3rem] flex-wrap gap-1.5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            {moves.length === 0 ? (
              <span className="text-sm text-slate-400">
                {status === "connected"
                  ? "Tourne une face de ton cube…"
                  : "Connecte ton cube pour voir les mouvements."}
              </span>
            ) : (
              moves.map((m, i) => (
                <span
                  key={moveCount - i}
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

      {/* Right: live 2D net of the real cube state */}
      <div className="flex flex-col items-center justify-center rounded-2xl bg-slate-50 p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <CubeNet facelets={facelets} />
        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          Reflet en temps réel de l&apos;état physique de ton cube
        </p>
      </div>
    </div>
  );
}

/** Unfolded 2D cube net driven by a 54-char Kociemba facelets string. */
function CubeNet({ facelets }: { facelets: string }) {
  // Face order in the string: U R F D L B (9 each).
  const faces = {
    U: facelets.slice(0, 9),
    R: facelets.slice(9, 18),
    F: facelets.slice(18, 27),
    D: facelets.slice(27, 36),
    L: facelets.slice(36, 45),
    B: facelets.slice(45, 54),
  };

  const Face = ({ s }: { s: string }) => (
    <div className="grid grid-cols-3 gap-0.5">
      {s.split("").map((ch, i) => (
        <div
          key={i}
          className="h-5 w-5 rounded-[3px] ring-1 ring-black/20 sm:h-6 sm:w-6"
          style={{ backgroundColor: FACE_COLORS[ch] ?? "#222" }}
        />
      ))}
    </div>
  );

  // Cross layout:  .U..  /  LFRB  /  .D..
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <Spacer />
        <Face s={faces.U} />
      </div>
      <div className="flex gap-1">
        <Face s={faces.L} />
        <Face s={faces.F} />
        <Face s={faces.R} />
        <Face s={faces.B} />
      </div>
      <div className="flex gap-1">
        <Spacer />
        <Face s={faces.D} />
      </div>
    </div>
  );
}

function Spacer() {
  return <div className="w-[4.7rem] sm:w-[5.6rem]" />;
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`mt-0.5 truncate font-semibold ${mono ? "font-mono text-xs" : "text-sm"}`}>
        {value}
      </dd>
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
