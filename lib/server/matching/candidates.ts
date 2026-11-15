/**
 * Turn raw memory hits into evaluator candidates. PURE.
 * A hit is only a pointer: nothing from memory is shown or trusted. We keep a
 * hit only if it resolves to a CURRENT, INDEXED row that belongs to this worker.
 */
import type { Evidence } from "@/lib/types";
import type { MemoryHit } from "../memory/types";
import type { Candidate } from "./evaluate";

export type RejectReason = "not_found_for_worker" | "not_indexed" | "outdated_version" | "version_from_future";

export interface ResolvedCandidates {
  candidates: Candidate[];
  rejected: { evidenceId: string; reason: RejectReason }[];
}

export function resolveCandidates(hits: MemoryHit[], workerEvidence: Map<string, Evidence>): ResolvedCandidates {
  const candidates: Candidate[] = [];
  const rejected: ResolvedCandidates["rejected"] = [];

  // Group by record. A hit counts only if it is the CURRENT version; the best
  // current-version similarity wins, so an older copy can never shadow it.
  const byRecord = new Map<string, MemoryHit[]>();
  for (const h of hits) byRecord.set(h.evidenceId, [...(byRecord.get(h.evidenceId) ?? []), h]);

  for (const [evidenceId, group] of byRecord) {
    const e = workerEvidence.get(evidenceId);
    if (!e) {
      rejected.push({ evidenceId, reason: "not_found_for_worker" }); // foreign, deleted or invented
      continue;
    }
    if (e.indexStatus !== "indexed") {
      rejected.push({ evidenceId, reason: "not_indexed" }); // content changed or indexing failed
      continue;
    }
    const current = group.filter((h) => h.version === e.version);
    if (current.length === 0) {
      const reason = group.some((h) => h.version > e.version) ? "version_from_future" : "outdated_version";
      rejected.push({ evidenceId, reason });
      continue;
    }
    const best = current.reduce((a, b) => (b.similarity > a.similarity ? b : a));
    candidates.push({ evidence: e, memorySimilarity: best.similarity });
  }
  candidates.sort((a, b) => (b.memorySimilarity ?? 0) - (a.memorySimilarity ?? 0));
  return { candidates, rejected };
}
