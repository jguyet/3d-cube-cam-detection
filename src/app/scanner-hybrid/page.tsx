import Link from "next/link";
import type { Metadata } from "next";
import HybridScanner from "@/components/cube/HybridScanner";

export const metadata: Metadata = {
  title: "Détecteur hybride — RubixLearn",
  description: "ML (zone du cube) + détection classique de la silhouette (coins précis au pixel).",
};

export default function ScannerHybridPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-orange-600 to-amber-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Détecteur hybride</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Le ML (iter4) trouve la <strong>zone</strong> du cube de façon robuste, puis un traitement
            <strong> classique</strong> cale la silhouette exacte sur les bords du cube dans cette zone —
            pour des coins précis au pixel là où le réseau seul reste approximatif.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <HybridScanner />
      </div>
    </main>
  );
}
