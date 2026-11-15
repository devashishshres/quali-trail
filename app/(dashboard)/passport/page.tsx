"use client";
import Link from "next/link";
import type { Evidence, EvidenceType, MatchRunResponse, Opportunity } from "@/lib/types";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { TYPE_LABEL, formatDate, formatMonth } from "@/lib/client/labels";
import { ErrorNotice, Loading } from "@/components/ui/states";
import { FictionalTag, IndexStatus, VerificationTag } from "@/components/ui/status";
import { Icon } from "@/components/ui/icons";

const year = (e: Evidence) => e.date?.slice(0, 4) ?? "Undated";

export default function PassportPage() {
  const profile = useLoad(api.listEvidence);

  if (profile.status === "loading") return <Loading label="Opening your passport…" />;
  if (profile.error && !profile.data) return <ErrorNotice error={profile.error} onRetry={profile.reload} />;
  const { worker, evidence } = profile.data!;

  const byType = evidence.reduce<Partial<Record<EvidenceType, number>>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {});
  const indexed = evidence.filter((e) => e.indexStatus === "indexed").length;
  const years = [...new Set(evidence.map(year))];
  const recent = [...evidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);

  return (
    <>
      {/* Trade card */}
      <section className="sheet relative overflow-hidden">
        <div className="hazard absolute inset-y-0 left-0 w-1.5" aria-hidden="true" />
        <div className="flex flex-wrap items-end justify-between gap-6 py-6 pl-7 pr-5 sm:py-8 sm:pl-10 sm:pr-8">
          <div>
            <p className="text-sm font-semibold text-slate">Trade passport</p>
            <h1 className="font-display text-5xl font-semibold leading-none tracking-tight sm:text-7xl">{worker.name}</h1>
            <p className="mt-2 text-lg font-medium">{worker.trade}</p>
            {worker.isSynthetic && (
              <div className="mt-3">
                <FictionalTag />
              </div>
            )}
          </div>
          <Link href="/opportunities" className="btn btn-primary">
            <Icon name="briefcase" className="size-4" /> Explore opportunities
          </Link>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-line bg-paper/50 px-7 py-4 text-sm sm:px-10">
          <div>
            <dt className="text-slate">Records</dt>
            <dd className="font-display text-2xl font-semibold">{evidence.length}</dd>
          </div>
          {(Object.keys(byType) as EvidenceType[]).map((t) => (
            <div key={t}>
              <dt className="text-slate">{TYPE_LABEL[t]}</dt>
              <dd className="font-display text-2xl font-semibold">{byType[t]}</dd>
            </div>
          ))}
          <div className="sm:ml-auto">
            <dt className="text-slate">Searchable in memory</dt>
            <dd className="font-display text-2xl font-semibold">
              {indexed} <span className="text-base font-medium text-slate">of {evidence.length}</span>
            </dd>
          </div>
        </dl>
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_20rem]">
        {/* Timeline */}
        <section aria-labelledby="timeline">
          <div className="flex items-baseline justify-between border-b-2 border-navy pb-2">
            <h2 id="timeline" className="font-display text-2xl font-semibold">
              Professional timeline
            </h2>
            <Link href="/evidence" className="btn-quiet text-sm font-semibold">
              Add evidence
            </Link>
          </div>
          {evidence.length === 0 && (
            <p className="py-8 text-slate">
              Your timeline is empty. <Link href="/evidence" className="font-semibold underline">Add your first certificate or work record</Link>.
            </p>
          )}
          {years.map((y) => (
            <div key={y} className="grid grid-cols-[4.5rem_1fr] gap-4 border-b border-line py-5 sm:grid-cols-[6rem_1fr]">
              <p className="font-display text-3xl font-semibold text-navy/30 sm:text-4xl">{y}</p>
              <ol className="relative space-y-5 border-l-2 border-navy/15 pl-5">
                {evidence
                  .filter((e) => year(e) === y)
                  .map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[27px] top-1.5 size-3 rounded-full border-2 border-white bg-navy ring-1 ring-navy/20" aria-hidden="true" />
                      <p className="text-sm font-medium text-slate">
                        {e.date ? formatMonth(e.date) : "Date not stated"}, {TYPE_LABEL[e.type]}
                      </p>
                      <Link href={`/evidence#evidence-${e.id}`} className="font-semibold hover:underline">
                        {e.title}
                      </Link>
                      {e.issuer && <p className="text-sm text-slate">{e.issuer}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <VerificationTag status={e.verificationStatus} />
                        <IndexStatus status={e.indexStatus} />
                      </div>
                    </li>
                  ))}
              </ol>
            </div>
          ))}
        </section>

        <aside className="space-y-8">
          <MemoryHighlight />
          <section>
            <h2 className="font-display text-xl font-semibold">Recently added</h2>
            <ul className="mt-3 space-y-3">
              {recent.map((e) => (
                <li key={e.id} className="text-sm">
                  <Link href={`/evidence#evidence-${e.id}`} className="font-semibold hover:underline">
                    {e.title}
                  </Link>
                  <p className="text-slate">{formatDate(e.date)}</p>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}

/** The oldest record that memory search resurfaced for a requirement in the latest run. */
function MemoryHighlight() {
  const data = useLoad(async (): Promise<{ opportunity: Opportunity; latest: MatchRunResponse | null } | null> => {
    const { opportunities } = await api.listOpportunities();
    const opportunity = opportunities[0];
    return opportunity ? { opportunity, latest: await api.latestMatch(opportunity.id) } : null;
  });

  const run = data.data?.latest?.matchRun;
  const found = run?.results
    .flatMap((r) => r.connections.filter((c) => c.memorySimilarity !== null).map((c) => ({ r, c })))
    .sort((a, b) => (a.c.evidenceDate ?? "9").localeCompare(b.c.evidenceDate ?? "9"))[0];

  return (
    <section className="rounded-lg bg-sky p-5 text-white">
      <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
        <Icon name="star" className="size-5 text-star" /> Memory discovery
      </h2>
      {data.status === "loading" && <p className="mt-2 text-sm text-white/60">Checking your latest match…</p>}
      {data.error && <p className="mt-2 text-sm text-white/70">Couldn&apos;t load match results: {data.error.message}</p>}
      {data.status === "ready" && !found && (
        <p className="mt-2 text-sm text-white/75">
          Run matching on a job and InstallerOS will show which older records resurface for its requirements.
        </p>
      )}
      {found && data.data && (
        <>
          <p className="mt-3 text-sm text-white/60">{formatMonth(found.c.evidenceDate)}</p>
          <p className="font-semibold">{found.c.evidenceTitle}</p>
          <p className="mt-3 text-sm text-white/75">resurfaced for the {data.data.opportunity.title} requirement:</p>
          <p className="mt-1 text-sm italic text-white/90">&ldquo;{found.r.originalText}&rdquo;</p>
          {run?.status === "stale" && <p className="mt-3 text-xs text-orange">These results are out of date.</p>}
        </>
      )}
      <Link href="/opportunities" className="mt-4 inline-flex text-sm font-semibold text-orange underline-offset-2 hover:underline">
        {found ? "See the full constellation" : "Go to Opportunities"}
      </Link>
    </section>
  );
}
