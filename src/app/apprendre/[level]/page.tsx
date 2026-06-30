import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { LEVELS, getLevel } from "@/lib/data/levels";
import RubiksCube from "@/components/cube/RubiksCube";
import { SuccessIcon } from "@/components/icons";

export function generateStaticParams() {
  return LEVELS.map((l) => ({ level: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ level: string }>;
}): Promise<Metadata> {
  const { level } = await params;
  const data = getLevel(level);
  if (!data) return { title: "Niveau introuvable — RubixLearn" };
  return {
    title: `${data.name} — ${data.tagline} | RubixLearn`,
    description: data.intro,
  };
}

export default async function LevelPage({
  params,
}: {
  params: Promise<{ level: string }>;
}) {
  const { level } = await params;
  const data = getLevel(level);
  if (!data) notFound();

  const next = LEVELS.find((l) => l.order === data.order + 1);
  const prev = LEVELS.find((l) => l.order === data.order - 1);

  return (
    <main className="flex-1 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Header */}
      <header className={`bg-gradient-to-br ${data.color} text-white`}>
        <div className="mx-auto max-w-6xl px-6 py-12">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 transition hover:text-white"
          >
            ← Tous les niveaux
          </Link>
          <div className="mt-6 flex items-center gap-3">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 text-xl font-bold backdrop-blur">
              {data.order}
            </span>
            <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-semibold backdrop-blur">
              {data.difficulty}
            </span>
          </div>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">{data.name}</h1>
          <p className="mt-2 text-lg font-medium text-white/90">{data.tagline}</p>
          <p className="mt-4 max-w-3xl text-white/85">{data.intro}</p>
        </div>
      </header>

      {/* Steps */}
      <div className="mx-auto max-w-6xl px-6 py-12">
        {data.steps.map((step) => (
          <section key={step.id} className="mb-16 scroll-mt-20" id={step.id}>
            <div className="mb-6 border-l-4 border-indigo-500 pl-4">
              <h2 className="text-2xl font-bold tracking-tight">{step.title}</h2>
              <p className="mt-1 text-slate-600 dark:text-slate-400">{step.goal}</p>
            </div>

            <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
              {step.algorithms.map((algo) => (
                <article
                  key={algo.id}
                  className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
                >
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h3 className="text-lg font-bold">{algo.name}</h3>
                    <span className={`text-xs font-semibold ${data.accent}`}>Algo</span>
                  </div>
                  <RubiksCube
                    algorithm={algo.notation}
                    setup={algo.setup}
                    context={step.context}
                  />
                  <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {algo.description}
                  </p>
                </article>
              ))}
            </div>
          </section>
        ))}

        {/* Nav between levels */}
        <nav className="flex flex-col gap-4 border-t border-slate-200 pt-8 sm:flex-row sm:justify-between dark:border-slate-800">
          {prev ? (
            <Link
              href={`/apprendre/${prev.slug}`}
              className="group rounded-xl bg-white px-5 py-4 ring-1 ring-slate-200 transition hover:shadow-md dark:bg-slate-900 dark:ring-slate-800"
            >
              <div className="text-xs font-medium text-slate-500">← Niveau précédent</div>
              <div className="mt-0.5 font-bold">{prev.name}</div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={`/apprendre/${next.slug}`}
              className="group rounded-xl bg-white px-5 py-4 text-right ring-1 ring-slate-200 transition hover:shadow-md dark:bg-slate-900 dark:ring-slate-800"
            >
              <div className="text-xs font-medium text-slate-500">Niveau suivant →</div>
              <div className="mt-0.5 font-bold">{next.name}</div>
            </Link>
          ) : (
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-4 text-right font-bold text-white transition hover:bg-indigo-500"
            >
              <SuccessIcon className="h-5 w-5" /> Tu as tout parcouru — Retour à l&apos;accueil
            </Link>
          )}
        </nav>
      </div>
    </main>
  );
}
