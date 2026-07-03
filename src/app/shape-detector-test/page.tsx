import Link from "next/link";
import type { Metadata } from "next";
import ShapeDebugScanner from "@/components/cube/ShapeDebugScanner";

export const metadata: Metadata = {
  title: "Test ShapeDetector — RubixLearn",
  description: "Valider le détecteur de formes en temps réel sur la caméra.",
};

export default function ShapeDetectorTestPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-emerald-600 to-teal-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Test du détecteur de formes</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Visualise en direct la sortie <strong>brute</strong> du <code>ShapeDetector</code> (quads détectés,
            détection du blanc, carte d&apos;arêtes) — sans zone ML, grille ni mémoire. Règle le seuil et vois
            précisément où le détecteur réussit ou échoue.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <ShapeDebugScanner />
      </div>
    </main>
  );
}
