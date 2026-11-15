import { connection } from "next/server";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { listCandidates } from "@/lib/server/employer/packet";
import { loadCandidates } from "@/lib/server/employer/service";
import { guarded, off } from "@/lib/server/signoff/service";

/** GET /api/employer-shares/candidates — the technician's own work and certifications that may be selected. */
async function handleGET() {
  await connection(); // per request, never prerendered
  if (!employerReviewEnabled()) return off(); // disabled: absent for everyone, before any sign-in or role check
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const c = await loadCandidates(ctx.worker.id);
  if (!c) return apiError("internal", "Couldn't load your records.");
  return ok(listCandidates(c));
}

export const GET = guarded(handleGET);
