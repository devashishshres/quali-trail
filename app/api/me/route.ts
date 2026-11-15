import { getAccount } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { mayRegister } from "@/lib/server/accounts/policy";
import { signoffEnabled } from "@/lib/server/signoff/config";
import { hmac } from "@/lib/server/signoff/crypto";
import { rpcValue } from "@/lib/server/signoff/service";
import type { MeResponse } from "@/lib/types";

/** GET /api/me — the caller's own roles. Never anyone else's. */
export async function GET() {
  const a = await getAccount();
  if (!a) return apiError("unauthorized", "Sign in first.");
  let canOnboard = Boolean(a.worker || a.supervisor);
  if (!canOnboard && a.user.email && a.user.emailConfirmed) {
    const hasInvite = process.env.SIGNOFF_PEPPER ? (await rpcValue<boolean>("account_has_pending_invite", { p_email_hash: hmac("email", a.user.email.toLowerCase()) })) === true : false;
    canOnboard = mayRegister(a.user.email, hasInvite);
  }
  return ok<MeResponse>({
    email: a.user.email,
    emailConfirmed: a.user.emailConfirmed,
    worker: a.worker ? { id: a.worker.id, name: a.worker.name } : null,
    supervisor: a.supervisor ? { name: a.supervisor.name, organization: a.supervisor.organization, title: a.supervisor.title } : null,
    canOnboard: canOnboard && a.user.emailConfirmed,
    features: { customerSignoff: signoffEnabled(), supervisorReview: supervisorReviewEnabled() },
  });
}
