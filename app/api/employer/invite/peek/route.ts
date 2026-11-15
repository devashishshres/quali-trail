import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { allow, clientIp, gone, guarded, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

/** POST /api/employer/invite/peek — who shared (name + masked address) and the status. Never the packet. */
async function handlePOST(request: Request) {
  if (!employerReviewEnabled()) return off();
  if (!(await allow("employer-peek-ip", await clientIp(), 600, 60))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("employer_share_peek", { p_token_hash: th });
  if (!r.ok) return gone();
  return json({ status: r.status, workerName: r.workerName ?? null, emailHint: r.emailHint ?? null, expiresAt: r.expiresAt ?? null, answered: r.answered === true });
}

export const POST = guarded(handlePOST);
