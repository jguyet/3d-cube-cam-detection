import Link from "next/link";
import { LEVELS } from "@/lib/data/levels";
import { CubeIcon, LayersIcon, Rotate3dIcon, TrophyIcon } from "@/components/icons";

export default function Home() {
  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-slate-200 dark:border-slate-800">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-indigo-50 via-white to-sky-50 dark:from-indigo-950/40 dark:via-slate-950 dark:to-slate-900" />
        <div className="mx-auto max-w-5xl px-6 py-20 text-center sm:py-28">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/70 px-4 py-1.5 text-sm font-medium text-indigo-700 ring-1 ring-indigo-200 backdrop-blur dark:bg-white/5 dark:text-indigo-300 dark:ring-indigo-800">
            <CubeIcon className="h-4 w-4" /> Apprends en 3D
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
            Maîtrise le{" "}
            <span className="bg-gradient-to-r from-indigo-600 to-fuchsia-600 bg-clip-text text-transparent">
              Rubik&apos;s Cube
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
            Choisis ton niveau, puis apprends les algorithmes pas à pas grâce à des cubes 3D
            animés. Chaque algo se joue sous tes yeux et tu peux faire tourner le cube comme tu veux.
          </p>
          <div className="mt-9 flex items-center justify-center gap-3">
            <a
              href="#niveaux"
              className="rounded-xl bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500"
            >
              Choisir mon niveau
            </a>
            <Link
              href="/apprendre/debutant"
              className="rounded-xl bg-white px-6 py-3 text-base font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
            >
              Je débute →
            </Link>
          </div>
          <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-5">
            <Link
              href="/scanner"
              className="inline-flex items-center gap-2 text-sm font-medium text-emerald-600 transition hover:text-emerald-500 dark:text-emerald-400"
            >
              <CubeIcon className="h-4 w-4" /> Scanner mon cube avec la caméra
            </Link>
            <Link
              href="/cube-connecte"
              className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 transition hover:text-indigo-500 dark:text-indigo-400"
            >
              <CubeIcon className="h-4 w-4" /> J&apos;ai un cube connecté (Bluetooth)
            </Link>
          </div>
        </div>
      </section>

      {/* Levels */}
      <section id="niveaux" className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Quel est ton niveau&nbsp;?</h2>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Progresse à ton rythme, du premier cube résolu jusqu&apos;à la méthode des speedcubers.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {LEVELS.map((level) => {
            const algoCount = level.steps.reduce((n, s) => n + s.algorithms.length, 0);
            return (
              <Link
                key={level.slug}
                href={`/apprendre/${level.slug}`}
                className="group relative flex flex-col overflow-hidden rounded-2xl bg-white p-6 ring-1 ring-slate-200 transition hover:-translate-y-1 hover:shadow-xl dark:bg-slate-900 dark:ring-slate-800"
              >
                <div className={`absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r ${level.color}`} />
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${level.color} text-lg font-bold text-white shadow`}
                  >
                    {level.order}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {level.difficulty}
                  </span>
                </div>
                <h3 className="mt-5 text-xl font-bold">{level.name}</h3>
                <p className="mt-1 flex-1 text-sm text-slate-600 dark:text-slate-400">
                  {level.tagline}
                </p>
                <div className="mt-5 flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-500 dark:text-slate-400">
                    {level.steps.length} étapes · {algoCount} algos
                  </span>
                  <span className="font-semibold text-indigo-600 transition group-hover:translate-x-0.5 dark:text-indigo-400">
                    Apprendre →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>

        {/* How it works */}
        <div className="mt-20 grid gap-8 sm:grid-cols-3">
          {[
            {
              Icon: LayersIcon,
              title: "1. Choisis ton niveau",
              text: "Du débutant total à l'expert PLL — chaque niveau s'appuie sur le précédent.",
            },
            {
              Icon: Rotate3dIcon,
              title: "2. Observe en 3D",
              text: "Joue l'algorithme, ralentis-le, et fais pivoter le cube pour tout comprendre.",
            },
            {
              Icon: TrophyIcon,
              title: "3. Mémorise et progresse",
              text: "Répète les cas un par un et passe au niveau suivant à ton rythme.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
            >
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
                <f.Icon className="h-6 w-6" />
              </span>
              <h3 className="mt-3 font-bold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
        RubixLearn · Apprends le Rubik&apos;s Cube en 3D
      </footer>
    </main>
  );
}
