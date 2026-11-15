import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { getWorkerOpportunity } from "@/lib/server/opportunities/queries";
import { latestRunId, readRunResponse } from "@/lib/server/matching/store";
import { LatestMatchQuery } from "@/lib/types";

/**
 * GET /api/matches/latest?opportunityId=…
 * The newest saved run (completed, or stale and labelled so). 404 not_found
 * when there is none; processing and failed runs are never returned.
 */
export async function GET(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to view match results.");

  const query = LatestMatchQuery.safeParse({ opportunityId: new URL(request.url).searchParams.get("opportunityId") });
  if (!query.success) return apiError("validation_failed", "opportunityId must be a valid id.");

  try {
    // Ownership first: someone else's opportunity looks exactly like a missing one.
    if (!(await getWorkerOpportunity(ctx.supabase, ctx.worker.id, query.data.opportunityId))) {
      return apiError("not_found", "That opportunity isn't available.");
    }
    const id = await latestRunId(ctx.supabase, ctx.worker.id, query.data.opportunityId);
    if (!id) return apiError("not_found", "No match has been run for this opportunity yet.");
    const response = await readRunResponse(ctx.supabase, ctx.worker.id, id);
    return response ? ok(response) : apiError("not_found", "No match has been run for this opportunity yet.");
  } catch (e) {
    console.error("GET /api/matches/latest failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not load match results. Please try again.");
  }
}
