"use client";

import { useState } from "react";
import { FACELET_COLOR } from "@/lib/cube/faceletMap";

const SOLVED = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

// Palette: letter (= face the colour belongs to) → label.
const PALETTE: { letter: string; label: string }[] = [
  { letter: "U", label: "Blanc" },
  { letter: "D", label: "Jaune" },
  { letter: "F", label: "Vert" },
  { letter: "B", label: "Bleu" },
  { letter: "R", label: "Rouge" },
  { letter: "L", label: "Orange" },
];

// Each face: its offset in the 54-char string. Centre (index 4) is fixed.
const FACES: { key: string; off: number }[] = [
  { key: "U", off: 0 },
  { key: "R", off: 9 },
  { key: "F", off: 18 },
  { key: "D", off: 27 },
  { key: "L", off: 36 },
  { key: "B", off: 45 },
];

interface FaceletEditorProps {
  initial?: string;
  onApply: (facelets: string) => void;
  onCancel: () => void;
}

export default function FaceletEditor({ initial, onApply, onCancel }: FaceletEditorProps) {
  const [cells, setCells] = useState<string[]>(
    () => ((initial && initial.length >= 54 ? initial : SOLVED).slice(0, 54)).split(""),
  );
  const [active, setActive] = useState("U");

  const paint = (idx: number) => {
    if (idx % 9 === 4) return; // centres are fixed
    setCells((c) => {
      const next = [...c];
      next[idx] = active;
      return next;
    });
  };

  const Face = ({ off }: { off: number }) => (
    <div className="grid grid-cols-3 gap-0.5">
      {Array.from({ length: 9 }, (_, k) => {
        const idx = off + k;
        const isCenter = k === 4;
        return (
          <button
            key={k}
            onClick={() => paint(idx)}
            disabled={isCenter}
            className={`h-7 w-7 rounded-[3px] ring-1 ring-black/30 transition ${
              isCenter ? "cursor-default" : "cursor-pointer hover:ring-2 hover:ring-indigo-400"
            }`}
            style={{ backgroundColor: FACELET_COLOR[cells[idx]] ?? "#222" }}
            aria-label={`facette ${idx}`}
          />
        );
      })}
    </div>
  );

  const faceOff = (key: string) => FACES.find((f) => f.key === key)!.off;
  const Spacer = () => <div className="w-[5.7rem]" />;

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h3 className="text-base font-bold">Resynchroniser à la main</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Choisis une couleur, puis clique les facettes pour reproduire l&apos;état actuel de ton cube
        physique. Les centres sont fixes. Tiens ton cube avec le <strong>blanc en haut</strong> et le{" "}
        <strong>vert devant</strong>.
      </p>

      {/* Palette */}
      <div className="mt-4 flex flex-wrap gap-2">
        {PALETTE.map((p) => (
          <button
            key={p.letter}
            onClick={() => setActive(p.letter)}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 transition ${
              active === p.letter
                ? "ring-2 ring-indigo-500"
                : "ring-slate-200 dark:ring-slate-700"
            }`}
          >
            <span
              className="h-4 w-4 rounded-[3px] ring-1 ring-black/30"
              style={{ backgroundColor: FACELET_COLOR[p.letter] }}
            />
            {p.label}
          </button>
        ))}
      </div>

      {/* Cross net */}
      <div className="mt-5 inline-block space-y-1">
        <div className="flex gap-1">
          <Spacer />
          <Face off={faceOff("U")} />
        </div>
        <div className="flex gap-1">
          <Face off={faceOff("L")} />
          <Face off={faceOff("F")} />
          <Face off={faceOff("R")} />
          <Face off={faceOff("B")} />
        </div>
        <div className="flex gap-1">
          <Spacer />
          <Face off={faceOff("D")} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={() => onApply(cells.join(""))}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          Appliquer cet état
        </button>
        <button
          onClick={() => setCells(SOLVED.split(""))}
          className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
        >
          Tout effacer (résolu)
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 transition hover:text-slate-700 dark:text-slate-400"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
