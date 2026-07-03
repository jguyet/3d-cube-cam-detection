import Link from "next/link";
import type { Metadata } from "next";
import V3ZoneScanner from "@/components/cube/V3ZoneScanner";

export const metadata: Metadata = {
  title: "V3 — zone ML + graphe v2 — RubixLearn",
  description: "Localisation par zone ML (hybride) + détection de faces par graphe (v2), combinées.",
};

export default function V3ZonePage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-indigo-600 to-emerald-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white">← Retour à l&apos;accueil</Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">V3 — zone ML + graphe v2</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            La <strong>zone ML</strong> de l&apos;hybride localise le cube et supprime le fond encombré ; le
            <strong> détecteur graphe v2</strong> assemble les faces 3×3 à l&apos;intérieur. Le meilleur des deux.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-10"><V3ZoneScanner /></div>
    </main>
  );
}
