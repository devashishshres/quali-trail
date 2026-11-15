import { allow, clientIp, gone, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";

/** POST /api/supervisor/invite/peek — who invited you (name + masked address). Nothing else. */
export async function POST(request: Request) {
  if (!supervisorReviewEnabled()) return off();
  if (!(await allow("sup-peek-ip", await clientIp(), 600, 60))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("sup_invite_peek", { p_token_hash: th });
  if (!r.ok) return gone();
  return json({ status: r.status, workerName: r.workerName ?? null, emailHint: r.emailHint ?? null, answered: r.answered === true });
}
