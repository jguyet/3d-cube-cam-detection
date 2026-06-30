import Link from "next/link";
import type { Metadata } from "next";
import DatasetGenerator from "@/components/dataset/DatasetGenerator";

export const metadata: Metadata = {
  title: "Générateur de dataset synthétique — RubixLearn",
  description: "Génère des milliers d'images de Rubik's Cube labellisées (coins 3D + faces) par domain randomization pour entraîner un détecteur.",
};

export default function DatasetPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-fuchsia-600 to-purple-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Générateur de dataset</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Scène 3D randomisée (cube, pose, lumières, fonds anormaux, mains) qui rend des milliers
            d&apos;images <strong>labellisées</strong> — 8 coins du cube + faces visibles — pour entraîner
            un petit réseau de détection markerless.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <DatasetGenerator />
      </div>
    </main>
  );
}
