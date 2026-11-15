import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { DELIVERY_FAILURE_MESSAGE } from "@/lib/server/email/deliver";
import { notifyReviewRequested } from "@/lib/server/accounts/notify";
import { allow, rpc } from "@/lib/server/signoff/service";
import { listWorkerReviews } from "@/lib/server/accounts/reviews";
import { CreateReviewRequest } from "@/lib/types";

const REASON: Record<string, string> = {
  not_found: "That record isn't available.",
  no_relationship: "Choose a supervisor who has accepted your invitation.",
  self: "You can't review your own work.",
  unsupported_type: "Supervisor review is available for work records and checklists only.",
  not_eligible: "This record can't be sent for review in its current verification state.",
  duplicate_open: "This supervisor already has an open request for this record.",
};

/** GET /api/reviews?evidenceId=… — this worker's supervisor reviews. */
export async function GET(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return ok({ reviews: [] });
  const evidenceId = new URL(request.url).searchParams.get("evidenceId");
  if (evidenceId && !z.uuid().safeParse(evidenceId).success) return apiError("validation_failed", "That isn't a valid record id.");
  try {
    return ok({ reviews: await listWorkerReviews(ctx.worker.id, evidenceId ?? undefined) });
  } catch {
    return apiError("internal", "Couldn't load reviews.");
  }
}

/** POST /api/reviews { evidenceId, relationshipId } — freeze a snapshot and notify the supervisor. */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return apiError("not_found", "Supervisor review isn't available.");
  const body = CreateReviewRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Choose a record and a supervisor.", fieldErrors(body.error));
  if (!(await allow("review-create-worker", ctx.worker.id, 3600, 30))) return apiError("rate_limited", "Too many requests this hour.");
  const r = await rpc("review_create", { p_worker: ctx.worker.id, p_evidence: body.data.evidenceId, p_relationship: body.data.relationshipId, p_valid_days: 30, p_share_original: body.data.shareOriginal });
  if (!r.ok) return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", REASON[String(r.reason)] ?? "Couldn't create the request.");
  const sent = await notifyReviewRequested({ requestId: String(r.id), supervisorAuthUserId: String(r.supervisorAuthUserId), workerName: String(r.workerName), workerId: ctx.worker.id, attempt: 0 });
  // The request exists either way (it is in the supervisor's dashboard); a failed email is reported, not hidden.
  return ok({ id: r.id, notified: sent.ok, notice: sent.ok ? null : `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The request is waiting in their QualiTrail dashboard.` }, 201);
}
