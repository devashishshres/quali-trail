import { getAccount } from "@/lib/api/auth";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { allow, clientIp, gone, guarded, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

const MESSAGE: Record<string, string> = {
  wrong_account: "This packet was shared with a different email address. Sign in with the address it was sent to.",
  email_unconfirmed: "Confirm your email address first.",
  self: "This is your own packet. Open it from your Reports page.",
  expired: "This share has expired. Ask the technician to share it again.",
  revoked: "The technician withdrew this share.",
};

/**
 * POST /api/employer/invite/accept — needs the share token AND a signed-in account whose confirmed email is the
 * invited address. It opens one packet for that account only; it creates no profile and no other access.
 */
async function handlePOST(request: Request) {
  if (!employerReviewEnabled()) return off();
  const a = await getAccount();
  if (!a) return json({ error: { code: "unauthorized", message: "Sign in first." } }, 401);
  if (!(await allow("employer-accept-user", a.user.id, 3600, 20)) || !(await allow("employer-accept-ip", await clientIp(), 3600, 40))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("employer_share_accept", { p_token_hash: th, p_auth: a.user.id });
  if (r.ok) return json({ id: r.id, repeated: r.repeated === true });
  const reason = String(r.reason);
  if (MESSAGE[reason]) return json({ error: { code: "forbidden", message: MESSAGE[reason], reason } }, 409);
  return gone();
}

export const POST = guarded(handlePOST);
