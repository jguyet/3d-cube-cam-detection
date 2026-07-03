import Link from "next/link";
import type { Metadata } from "next";
import V2AlgoScanner from "@/components/cube/V2AlgoScanner";

export const metadata: Metadata = {
  title: "V2 algo — faces par graphe — RubixLearn",
  description: "Détection de la position des faces via le graphe de liaisons entre shapes.",
};

export default function V2AlgoPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-fuchsia-600 to-indigo-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">V2 algo — faces par graphe</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            À partir des liaisons de <code>/shape-detector-links</code>, on lit directement la <strong>position des faces</strong> :
            chaque face est une composante connexe du graphe, ses coordonnées de grille viennent des liens — puis on
            <strong> imagine tous les patterns</strong> en extrapolant la grille 3×3 complète.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <V2AlgoScanner />
      </div>
    </main>
  );
}
