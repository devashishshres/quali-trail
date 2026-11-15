"use client";
import Link from "next/link";
import { useState } from "react";
import type { MatchRunResponse, Opportunity } from "@/lib/types";
import { api, toApiError } from "@/lib/client/api";
import type { ApiRequestError } from "@/lib/client/errors";
import { useLoad } from "@/lib/client/use-load";
import { ASSESSMENT_LABEL, CANNOT_ASSESS_NOTE, NO_EVIDENCE_NOTE, formatDate, formatStamp } from "@/lib/client/labels";
import { FIXTURE_MODE } from "@/lib/client/api";
import { accountsApi } from "@/lib/client/accounts-api";
import { FitSummary } from "@/components/opportunities/fit-summary";
import { NextStepList } from "@/components/opportunities/next-steps";
import { nextSteps, type ConfirmFlows } from "@/lib/next-steps";
import { ImportCard } from "@/components/opportunities/import-card";
import { Constellation } from "@/components/opportunities/constellation";
import { RequirementList } from "@/components/opportunities/requirement-list";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";
import { FictionalTag } from "@/components/ui/status";
import { Icon } from "@/components/ui/icons";

export default function OpportunitiesPage() {
  const opps = useLoad(api.listOpportunities);
  const me = useLoad(() => (FIXTURE_MODE ? Promise.resolve(null) : accountsApi.me()));
  // Arriving from a confirmed import: open that job.
  const [oppId, setOppId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("job")));
  const list = opps.data?.opportunities ?? [];
  const opportunity = list.find((o) => o.id === oppId) ?? list[0];

  return (
    <>
      <PageHeader title="Opportunities" lede="Pick a job, then let QualiTrail search your history for evidence that fits each requirement.">
        {list.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block font-semibold">Job</span>
            <select className="field" value={opportunity?.id} onChange={(e) => setOppId(e.target.value)}>
              {list.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title} ({o.employer})
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      {me.data?.features.jobImport && <ImportCard />}
      {opps.status === "loading" && <Loading label="Loading opportunities…" />}
      {opps.error && <ErrorNotice error={opps.error} onRetry={opps.reload} />}
      {opps.data && !opportunity && <p className="text-slate">No opportunities yet.</p>}
      {opportunity && <Matcher key={opportunity.id} opportunity={opportunity} flows={me.data ? { customerSignoff: me.data.features.customerSignoff, supervisorReview: me.data.features.supervisorReview } : null} />}
    </>
  );
}

function Matcher({ opportunity, flows }: { opportunity: Opportunity; flows: ConfirmFlows | null }) {
  const latest = useLoad(() => api.latestMatch(opportunity.id), opportunity.id);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<ApiRequestError | null>(null);
  const [reqId, setReqId] = useState(opportunity.requirements[0]?.id ?? "");

  const response: MatchRunResponse | null = latest.data ?? null;
  const run = response?.matchRun;
  const results = new Map(run?.results.map((r) => [r.requirementId, r]));
  const selectedResult = results.get(reqId);
  const reqText = (id: string) => opportunity.requirements.find((r) => r.id === id)?.originalText ?? "Requirement";

  async function runMatching() {
    setRunning(true);
    setRunError(null);
    try {
      latest.setData(await api.runMatch(opportunity.id));
    } catch (e) {
      setRunError(toApiError(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <section className="sheet flex flex-wrap items-start justify-between gap-6 p-5 sm:p-7">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-display text-3xl font-semibold">{opportunity.title}</h2>
            {opportunity.isSynthetic && <FictionalTag />}
          </div>
          <p className="font-medium text-slate">{opportunity.employer}</p>
          {opportunity.importInfo?.location && <p className="text-sm text-slate">{opportunity.importInfo.location}</p>}
          <p className="mt-3">{opportunity.description}</p>
          {opportunity.importInfo && <ImportProvenance opportunity={opportunity} />}
          <p className="mt-2 text-sm text-slate">
            Source:{" "}
            {opportunity.sourceUrl ? (
              <a href={opportunity.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                {opportunity.sourceUrl}
              </a>
            ) : (
              (opportunity.requirements[0]?.source ?? "Not stated")
            )}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <button className="btn btn-primary" onClick={runMatching} disabled={running || latest.status === "loading"}>
            <Icon name="star" className="size-4" />
            {running ? "Searching your memory…" : run ? "Run matching again" : "Run matching"}
          </button>
          {run && <span className="text-sm text-slate">Last run {formatStamp(run.createdAt)}</span>}
        </div>
      </section>

      <div className="mt-4 space-y-3">
        {latest.error && <ErrorNotice error={latest.error} onRetry={latest.reload} />}
        {runError && (
          <Notice
            tone="danger"
            title={runError.code === "memory_unavailable" ? "Memory search is unavailable" : "Matching didn't finish"}
            action={
              <button className="btn btn-secondary" onClick={runMatching}>
                <Icon name="refresh" className="size-4" /> Try again
              </button>
            }
          >
            {runError.message} No results were invented in its place.
          </Notice>
        )}
        {run?.status === "stale" && (
          <Notice tone="warning" title="Results are out of date">
            Your evidence changed after this run. Run matching again to include it.
          </Notice>
        )}
        {run?.status === "failed" && <Notice tone="danger" title="The last run failed">Run matching again.</Notice>}
        {run?.memoryWarning && <Notice tone="warning" title="Memory search was partial">{run.memoryWarning}</Notice>}
        {response && response.changes.length > 0 && (
          <div className="rounded-md border border-teal bg-teal-wash px-4 py-3" role="status">
            <p className="font-semibold text-teal-ink">What changed since the previous run</p>
            <ul className="mt-1 space-y-1 text-sm">
              {response.changes.map((c) => (
                <li key={c.requirementId}>
                  <button className="text-left underline-offset-2 hover:underline" onClick={() => setReqId(c.requirementId)}>
                    <span className="font-medium">{reqText(c.requirementId)}</span> moved from {ASSESSMENT_LABEL[c.before]} to{" "}
                    <strong>{ASSESSMENT_LABEL[c.after]}</strong>
                    {c.addedEvidenceIds.length > 0 && ` (${c.addedEvidenceIds.length} new record${c.addedEvidenceIds.length > 1 ? "s" : ""})`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {run && opportunity.importInfo && (
        <div className="mt-6">
          <FitSummary opportunity={opportunity} run={run} onSelect={setReqId} flows={flows} />
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <div>
          <h3 className="mb-3 font-display text-xl font-semibold">Requirements</h3>
          <RequirementList requirements={opportunity.requirements} results={results} selected={reqId} onSelect={setReqId} />
          <p className="mt-4 text-sm text-slate">{NO_EVIDENCE_NOTE}</p>
          {run && (
            <Link href="/reports" className="btn btn-secondary mt-4">
              <Icon name="report" className="size-4" /> Open qualification report
            </Link>
          )}
        </div>

        <div className="min-w-0">
          {latest.status === "loading" ? (
            <Loading label="Loading the latest results…" />
          ) : selectedResult && run ? (
            <>
              <Constellation result={selectedResult} runId={run.id} />
              {selectedResult.assessment === "cannot_assess" && <p className="mt-4 text-sm">{CANNOT_ASSESS_NOTE}</p>}
              {selectedResult.assessment !== "evidence_found" && (
                <div className="mt-4">
                  <p className="text-sm font-semibold">Your next steps for this requirement</p>
                  <div className="mt-1">
                    <NextStepList steps={nextSteps(selectedResult, flows ?? undefined)} />
                  </div>
                  <p className="mt-2 text-sm text-slate">After you add or change a record, run matching again.</p>
                </div>
              )}
            </>
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg bg-sky p-8 text-center text-white">
              <Icon name="star" className="size-8 text-star" />
              <p className="mt-3 max-w-sm text-lg">Run matching to search your history for records that fit this requirement.</p>
              <p className="mt-1 max-w-sm text-sm text-white/60">
                Older records can surface even when they use different words than the job posting.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Where this job's wording came from, and what the technician acknowledged or changed when confirming it. */
function ImportProvenance({ opportunity }: { opportunity: Opportunity }) {
  const info = opportunity.importInfo!;
  return (
    <div className="mt-3 space-y-1 text-sm text-slate">
      <p>
        {info.sourceKind === "listing_url"
          ? `Requirements quoted from the public listing, retrieved ${info.retrievedAt ? formatDate(info.retrievedAt.slice(0, 10)) : "on an unknown date"}. The listing may have changed since.`
          : "Requirements quoted from listing text you supplied (not retrieved from the employer)."}
      </p>
      {(info.removedCount > 0 || info.editedCount > 0) && (
        <p>
          {info.removedCount > 0 && `You removed ${info.removedCount} line${info.removedCount > 1 ? "s" : ""} before confirming. `}
          {info.editedCount > 0 && `You reworded ${info.editedCount} line${info.editedCount > 1 ? "s" : ""} for display; matching uses the employer's wording.`}
        </p>
      )}
      {info.warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer font-semibold text-orange-ink">Warnings you acknowledged ({info.warnings.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {info.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
