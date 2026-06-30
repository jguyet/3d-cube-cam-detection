import Link from "next/link";
import type { Metadata } from "next";
import MLScanner from "@/components/cube/MLScanner";

export const metadata: Metadata = {
  title: "Détecteur ML — RubixLearn",
  description: "Détection du cube par réseau de neurones entraîné (ONNX) : 8 coins + faces → cube 3D superposé.",
};

export default function ScannerMlPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-violet-600 to-fuchsia-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Détecteur ML</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Le réseau entraîné sur le dataset synthétique prédit en direct les 8 coins du cube et
            les faces visibles → cube 3D superposé, robuste là où l&apos;heuristique JS décroche.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <MLScanner />
      </div>
    </main>
  );
}
