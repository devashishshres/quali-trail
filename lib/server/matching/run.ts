/**
 * Match-run orchestration. PURE w.r.t. infrastructure: everything external
 * (database RPCs, evidence loading, memory search, clock) comes in as `ports`,
 * so provider failures, stale races and retries are unit-testable.
 *
 * Order matters:
 *   1. start the run  -> database records the worker's evidence revision
 *   2. load evidence  -> AFTER start, so any later change is detected
 *   3. search memory  -> provider calls, outside any database transaction
 *   4. finalize       -> one atomic database call; returns 'stale' if evidence changed
 */
import type { Evidence, Opportunity } from "@/lib/types";
import { MemorySearchError, type MemorySearcher } from "../memory/types";
import { buildRunPayload, toDbPayload, type RunPayload, type SearchOutcome } from "./payload";

export class RunInProgressError extends Error {}

export interface MatchPorts {
  startRun(opportunityId: string): Promise<{ runId: string }>;
  loadEvidence(): Promise<Evidence[]>;
  search: MemorySearcher;
  finalize(runId: string, db: ReturnType<typeof toDbPayload>, memoryWarning: string | null): Promise<"completed" | "stale">;
  fail(runId: string, error: string, memoryWarning: string | null): Promise<void>;
  today(): string;
}

export type RunOutcome =
  | { status: "completed" | "stale"; runId: string }
  | { status: "failed"; runId: string; reason: "memory_unavailable" };

const MAX_ATTEMPTS = 2; // one automatic retry when evidence changed mid-run

export async function executeMatch(ports: MatchPorts, workerId: string, opportunity: Opportunity): Promise<RunOutcome> {
  let last: RunOutcome | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { runId } = await ports.startRun(opportunity.id);
    try {
      const evidence = await ports.loadEvidence();

      const outcomes: SearchOutcome[] = [];
      for (const req of opportunity.requirements) {
        try {
          outcomes.push({ ok: true, hits: await ports.search(workerId, req.criteria.retrievalQuery) });
        } catch (e) {
          if (!(e instanceof MemorySearchError)) throw e; // a bug, not a provider outage
          outcomes.push({ ok: false });
        }
      }

      if (opportunity.requirements.length > 0 && outcomes.every((o) => !o.ok)) {
        const warning = "Memory search was unavailable, so no records were checked.";
        await ports.fail(runId, "memory search unavailable", warning);
        return { status: "failed", runId, reason: "memory_unavailable" };
      }

      const payload: RunPayload = buildRunPayload(opportunity.requirements, outcomes, evidence, ports.today());
      const status = await ports.finalize(runId, toDbPayload(payload.results), payload.memoryWarning);
      last = { status, runId };
      if (status === "completed") return last;
      // stale: evidence changed while we worked. Loop once with fresh evidence.
    } catch (e) {
      await ports.fail(runId, e instanceof Error ? e.message : "unexpected error", null).catch(() => {});
      throw e;
    }
  }
  return last!;
}
