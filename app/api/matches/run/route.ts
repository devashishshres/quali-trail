import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { searchWorkerMemory } from "@/lib/server/memory/search";
import { getWorkerOpportunity } from "@/lib/server/opportunities/queries";
import { RunInProgressError, executeMatch } from "@/lib/server/matching/run";
import { MatchingSetupError, readRunResponse, supabasePorts } from "@/lib/server/matching/store";
import { createAdminClient } from "@/lib/supabase/admin";
import { RunMatchRequest } from "@/lib/types";

/**
 * POST /api/matches/run  { opportunityId }
 * Searches the worker's memory for each requirement, evaluates, and saves a run.
 * The worker comes from the session, never from the request body.
 */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to run matching.");

  const body = RunMatchRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "opportunityId must be a valid id.");

  try {
    const opportunity = await getWorkerOpportunity(ctx.supabase, ctx.worker.id, body.data.opportunityId);
    if (!opportunity) return apiError("not_found", "That opportunity isn't available.");

    const ports = supabasePorts({ user: ctx.supabase, admin: createAdminClient(), workerId: ctx.worker.id, search: searchWorkerMemory });
    const outcome = await executeMatch(ports, ctx.worker.id, opportunity);

    if (outcome.status === "failed") {
      return apiError("memory_unavailable", "Memory search is unavailable right now, so no records could be checked. Try again shortly.");
    }
    const response = await readRunResponse(ctx.supabase, ctx.worker.id, outcome.runId);
    if (!response) return apiError("internal", "The run finished but could not be read back.");
    return ok(response);
  } catch (e) {
    if (e instanceof MatchingSetupError) return apiError("internal", "Matching is not available yet. The project owner needs to finish setup before you can run it.");
    if (e instanceof RunInProgressError) return apiError("rate_limited", "A matching run is already in progress for this job. Wait a moment and try again.");
    console.error("POST /api/matches/run failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Matching didn't finish. Please try again.");
  }
}
