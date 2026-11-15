"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import { REPORT_DISCLAIMER, type EvidenceAssessment, type EvidenceConnection, type Opportunity, type Worker } from "@/lib/types";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { NO_EVIDENCE_NOTE, TYPE_LABEL, formatDate, formatStamp } from "@/lib/client/labels";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";
import { AssessmentLabel, FictionalTag, VerificationTag } from "@/components/ui/status";
import { Icon } from "@/components/ui/icons";

export default function ReportsPage() {
  const profile = useLoad(api.listEvidence);
  const opps = useLoad(api.listOpportunities);
  const [oppId, setOppId] = useState<string | null>(null);
  const list = opps.data?.opportunities ?? [];
  const opportunity = list.find((o) => o.id === oppId) ?? list[0];

  const error = profile.error ?? opps.error;
  return (
    <>
      <div className="no-print">
        <PageHeader title="Reports" lede="A qualification packet built from your latest saved match results, ready to print or save as PDF.">
          {list.length > 1 && (
            <select className="field w-auto" value={opportunity?.id} onChange={(e) => setOppId(e.target.value)} aria-label="Job">
              {list.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          )}
        </PageHeader>
      </div>
      {error && <ErrorNotice error={error} onRetry={() => (profile.reload(), opps.reload())} />}
      {(profile.status === "loading" || opps.status === "loading") && <Loading label="Preparing your report…" />}
      {profile.data && opps.data && !opportunity && <p className="text-slate">No opportunities yet.</p>}
      {profile.data && opportunity && <Packet key={opportunity.id} worker={profile.data.worker} opportunity={opportunity} />}
    </>
  );
}

function Packet({ worker, opportunity }: { worker: Worker; opportunity: Opportunity }) {
  const latest = useLoad(() => api.latestMatch(opportunity.id), opportunity.id);

  if (latest.status === "loading") return <Loading label="Loading the latest match run…" />;
  if (latest.error) return <ErrorNotice error={latest.error} onRetry={latest.reload} />;
  const run = latest.data?.matchRun;
  if (!run) {
    return (
      <Notice title="No match results yet" action={<Link href="/opportunities" className="btn btn-primary">Go to Opportunities</Link>}>
        Run matching for {opportunity.title} first. The report only shows saved results.
      </Notice>
    );
  }

  const current = run.status === "completed";
  const counts = run.results.reduce(
    (acc, r) => ({ ...acc, [r.assessment]: acc[r.assessment] + 1 }),
    { evidence_found: 0, needs_review: 0, no_sufficient_evidence: 0 } as Record<EvidenceAssessment, number>,
  );
  const sources = [...new Map(run.results.flatMap((r) => r.connections).map((c) => [c.evidenceId, c])).values()];

  return (
    <>
      <div className="no-print mb-4 space-y-3">
        {run.status === "stale" && (
          <Notice tone="warning" title="Results are out of date" action={<Link href="/opportunities" className="btn btn-secondary">Run matching again</Link>}>
            Your evidence changed after this run. Printing is turned off until matching runs again.
          </Notice>
        )}
        {run.status === "failed" && <Notice tone="danger" title="The last match run failed">Run matching again before printing.</Notice>}
        <div className="flex justify-end">
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!current}>
            <Icon name="printer" className="size-4" /> Print or save as PDF
          </button>
        </div>
      </div>

      <article className="sheet print-plain p-6 sm:p-10">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-navy pb-5">
          <div>
            <p className="font-display text-lg font-bold">
              Installer<span className="text-orange-ink">OS</span>
            </p>
            <h2 className="font-display text-4xl font-semibold tracking-tight">Qualification packet</h2>
          </div>
          <dl className="text-right text-sm">
            <dt className="text-slate">Based on match run of</dt>
            <dd className="font-semibold">{formatStamp(run.createdAt)}</dd>
            <dt className="mt-1 text-slate">Run reference</dt>
            <dd className="font-medium">{run.id.slice(0, 8)}</dd>
          </dl>
        </header>

        {(worker.isSynthetic || opportunity.isSynthetic) && (
          <p className="mt-4 flex items-center gap-2 text-sm">
            <FictionalTag /> The technician, employer and records in this packet are invented for a demonstration.
          </p>
        )}

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <section>
            <h3 className="text-sm font-semibold text-slate">Technician</h3>
            <p className="font-display text-2xl font-semibold">{worker.name}</p>
            <p>{worker.trade}</p>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-slate">Opportunity</h3>
            <p className="font-display text-2xl font-semibold">{opportunity.title}</p>
            <p>{opportunity.employer}</p>
            <p className="text-sm text-slate">Source: {opportunity.sourceUrl ?? opportunity.requirements[0]?.source ?? "Not stated"}</p>
          </section>
        </div>

        <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 rounded-md bg-paper px-4 py-3 text-sm print:border print:border-line">
          {(Object.keys(counts) as EvidenceAssessment[]).map((a) => (
            <span key={a} className="flex items-center gap-2">
              <AssessmentLabel assessment={a} />
              <span className="font-semibold">{counts[a]}</span>
            </span>
          ))}
        </p>

        {run.memoryWarning && <p className="mt-3 text-sm text-orange-ink">Note: {run.memoryWarning}</p>}

        <section className="mt-8">
          <h3 className="font-display text-2xl font-semibold">Requirement by requirement</h3>
          <p className="text-sm text-slate">
            Assessment describes whether relevant documentation was found. Verification describes whether a person independently confirmed
            the record. They are separate.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-navy">
                  <th className="py-2 pr-4 font-semibold">Requirement</th>
                  <th className="py-2 pr-4 font-semibold">Assessment</th>
                  <th className="py-2 pr-4 font-semibold">Supporting record</th>
                  <th className="py-2 font-semibold">Verification</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((r) => {
                  const rows: (EvidenceConnection | null)[] = r.connections.length ? r.connections : [null];
                  return (
                    <Fragment key={r.requirementId}>
                      {rows.map((c, i) => (
                        <tr key={c?.evidenceId ?? "none"} className={`break-inside-avoid align-top ${i === rows.length - 1 ? "border-b border-line" : ""}`}>
                          {i === 0 && (
                            <>
                              <td rowSpan={rows.length} className="py-3 pr-4 font-medium">
                                {r.originalText}
                                {!r.mandatory && <span className="block text-xs text-slate">Optional</span>}
                              </td>
                              <td rowSpan={rows.length} className="py-3 pr-4">
                                <AssessmentLabel assessment={r.assessment} />
                                <p className="mt-1 text-xs text-slate">{r.explanation}</p>
                              </td>
                            </>
                          )}
                          <td className="py-3 pr-4">
                            {c ? (
                              <>
                                <span className="font-medium">{c.evidenceTitle}</span>
                                <span className="block text-xs text-slate">
                                  {formatDate(c.evidenceDate)}, {TYPE_LABEL[c.evidenceType]}, {c.role === "direct" ? "could satisfy on its own" : "related, partial"}
                                </span>
                              </>
                            ) : (
                              <span className="text-slate">No matching record</span>
                            )}
                          </td>
                          <td className="py-3">{c && <VerificationTag status={c.verificationStatus} />}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          <section className="break-inside-avoid">
            <h3 className="font-display text-xl font-semibold">Missing or incomplete documentation</h3>
            {run.results.some((r) => r.missingDocumentation.length) ? (
              <ul className="mt-2 space-y-2 text-sm">
                {run.results
                  .filter((r) => r.missingDocumentation.length)
                  .map((r) => (
                    <li key={r.requirementId}>
                      <span className="font-medium">{r.originalText}</span>
                      <ul className="list-disc pl-5 text-slate">
                        {r.missingDocumentation.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate">None flagged.</p>
            )}
          </section>
          <section className="break-inside-avoid">
            <h3 className="font-display text-xl font-semibold">Uncertainty</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate">
              {run.results.flatMap((r) => r.uncertainties.map((u) => <li key={`${r.requirementId}${u}`}>{u}</li>))}
            </ul>
          </section>
        </div>

        <section className="mt-8 break-inside-avoid">
          <h3 className="font-display text-xl font-semibold">Source references</h3>
          <p className="text-sm text-slate">Originals are held in the technician&apos;s private InstallerOS storage and shared only with their permission.</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {sources.map((s) => (
              <li key={s.evidenceId} className="flex flex-wrap justify-between gap-x-4 py-2">
                <span>
                  <span className="font-medium">{s.evidenceTitle}</span>
                  <span className="text-slate"> ({TYPE_LABEL[s.evidenceType]}, {formatDate(s.evidenceDate)})</span>
                </span>
                <span className="text-slate">Record {s.evidenceId.slice(-12)}</span>
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-10 border-t-2 border-navy pt-4 text-sm">
          <p className="font-semibold">{REPORT_DISCLAIMER}</p>
          <p className="mt-1 text-slate">{NO_EVIDENCE_NOTE}</p>
        </footer>
      </article>
    </>
  );
}
