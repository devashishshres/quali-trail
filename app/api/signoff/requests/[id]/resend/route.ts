import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { signoffStatus } from "@/lib/server/signoff/config";
import { hmac, newToken } from "@/lib/server/signoff/crypto";
import { invitationMessage, sendMessage } from "@/lib/server/signoff/mailer";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, appBaseUrl, rpc } from "@/lib/server/signoff/service";

/** POST /api/signoff/requests/:id/resend — new link; the old link, sessions and codes stop working. */
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
  if (!r.ok) return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", "This request can't be re-sent (it may be closed, suppressed, or at the resend limit).");
  const base = appBaseUrl();
  try {
    const mail = invitationMessage({ workerName: String(r.workerName), link: `${base}/signoff#t=${token}`, base, validDays: 7, mock: status.mode === "mock" });
    await sendMessage({ kind: "invitation", to: String(r.email), ...mail, idempotencyKey: `invite-${id.data}-${token.slice(0, 8)}`, meta: { workerId: ctx.worker.id, requestId: id.data } });
  } catch (e) {
    logSignoffError("resend-invitation", e);
    return apiError("internal", "The invitation couldn't be sent. The previous link no longer works; try Resend again.");
  }
  return ok({ resent: true });
}
