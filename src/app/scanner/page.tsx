import Link from "next/link";
import type { Metadata } from "next";
import CubeScanner from "@/components/cube/CubeScanner";

export const metadata: Metadata = {
  title: "Scanner mon cube avec la caméra — RubixLearn",
  description:
    "Pas de cube connecté ? Scanne ton Rubik's Cube avec ta caméra : l'app détecte les couleurs de chaque face et reconstruit ton cube en 3D.",
};

export default function ScannerPage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-emerald-600 to-teal-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white"
          >
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Scanner mon cube</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Pas besoin de cube connecté&nbsp;: montre les 6 faces de ton cube à la caméra, et il
            apparaît en 3D. Idéal pour visualiser ton mélange et apprendre à le résoudre.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <CubeScanner />
      </div>
    </main>
  );
}
