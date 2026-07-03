import Link from "next/link";
import type { Metadata } from "next";
import ShapeLinksScanner from "@/components/cube/ShapeLinksScanner";

export const metadata: Metadata = {
  title: "ShapeDetector + liaisons — RubixLearn",
  description: "Détecteur de formes brut + liens entre tous les shapes, en temps réel.",
};

export default function ShapeDetectorLinksPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-emerald-600 to-cyan-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">ShapeDetector + liaisons</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Comme <code>/shape-detector-test</code>, mais avec les <strong>liaisons entre tous les shapes</strong>
            détectés — pour voir la structure de grille émerger directement des détections brutes.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <ShapeLinksScanner />
      </div>
    </main>
  );
}
