import { z } from "zod";
import { getAccount } from "@/lib/api/auth";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { allow, clientIp, gone, guarded, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

const Body = z.object({ accept: z.boolean() });
const MESSAGE: Record<string, string> = {
  wrong_account: "This invitation was sent to a different email address. Sign in with the address it was sent to.",
  email_unconfirmed: "Confirm your email address first.",
  self: "You can't be your own supervisor.",
  needs_profile: "Finish your reviewer profile first.",
  already_connected: "You're already connected to this person.",
  expired: "This invitation has expired. Ask them to send a new one.",
  declined: "This invitation was declined.",
  revoked: "This invitation was cancelled.",
  accepted: "This invitation was already used.",
};

/**
 * POST /api/supervisor/invite/answer { accept } — needs the invitation token AND a signed-in account whose
 * confirmed email is the invited address. A forwarded link does nothing for anyone else.
 */
async function handlePOST(request: Request) {
  if (!supervisorReviewEnabled()) return off();
  const a = await getAccount();
  if (!a) return json({ error: { code: "unauthorized", message: "Sign in first." } }, 401);
  if (!(await allow("sup-answer-user", a.user.id, 3600, 20)) || !(await allow("sup-answer-ip", await clientIp(), 3600, 40))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: { code: "validation_failed", message: "Choose accept or decline." } }, 400);
  const r = await rpc("sup_invite_answer", { p_token_hash: th, p_auth: a.user.id, p_accept: body.data.accept });
  if (r.ok) return json({ status: r.status ?? "accepted", repeated: r.repeated === true });
  const reason = String(r.reason);
  if (MESSAGE[reason]) return json({ error: { code: "forbidden", message: MESSAGE[reason], reason } }, 409);
  return gone();
}

export const POST = guarded(handlePOST);
