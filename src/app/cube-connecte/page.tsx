import Link from "next/link";
import type { Metadata } from "next";
import SmartCubeConnect from "@/components/cube/SmartCubeConnect";
import GanDiagnostic from "@/components/cube/GanDiagnostic";

export const metadata: Metadata = {
  title: "Connecter mon cube — RubixLearn",
  description:
    "Connecte ton cube connecté (GAN, GiiKER, GoCube) en Bluetooth directement dans le navigateur. 100 % automatique, aucune adresse MAC à saisir, miroir 3D en temps réel.",
};

export default function CubeConnectePage() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="bg-gradient-to-br from-indigo-600 to-violet-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white"
          >
            ← Retour à l&apos;accueil
          </Link>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">Connecter mon cube</h1>
          <p className="mt-3 max-w-2xl text-white/90">
            Relie ton cube connecté en Bluetooth, directement dans le navigateur. Tes mouvements
            physiques sont rejoués en 3D en temps réel — sans installer quoi que ce soit.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <SmartCubeConnect />

        <section className="mt-12 rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <h2 className="text-lg font-bold">Comment ça marche</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-400">
            <li>Réveille ton cube (tourne une face) pour l&apos;activer en Bluetooth.</li>
            <li>
              Ouvre cette page dans <strong>Chrome</strong>, <strong>Edge</strong> ou{" "}
              <strong>Opera</strong> (ordinateur ou Android). Safari / Firefox / iOS ne sont pas
              compatibles avec le Bluetooth web.
            </li>
            <li>
              Clique <strong>« Connecter mon cube »</strong> et sélectionne-le. La clé de
              déchiffrement est lue automatiquement dans le cube — <strong>aucune adresse MAC à
              saisir</strong>.
            </li>
          </ol>
          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            Compatibles : cubes GAN (356 i, i Carry, i3, 12 ui…), GiiKER et GoCube. Connexion 100 %
            locale (navigateur ↔ cube), aucune donnée envoyée à un serveur.
          </p>
        </section>

        {/* Outil de diagnostic, replié — utile seulement en cas de souci. */}
        <details className="mt-8 rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <summary className="cursor-pointer list-none px-6 py-4 text-sm font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400">
            Diagnostic Bluetooth avancé (en cas de problème)
          </summary>
          <div className="px-2 pb-2">
            <GanDiagnostic />
          </div>
        </details>
      </div>
    </main>
  );
}
