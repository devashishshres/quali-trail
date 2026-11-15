import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { notifyReviewRequested } from "@/lib/server/accounts/notify";
import { DELIVERY_FAILURE_MESSAGE } from "@/lib/server/email/deliver";
import { rpc } from "@/lib/server/signoff/service";

const REASON: Record<string, string> = {
  too_soon: "A reminder was sent less than a day ago.",
  limit: "The reminder limit for this request was reached.",
  not_pending: "This request is no longer open.",
  revoked: "The connection with this supervisor has ended.",
};

/** POST /api/reviews/:id/remind — bounded manual reminder to the supervisor (one a day, three in total). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return apiError("not_found", "Supervisor review isn't available.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid id.");
  const r = await rpc("review_remind", { p_worker: ctx.worker.id, p_request: id.data });
  if (!r.ok) return apiError(r.reason === "too_soon" ? "rate_limited" : r.reason === "not_found" ? "not_found" : "validation_failed", REASON[String(r.reason)] ?? "Couldn't send a reminder.");
  const sent = await notifyReviewRequested({ requestId: id.data, supervisorAuthUserId: String(r.supervisorAuthUserId), workerName: ctx.worker.name, workerId: ctx.worker.id, attempt: Number(r.reminder) });
  if (!sent.ok) return apiError("internal", DELIVERY_FAILURE_MESSAGE[sent.reason]);
  return ok({ reminded: true });
}
