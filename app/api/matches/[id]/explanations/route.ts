import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { describeProblems } from "@/lib/server/config";
import { stubSimilarity } from "@/lib/server/explanations/analysis";
import { explanationsConfigProblems, explanationsEnabled, explanationsMode } from "@/lib/server/explanations/config";
import { explainRun } from "@/lib/server/explanations/service";
import { explanationPorts } from "@/lib/server/explanations/store";
import { loadWorkerEvidence, readRun } from "@/lib/server/matching/store";
import { searchWorkerMemory } from "@/lib/server/memory/search";
import type { MemorySearcher } from "@/lib/server/memory/types";
import { getWorkerOpportunity } from "@/lib/server/opportunities/queries";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;

/**
 * POST /api/matches/:id/explanations — "Related evidence — AI-assisted explanation" for one saved, CURRENT run.
 * Never changes the run's checked results. One generation per run (repeat requests return the saved one).
 * 404 when the feature is off, as if the route did not exist.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!explanationsEnabled()) return apiError("not_found", "Not found.");
  const problems = explanationsConfigProblems();
  if (problems.length) {
    logSignoffError("explanations-config", new Error(describeProblems(problems)));
    return apiError("unavailable", "AI-assisted explanations aren't available on this server right now.");
  }
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to see explanations.");
  if (!(await allow("explain", ctx.worker.id, 3600, 30))) return apiError("rate_limited", "Too many requests. Please wait a few minutes.");

  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid match id.");

  try {
    const run = await readRun(ctx.supabase, ctx.worker.id, id.data);
    if (!run) return apiError("not_found", "That match run isn't available.");
    const opportunity = await getWorkerOpportunity(ctx.supabase, ctx.worker.id, run.opportunityId);
    if (!opportunity) return apiError("not_found", "That match run isn't available.");
    const evidence = await loadWorkerEvidence(ctx.supabase, ctx.worker.id);

    // Stub mode (isolated local only, enforced by config): deterministic word-overlap scores instead of Supermemory.
    const stubSearch: MemorySearcher = async (_w, q) => evidence.map((e) => ({ evidenceId: e.id, version: e.version, similarity: stubSimilarity(q, e) }));
    const ports = explanationPorts({ admin: createAdminClient(), workerId: ctx.worker.id, search: explanationsMode() === "stub" ? stubSearch : searchWorkerMemory, jobTitle: opportunity.title });
    const out = await explainRun(ports, { run, opportunity, evidence });
    if (out.kind === "done") return ok({ explanations: out.explanations });
    const code = out.code === "limited" || out.code === "busy" ? "rate_limited" : out.code === "memory_unavailable" ? "memory_unavailable" : out.code === "exhausted" ? "unavailable" : "validation_failed";
    return apiError(code, out.message);
  } catch (e) {
    console.error("POST /api/matches/:id/explanations failed", { message: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
    return apiError("internal", "Explanations couldn't be prepared. Your checked results are unchanged.");
  }
}
