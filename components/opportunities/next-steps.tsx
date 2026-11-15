import Link from "next/link";
import type { MatchRun, Opportunity, Requirement } from "@/lib/types";
import { NEXT_STEPS_NOTE, NEXT_STEPS_TITLE, NO_FLOWS, nextSteps, type ConfirmFlows, type NextStep } from "@/lib/next-steps";
import { PRIORITY_LABEL } from "@/lib/client/labels";

/** One requirement's steps. Links are omitted when printing; the text says where to go. */
export function NextStepList({ steps, print = false }: { steps: NextStep[]; print?: boolean }) {
  return (
    <ul className="space-y-2" data-next-steps>
      {steps.map((s, i) => (
        <li key={i} data-step-kind={s.kind} className="text-sm">
          <span className="font-semibold">{NEXT_STEPS_TITLE[s.kind]}</span>
          {s.part && <span className="text-slate"> ({s.part})</span>}
          <span className="block">{s.text}</span>
          {!print && s.links.length > 0 && (
            <span className="no-print mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {s.links.map((l) => (
                <Link key={l.href} href={l.href} className="font-semibold underline underline-offset-2">
                  {l.label}
                </Link>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const rank = (r: Requirement) => {
  const p = r.priority ?? (r.mandatory ? "required" : "preferred");
  return p === "required" ? 0 : p === "preferred" ? 1 : 2;
};

/**
 * "Your next steps" for a whole job, from the saved run only. Requirements with documentation found have no
 * step and are left out. Required lines first.
 */
export function NextStepsSection({ opportunity, run, flows, print = false }: { opportunity: Opportunity; run: MatchRun; flows?: ConfirmFlows | null; print?: boolean }) {
  const reqs = [...opportunity.requirements].sort((a, b) => rank(a) - rank(b) || a.position - b.position);
  const byId = new Map(run.results.map((r) => [r.requirementId, r]));
  const items = reqs
    .map((q) => ({ q, steps: byId.has(q.id) ? nextSteps(byId.get(q.id)!, flows ?? NO_FLOWS) : [] }))
    .filter((x) => x.steps.length > 0);

  return (
    <section aria-labelledby="next-steps-title" className="break-inside-avoid" data-section="next-steps">
      <h3 id="next-steps-title" className="font-display text-xl font-semibold">Your next steps</h3>
      <p className="mt-1 max-w-prose text-sm text-slate">{NEXT_STEPS_NOTE}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm">No steps: a supplied document was found for every requirement.</p>
      ) : (
        <ol className="mt-3 space-y-4">
          {items.map(({ q, steps }) => (
            <li key={q.id} className="break-inside-avoid border-l-2 border-line pl-3">
              <p className="text-sm font-medium">
                {q.originalText}
                {q.priority && <span className="font-normal text-slate"> · {PRIORITY_LABEL[q.priority]}</span>}
              </p>
              <div className="mt-1">
                <NextStepList steps={steps} print={print} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-sm text-slate">After you add or change a record, run matching again. Saved results do not update by themselves.</p>
    </section>
  );
}
