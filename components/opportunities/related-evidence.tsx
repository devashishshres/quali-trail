"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { MatchRun, Opportunity, RequirementExplanation, RunExplanations } from "@/lib/types";
import { explainMatch, toApiError } from "@/lib/client/api";
import type { ApiRequestError } from "@/lib/client/errors";
import { Icon } from "../ui/icons";

export const RELATED_TITLE = "Related evidence — AI-assisted explanation";
export const RELATED_NOTE =
  "Not a checked match. It does not change the assessment above, any verification status or the counts. AI-written parts are labelled and can be wrong; the task check and the quotes come from your records' own wording.";

const WITHHELD: Record<NonNullable<RequirementExplanation["withheld"]>, string> = {
  unknown_reference: "it cited a record that wasn't supplied for this line",
  inconsistent: "its record choices didn't agree with its own answer",
  missing: "the AI gave no usable answer for this line",
  reference_in_text: "its wording referred to records by internal labels",
  worker_claim: "it made a statement about you or your ability that your records' wording doesn't back",
  fulfilment_claim: "it said or implied that a requirement is met",
  contradicts_records: "it described work differently from what your records say (for example as done when the record says assisted)",
};

const KIND_NOTE: Record<RequirementExplanation["kind"], string | null> = {
  ai: null,
  no_related: "No related record was found among your saved records. Nothing here suggests you can or can't do this.",
  eligibility: "This is an eligibility condition. It was not sent to the AI and is never inferred from records.",
  ai_unavailable: "The AI-assisted part isn't available for this line. Only what your records' wording shows is listed.",
};

/** One requirement's related-evidence explanation. Links show on screen only. */
export function RelatedEvidencePanel({ item, heading = true, hideNextStep = false }: { item: RequirementExplanation; heading?: boolean; hideNextStep?: boolean }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-white p-4 text-sm" data-related-kind={item.kind}>
      {heading && (
        <>
          <p className="font-semibold">{RELATED_TITLE}</p>
          <p className="mt-1 text-xs text-slate">{RELATED_NOTE}</p>
        </>
      )}
      {item.stale && <p className="mt-2 font-semibold text-orange-ink" data-stale>Out of date: your records changed after this was written. Run matching again for a current explanation.</p>}
      {item.withheld && <p className="mt-2" data-withheld={item.withheld}>The AI text for this line was withheld because {WITHHELD[item.withheld]}.</p>}
      {KIND_NOTE[item.kind] && <p className="mt-2">{KIND_NOTE[item.kind]}</p>}
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
          <p className="font-semibold">{item.kind === "ai" ? "Records the AI linked to this line (quoted from each record)" : "Records that may relate (quoted from each record)"}</p>
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
      {item.nextStep && !hideNextStep && (
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
  // A next step shared by several lines is listed once, after the lines, instead of repeated under each.
  const stepCount = new Map<string, number>();
  const aiStep = new Set<string>(); // shared steps written by the AI keep their label
  for (const q of items) {
    const it = byReq.get(q.id)!;
    if (!it.nextStep) continue;
    stepCount.set(it.nextStep, (stepCount.get(it.nextStep) ?? 0) + 1);
    if (it.kind === "ai") aiStep.add(it.nextStep);
  }
  const shared = [...stepCount].filter(([, n]) => n > 1);
  return (
    <section className="break-inside-avoid" data-section="related-evidence" aria-labelledby="related-title">
      <h3 id="related-title" className="font-display text-xl font-semibold">{RELATED_TITLE}</h3>
      <p className="mt-1 max-w-prose text-sm text-slate">{RELATED_NOTE}</p>
      {!explanations.current && (
        <p className="mt-2 text-sm font-semibold text-orange-ink" role="status" data-out-of-date>
          Out of date: your records changed after this explanation was written. It is kept for reference only. Run matching again, then ask for a new explanation.
        </p>
      )}
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
              <RelatedEvidencePanel item={byReq.get(q.id)!} heading={false} hideNextStep={(stepCount.get(byReq.get(q.id)!.nextStep ?? "") ?? 0) > 1} />
            </div>
          </li>
        ))}
      </ol>
      {shared.length > 0 && (
        <div className="mt-4 text-sm" data-shared-steps>
          <p className="font-semibold">Next step for several lines</p>
          <ul className="mt-1 list-disc pl-5">
            {shared.map(([step, n]) => (
              <li key={step} data-shared-step-kind={aiStep.has(step) ? "ai" : "fixed"}>
                {aiStep.has(step) && <span className="font-semibold">(AI-written) </span>}
                {step} <span className="text-slate">({n} lines)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Offers explanations for a CURRENT run that has lines the checker could not assess. Sends nothing to anyone. */
export function ExplainBlock({ run, opportunity, explanations, enabled, onReady }: { run: MatchRun; opportunity: Opportunity; explanations: RunExplanations | null | undefined; enabled: boolean; onReady: (x: RunExplanations) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const inFlight = useRef(false); // a second click before the button re-renders sends nothing
  const lines = run.results.filter((r) => r.assessment === "cannot_assess").length;
  if (explanations?.status === "completed") return <RelatedEvidenceSection opportunity={opportunity} explanations={explanations} />;
  if (!enabled || !lines || run.status !== "completed") return null;
  async function go() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onReady((await explainMatch(run.id)).explanations);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="rounded-md border border-dashed border-line p-4 text-sm" data-section="explain-offer">
      <p className="font-semibold">{RELATED_TITLE}</p>
      <p className="mt-1 max-w-prose text-slate">
        {lines} line{lines > 1 ? "s" : ""} couldn&apos;t be assessed automatically. QualiTrail can look for related records and ask an AI model
        (Google Gemini) to explain how they relate. It sends those requirement lines and, for related records only, their type, title, skills,
        work performed, equipment and status. Emails, phone numbers and street addresses are removed, but this is redacted, not anonymous:
        names or places you typed into those fields are sent as written. It never sends your summary, files, signatures, customer details,
        comments or profile. It does not change your checked results.
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
