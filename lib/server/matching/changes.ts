import type { RequirementChange, RequirementResult } from "@/lib/types";

/**
 * Before/after between two runs of the same opportunity. Only requirements
 * whose assessment actually changed are reported; `addedEvidenceIds` lists the
 * records linked now that were not linked before. Nothing is assumed.
 */
export function computeChanges(previous: RequirementResult[], current: RequirementResult[]): RequirementChange[] {
  const before = new Map(previous.map((r) => [r.requirementId, r]));
  const changes: RequirementChange[] = [];
  for (const after of current) {
    const prev = before.get(after.requirementId);
    if (!prev || prev.assessment === after.assessment) continue;
    const had = new Set(prev.connections.map((c) => c.evidenceId));
    changes.push({
      requirementId: after.requirementId,
      before: prev.assessment,
      after: after.assessment,
      addedEvidenceIds: after.connections.map((c) => c.evidenceId).filter((id) => !had.has(id)),
    });
  }
  return changes;
}
