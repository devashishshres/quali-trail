import type { Requirement, RequirementResult } from "@/lib/types";
import { ASSESSMENT_LABEL, PRIORITY_LABEL } from "@/lib/client/labels";
import { AssessmentDisc } from "../ui/status";

export function RequirementList({
  requirements,
  results,
  selected,
  onSelect,
}: {
  requirements: Requirement[];
  results: Map<string, RequirementResult>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className="space-y-2" aria-label="Job requirements">
      {requirements.map((r) => {
        const result = results.get(r.id);
        const active = r.id === selected;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              aria-current={active ? "true" : undefined}
              className={`w-full rounded-md border px-4 py-3 text-left transition-colors ${
                active ? "border-navy bg-white shadow-[inset_4px_0_0_var(--color-orange)]" : "border-line bg-white/60 hover:border-navy/40 hover:bg-white"
              }`}
            >
              <span className="flex items-start gap-3">
                {result ? (
                  <AssessmentDisc assessment={result.assessment} className="mt-1 size-4" />
                ) : (
                  <span className="mt-1 size-4 shrink-0 rounded-full border-2 border-dotted border-line" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  {/* Original wording, never rewritten */}
                  <span className="block font-medium leading-snug">{r.originalText}</span>
                  {r.displayText && (
                    <span className="mt-1 block text-xs text-slate">
                      Your wording (display only, not used for matching): {r.displayText}
                    </span>
                  )}
                  <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate">
                    <span className="font-semibold">{result ? ASSESSMENT_LABEL[result.assessment] : "Not assessed yet"}</span>
                    <span>
                      {r.priority ? PRIORITY_LABEL[r.priority] : r.mandatory ? "Required" : "Optional"}
                      {r.priority && r.originalPriority && r.priority !== r.originalPriority && ` (listing: ${PRIORITY_LABEL[r.originalPriority]})`}
                    </span>
                    {result && <span>{result.connections.length} linked records</span>}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
