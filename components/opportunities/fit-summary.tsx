import type { EvidenceAssessment, MatchRun, Opportunity, RequirementPriority } from "@/lib/types";
import type { ConfirmFlows } from "@/lib/next-steps";
import { ASSESSMENT_LABEL, FIT_NOTE, PRIORITY_LABEL } from "@/lib/client/labels";
import { AssessmentDisc } from "../ui/status";
import { NextStepsSection } from "./next-steps";

const ORDER: EvidenceAssessment[] = ["evidence_found", "needs_review", "no_sufficient_evidence", "cannot_assess"];
const GROUPS: RequirementPriority[] = ["required", "preferred", "unspecified"];

/**
 * "Your evidence fit": counts of each assessment, grouped by the job's stated priority. Plain counts only:
 * no score, percentage or likelihood. On screen it is followed by "Your next steps"; the printed report shows those
 * in its own section.
 */
export function FitSummary({ opportunity, run, onSelect, flows, print = false }: { opportunity: Opportunity; run: MatchRun; onSelect?: (id: string) => void; flows?: ConfirmFlows | null; print?: boolean }) {
  const byId = new Map(run.results.map((r) => [r.requirementId, r]));
  const groups = GROUPS.map((g) => ({
    g,
    reqs: opportunity.requirements.filter((r) => (r.priority ?? "unspecified") === g),
  })).filter((x) => x.reqs.length > 0);

  return (
    <section className={`${print ? "" : "sheet "}p-5 sm:p-6 break-inside-avoid`} aria-labelledby="fit-title">
      <h3 id="fit-title" className="font-display text-xl font-semibold">Your evidence fit</h3>
      <p className="mt-1 max-w-prose text-sm text-slate">{FIT_NOTE}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {groups.map(({ g, reqs }) => {
          const counts = ORDER.map((a) => ({ a, n: reqs.filter((r) => byId.get(r.id)?.assessment === a).length }));
          return (
            <div key={g} className="rounded-md border border-line bg-white p-4">
              <p className="font-semibold">
                {PRIORITY_LABEL[g]} <span className="font-normal text-slate">({reqs.length})</span>
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {counts.map(({ a, n }) => (
                  <li key={a} className={`flex items-center gap-2 ${n === 0 ? "text-slate" : ""}`}>
                    <AssessmentDisc assessment={a} />
                    <span className="flex-1">{ASSESSMENT_LABEL[a]}</span>
                    <span className="font-semibold">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {!print && (
        <div className="mt-6 border-t border-line pt-4">
          <NextStepsSection opportunity={opportunity} run={run} flows={flows} />
          {onSelect && (
            <p className="mt-2 text-sm text-slate">Select a requirement in the list below to see the records linked to it.</p>
          )}
        </div>
      )}
    </section>
  );
}
