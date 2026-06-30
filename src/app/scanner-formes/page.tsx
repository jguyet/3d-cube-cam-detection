import Link from "next/link";
import type { Metadata } from "next";
import ShapeScanner from "@/components/cube/ShapeScanner";

export const metadata: Metadata = {
  title: "Détecteur de formes — RubixLearn",
  description: "Second algorithme : détection en temps réel des formes géométriques (quadrilatères) avec suivi temporel et suppression du fond.",
};

export default function ScannerFormesPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-cyan-600 to-blue-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Détecteur de formes</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Algorithme indépendant : il détecte en direct les <strong>formes géométriques</strong> (quadrilatères)
            de l&apos;image, retire le fond, et <strong>suit chaque forme dans le temps</strong> avec un identifiant stable.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <ShapeScanner />
      </div>
    </main>
  );
}
