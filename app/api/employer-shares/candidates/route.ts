import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { listCandidates } from "@/lib/server/employer/packet";
import { loadCandidates } from "@/lib/server/employer/service";
import { guarded } from "@/lib/server/signoff/service";

/** GET /api/employer-shares/candidates — the technician's own work and certifications that may be selected. */
async function handleGET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return apiError("not_found", "Sharing with employers isn't available.");
  const c = await loadCandidates(ctx.worker.id);
  if (!c) return apiError("internal", "Couldn't load your records.");
  return ok(listCandidates(c));
}

export const GET = guarded(handleGET);
