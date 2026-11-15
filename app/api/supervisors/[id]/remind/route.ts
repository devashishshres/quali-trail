import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { DELIVERY_FAILURE_MESSAGE, deliver } from "@/lib/server/email/deliver";
import { emailMode } from "@/lib/server/email/config";
import { templates } from "@/lib/server/email/templates";
import { hmac, newToken } from "@/lib/server/signoff/crypto";
import { appBaseUrl, rpc } from "@/lib/server/signoff/service";

const REASON: Record<string, string> = {
  too_soon: "A reminder was sent less than a day ago.",
  limit: "The reminder limit for this invitation was reached.",
  suppressed: "This address has opted out or can't receive email.",
  not_pending: "This invitation is no longer open.",
};

/** POST /api/supervisors/:id/remind — bounded reminder (one a day, three in total). Issues a new link. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return apiError("not_found", "Supervisor review isn't available.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid id.");
  const token = newToken();
  const r = await rpc("sup_invite_rotate", { p_worker: ctx.worker.id, p_relationship: id.data, p_new_token_hash: hmac("token", token) });
  if (!r.ok) return apiError(r.reason === "too_soon" ? "rate_limited" : r.reason === "not_found" ? "not_found" : "validation_failed", REASON[String(r.reason)] ?? "Couldn't send a reminder.");
  const base = appBaseUrl();
  const sent = await deliver({
    kind: "reminder",
    to: String(r.email),
    rendered: templates.supervisorInvitation({ base, mock: emailMode() === "mock", workerName: String(r.workerName), link: `${base}/invite/supervisor#t=${token}`, validDays: 14 }),
    idempotencyKey: `sup-invite-${id.data}-${token.slice(0, 12)}`,
    related: { type: "supervisor_relationship", id: id.data },
    workerId: ctx.worker.id,
  });
  if (!sent.ok) return apiError("internal", `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The previous link no longer works.`);
  return ok({ reminded: true });
}
