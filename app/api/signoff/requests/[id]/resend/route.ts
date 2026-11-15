import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { signoffStatus } from "@/lib/server/signoff/config";
import { hmac, newToken } from "@/lib/server/signoff/crypto";
import { DELIVERY_FAILURE_MESSAGE, deliver } from "@/lib/server/email/deliver";
import { templates } from "@/lib/server/email/templates";
import { allow, appBaseUrl, rpc } from "@/lib/server/signoff/service";

/**
 * POST /api/signoff/requests/:id/resend — a manual reminder. Bounded (one an hour, five invitations in total).
 * Issues a new link; the old link, sessions and codes stop working.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const status = signoffStatus();
  if (!status.ready) return apiError("not_found", "Customer sign-off isn't available.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid request id.");
  if (!(await allow("resend-worker", ctx.worker.id, 3600, 20))) return apiError("rate_limited", "Too many requests this hour. Please try again later.");

  const token = newToken();
  const r = await rpc("signoff_rotate_token", { p_worker: ctx.worker.id, p_request: id.data, p_new_token_hash: hmac("token", token) });
  if (!r.ok) {
    if (r.reason === "too_soon") return apiError("rate_limited", "A reminder was sent less than an hour ago.");
    return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", "This request can't be re-sent (it may be closed, suppressed, or at the reminder limit).");
  }
  const base = appBaseUrl();
  const sent = await deliver({
    kind: "reminder",
    to: String(r.email),
    rendered: templates.reminder({ base, mock: status.mode === "mock", workerName: String(r.workerName), link: `${base}/signoff#t=${token}`, what: "customer" }),
    idempotencyKey: `remind-${id.data}-${token.slice(0, 12)}`,
    related: { type: "signoff_request", id: id.data },
    workerId: ctx.worker.id,
  });
  if (!sent.ok) return apiError("internal", `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The previous link no longer works.`);
  return ok({ resent: true });
}
