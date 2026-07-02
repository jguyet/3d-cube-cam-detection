import Link from "next/link";
import type { Metadata } from "next";
import DatasetTester from "@/components/cube/DatasetTester";

export const metadata: Metadata = {
  title: "Hybride sur dataset — RubixLearn",
  description: "Teste l'algorithme géométrique hybride sur un jeu d'images réelles.",
};

export default function ScannerHybridDatasetPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-indigo-600 to-violet-700 text-white">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Hybride sur dataset</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Lance l&apos;algorithme géométrique actuel (détection de stickers + blanc → faces →
            grille → liaisons → complétion → contour) sur des <strong>images réelles statiques</strong>.
            Chaque carte montre l&apos;overlay et les stats — pour vérifier l&apos;algo sans la caméra.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-10">
        <DatasetTester />
      </div>
    </main>
  );
}
