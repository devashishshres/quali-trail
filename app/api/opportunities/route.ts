import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { listWorkerOpportunities } from "@/lib/server/opportunities/queries";
import type { ListOpportunitiesResponse } from "@/lib/types";

/**
 * GET /api/opportunities
 * The signed-in worker's opportunities with ordered requirements.
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to view opportunities.");

  try {
    const body: ListOpportunitiesResponse = {
      opportunities: await listWorkerOpportunities(ctx.supabase, ctx.worker.id),
    };
    return ok(body);
  } catch (e) {
    console.error("GET /api/opportunities failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not load opportunities. Please try again.");
  }
}
