import { z } from "zod";
import { getSupervisorContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { notifyReviewDecided } from "@/lib/server/accounts/notify";
import { REVIEW_STATEMENT_VERSION } from "@/lib/server/accounts/review-text";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, rpc } from "@/lib/server/signoff/service";
import { ReviewRespondRequest } from "@/lib/types";

const MESSAGE: Record<string, string> = {
  tasks_required: "Select at least one task you personally observed.",
  unknown_task: "Select tasks from the list only.",
  no_document: "This record has no supporting document to review.",
  comment_required: "Say what should be corrected.",
  already_responded: "A different answer was already recorded for this request.",
  superseded: "The worker changed this record after sending it. They need to send the new version.",
  expired: "This request has expired.",
  revoked: "This request was withdrawn, or the connection with this worker ended.",
  self: "You can't review your own work.",
  needs_profile: "Finish your reviewer profile first.",
};

/** POST /api/supervisor/reviews/:id/respond — the only way a review decision is recorded. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSupervisorContext();
  if (!s) return apiError("unauthorized", "Sign in with a confirmed reviewer account.");
  if (!supervisorReviewEnabled()) return apiError("not_found", "Supervisor review isn't available.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("not_found", "That review isn't available.");
  const body = ReviewRespondRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check your answer and try again.");
  if (!(await allow("review-respond-user", s.user.id, 600, 60))) return apiError("rate_limited", "Too many attempts. Please wait a few minutes.");
  const d = body.data;
  const r = await rpc("review_respond", {
    p_auth: s.user.id,
    p_request: id.data,
    p_decision: d.decision,
    p_observed: d.decision === "confirm_observed" ? d.observedTasks : null,
    p_comment: "comment" in d ? (d.comment ?? null) : null,
    p_statement_version: REVIEW_STATEMENT_VERSION,
  });
  if (!r.ok) {
    if (r.reason === "not_found") return apiError("not_found", "That review isn't available to you.");
    return apiError("forbidden", MESSAGE[String(r.reason)] ?? "This request is no longer open.");
  }
  if (r.repeated !== true) {
    await notifyReviewDecided({ requestId: id.data, workerId: String(r.workerId), status: String(r.status), title: String(r.title) }).catch((e) => logSignoffError("review-notice", e));
  }
  return ok({ recorded: true, repeated: r.repeated === true, status: r.status });
}
