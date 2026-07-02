import Link from "next/link";
import type { Metadata } from "next";
import ModelBScanner from "@/components/cube/ModelBScanner";

export const metadata: Metadata = {
  title: "Modèle B — RubixLearn",
  description: "Visualisation live du modèle qui apprend la densité de centres de stickers.",
};

export default function ScannerModelBPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-cyan-600 to-teal-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Modèle B — détection de stickers</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Le second modèle apprend une <strong>densité de centres de stickers</strong> (cible dense,
            invariante aux symétries). Cette page visualise en direct ce qu&apos;il détecte — à comparer
            avec le détecteur classique de la page hybride.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <ModelBScanner />
      </div>
    </main>
  );
}
