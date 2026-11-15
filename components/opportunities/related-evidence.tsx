"use client";
import Link from "next/link";
import { useState } from "react";
import type { MatchRun, Opportunity, RequirementExplanation, RunExplanations } from "@/lib/types";
import { explainMatch, toApiError } from "@/lib/client/api";
import type { ApiRequestError } from "@/lib/client/errors";
import { Icon } from "../ui/icons";

export const RELATED_TITLE = "Related evidence — AI-assisted explanation";
export const RELATED_NOTE =
  "Not a checked match. It does not change the assessment above, any verification status or the counts. AI-written parts can be wrong; the record titles and the task check come from your records' own wording.";

const KIND_NOTE: Record<RequirementExplanation["kind"], string | null> = {
  ai: null,
  no_related: "No related record was found among your saved records. Nothing here suggests you can or can't do this.",
  eligibility: "This is an eligibility condition. It was not sent to the AI and is never inferred from records.",
  ai_unavailable: "The AI-assisted part isn't available for this line. Only what your records' wording shows is listed.",
};

/** One requirement's related-evidence explanation. Links show on screen only. */
export function RelatedEvidencePanel({ item, heading = true }: { item: RequirementExplanation; heading?: boolean }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-white p-4 text-sm" data-related-kind={item.kind}>
      {heading && (
        <>
          <p className="font-semibold">{RELATED_TITLE}</p>
          <p className="mt-1 text-xs text-slate">{RELATED_NOTE}</p>
        </>
      )}
      {item.stale && <p className="mt-2 font-semibold text-orange-ink">A cited record changed after this was written. Run matching again for a current explanation.</p>}
      {KIND_NOTE[item.kind] && <p className="mt-2">{KIND_NOTE[item.kind]}</p>}
      {item.asks && (
        <p className="mt-2">
          <span className="font-semibold">What this asks for (AI-written): </span>
          {item.asks}
        </p>
      )}
      {item.breakdown && (
        <p className="mt-2" data-breakdown>
          <span className="font-semibold">From your records&apos; wording: </span>
          {item.breakdown.sentence}
        </p>
      )}
      {item.clarification && (
        <p className="mt-2">
          <span className="font-semibold">What would need clarifying: </span>
          {item.clarification}
        </p>
      )}
      {item.related.length > 0 && (
        <div className="mt-2">
          <p className="font-semibold">Records that may relate{item.kind === "ai" ? " (AI-written descriptions)" : ""}</p>
          <ul className="mt-1 space-y-1" data-related-records>
            {item.related.map((r) => (
              <li key={r.evidenceId}>
                <span className="font-medium">{r.evidenceTitle}</span>: {r.documents}{" "}
                <Link href={`/evidence#evidence-${r.evidenceId}`} className="no-print underline underline-offset-2">
                  Open record
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.unclear.length > 0 && (
        <div className="mt-2">
          <p className="font-semibold">Not established or unclear</p>
          <ul className="mt-1 list-disc pl-5">
            {item.unclear.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {item.nextStep && (
        <p className="mt-2">
          <span className="font-semibold">Suggested next step{item.kind === "ai" ? " (AI-written)" : ""}: </span>
          {item.nextStep}
        </p>
      )}
    </div>
  );
}

/** All explained lines of a run, in requirement order (fit view and report). */
export function RelatedEvidenceSection({ opportunity, explanations }: { opportunity: Opportunity; explanations: RunExplanations }) {
  const byReq = new Map(explanations.items.map((x) => [x.requirementId, x]));
  const items = opportunity.requirements.filter((q) => byReq.has(q.id));
  return (
    <section className="break-inside-avoid" data-section="related-evidence" aria-labelledby="related-title">
      <h3 id="related-title" className="font-display text-xl font-semibold">{RELATED_TITLE}</h3>
      <p className="mt-1 max-w-prose text-sm text-slate">{RELATED_NOTE}</p>
      {explanations.aiStatus === "failed" && (
        <p className="mt-2 text-sm font-semibold text-orange-ink" role="status">
          The AI step failed, so only what your records&apos; wording shows is listed. Your checked results and next steps are unchanged.
        </p>
      )}
      {explanations.rejectedReferences > 0 && (
        <p className="mt-2 text-sm text-slate">
          {explanations.rejectedReferences} reference{explanations.rejectedReferences > 1 ? "s" : ""} the AI gave did not match a record you supplied and{" "}
          {explanations.rejectedReferences > 1 ? "were" : "was"} removed.
        </p>
      )}
      <ol className="mt-3 space-y-4">
        {items.map((q) => (
          <li key={q.id} className="break-inside-avoid">
            <p className="text-sm font-medium">{q.originalText}</p>
            <div className="mt-1">
              <RelatedEvidencePanel item={byReq.get(q.id)!} heading={false} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Offers explanations for a CURRENT run that has lines the checker could not assess. Sends nothing to anyone. */
export function ExplainBlock({ run, opportunity, explanations, enabled, onReady }: { run: MatchRun; opportunity: Opportunity; explanations: RunExplanations | null | undefined; enabled: boolean; onReady: (x: RunExplanations) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const lines = run.results.filter((r) => r.assessment === "cannot_assess").length;
  if (explanations?.status === "completed") return <RelatedEvidenceSection opportunity={opportunity} explanations={explanations} />;
  if (!enabled || !lines || run.status !== "completed") return null;
  async function go() {
    setBusy(true);
    setError(null);
    try {
      onReady((await explainMatch(run.id)).explanations);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-md border border-dashed border-line p-4 text-sm" data-section="explain-offer">
      <p className="font-semibold">{RELATED_TITLE}</p>
      <p className="mt-1 max-w-prose text-slate">
        {lines} line{lines > 1 ? "s" : ""} couldn&apos;t be assessed automatically. QualiTrail can look for related records and ask an AI model to
        explain how they relate. It sends only those requirement lines and the related records&apos; titles, dates, skills, work performed and
        equipment: never your summary, files, signatures, customer details or comments. It does not change your checked results.
      </p>
      <button className="btn btn-secondary mt-3" onClick={go} disabled={busy}>
        <Icon name="star" className="size-4" /> {busy ? "Preparing explanations…" : "Explain related evidence"}
      </button>
      {error && (
        <p className="mt-2 text-danger" role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}
