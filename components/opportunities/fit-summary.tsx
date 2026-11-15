import Link from "next/link";
import type { EvidenceAssessment, MatchRun, Opportunity, RequirementPriority } from "@/lib/types";
import { ASSESSMENT_LABEL, FIT_NOTE, PRIORITY_LABEL } from "@/lib/client/labels";
import { AssessmentDisc } from "../ui/status";

const ORDER: EvidenceAssessment[] = ["evidence_found", "needs_review", "no_sufficient_evidence", "cannot_assess"];
const GROUPS: RequirementPriority[] = ["required", "preferred", "unspecified"];

/**
 * "Your evidence fit": counts of each assessment, grouped by the job's stated priority. Plain counts only:
 * no score, percentage or likelihood. Gaps link to My Evidence.
 */
export function FitSummary({ opportunity, run, onSelect, print = false }: { opportunity: Opportunity; run: MatchRun; onSelect?: (id: string) => void; print?: boolean }) {
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
        <div className="mt-4 text-sm">
          {(() => {
            const gaps = opportunity.requirements.filter((r) => ["needs_review", "no_sufficient_evidence"].includes(byId.get(r.id)?.assessment ?? ""));
            if (!gaps.length) return null;
            return (
              <>
                <p className="font-semibold">Documentation you could add</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {gaps.map((r) => (
                    <li key={r.id}>
                      {onSelect ? (
                        <button className="text-left underline underline-offset-2" onClick={() => onSelect(r.id)}>
                          {r.originalText}
                        </button>
                      ) : (
                        r.originalText
                      )}
                    </li>
                  ))}
                </ul>
                <Link href="/evidence" className="mt-2 inline-block font-semibold underline underline-offset-2">
                  Add a record in My Evidence
                </Link>
              </>
            );
          })()}
        </div>
      )}
    </section>
  );
}
