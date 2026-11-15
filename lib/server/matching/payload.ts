/**
 * Build the rows to persist for one run. PURE: given each requirement's search
 * outcome, evaluate and flatten. Provider failure is represented explicitly
 * (needs_review + an honest note) and never as "no evidence found".
 */
import type { Evidence, Requirement, RequirementResult } from "@/lib/types";
import type { MemoryHit } from "../memory/types";
import { resolveCandidates } from "./candidates";
import { evaluateRequirement } from "./evaluate";

export type SearchOutcome = { ok: true; hits: MemoryHit[] } | { ok: false };

export interface RunPayload {
  results: RequirementResult[];
  memoryWarning: string | null;
  searchFailures: number;
}

export function buildRunPayload(
  requirements: Requirement[],
  outcomes: SearchOutcome[],
  evidence: Evidence[],
  today: string,
): RunPayload {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  let failures = 0;

  const results = requirements.map((req, i): RequirementResult => {
    const outcome = outcomes[i];
    if (!outcome.ok) {
      failures += 1;
      return {
        requirementId: req.id,
        originalText: req.originalText,
        mandatory: req.mandatory,
        assessment: "needs_review",
        connections: [],
        explanation: "Memory search was unavailable for this requirement, so your records could not be checked. This is not a finding that evidence is missing.",
        uncertainties: ["Memory search failed for this requirement."],
        missingDocumentation: [],
      };
    }
    return evaluateRequirement(req, resolveCandidates(outcome.hits, byId).candidates, today);
  });

  const warnings: string[] = [];
  if (failures > 0) {
    warnings.push(`Memory search failed for ${failures} of ${requirements.length} requirements; those are marked "needs review", not "no evidence".`);
  }
  const unsearchable = evidence.filter((e) => e.indexStatus !== "indexed").length;
  if (unsearchable > 0) {
    warnings.push(
      `${unsearchable} of ${evidence.length} records are not searchable in memory yet (waiting, processing or failed), so they could not be considered.`,
    );
  }
  return { results, memoryWarning: warnings.length ? warnings.join(" ") : null, searchFailures: failures };
}

/** Flatten to the JSON the finalize_match_run function takes. */
export function toDbPayload(results: RequirementResult[]) {
  return {
    results: results.map((r) => ({
      requirement_id: r.requirementId,
      assessment: r.assessment,
      explanation: r.explanation,
      uncertainties: r.uncertainties,
      missing_documentation: r.missingDocumentation,
    })),
    matches: results.flatMap((r) =>
      r.connections.map((c) => ({
        requirement_id: r.requirementId,
        evidence_id: c.evidenceId,
        role: c.role,
        contribution: c.contribution,
        relevance_explanation: c.relevanceExplanation,
        memory_similarity: c.memorySimilarity,
      })),
    ),
  };
}
