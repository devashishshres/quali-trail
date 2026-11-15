import { getAccount } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { mayRegister } from "@/lib/server/accounts/policy";
import { addSampleOpportunity } from "@/lib/server/accounts/sample";
import { hmac } from "@/lib/server/signoff/crypto";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, rpc, rpcValue } from "@/lib/server/signoff/service";
import { OnboardRequest } from "@/lib/types";

/**
 * POST /api/onboarding — create the caller's OWN worker or supervisor profile (idempotent).
 * Requires a confirmed email and the sign-up policy (or an existing profile, e.g. a worker adding the
 * supervisor role). Creates no evidence. A sample job is added only when explicitly requested.
 */
export async function POST(request: Request) {
  const a = await getAccount();
  if (!a) return apiError("unauthorized", "Sign in first.");
  if (!a.user.emailConfirmed || !a.user.email) return apiError("forbidden", "Confirm your email address first.");
  const body = OnboardRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("onboard-user", a.user.id, 3600, 30))) return apiError("rate_limited", "Too many attempts. Please try again later.");

  let allowed = Boolean(a.worker || a.supervisor);
  if (!allowed) {
    const hasInvite = process.env.SIGNOFF_PEPPER ? (await rpcValue<boolean>("account_has_pending_invite", { p_email_hash: hmac("email", a.user.email.toLowerCase()) })) === true : false;
    allowed = mayRegister(a.user.email, hasInvite);
  }
  if (!allowed) return apiError("forbidden", "This account isn't on the list for this preview yet.");

  const d = body.data;
  try {
    if (d.role === "worker") {
      const r = await rpc("account_onboard_worker", {
        p_auth: a.user.id, p_name: d.name, p_trade: d.trade, p_summary: d.summary ?? null, p_arrangement: d.employmentArrangement ?? null,
      });
      if (!r.ok) throw new Error("onboard worker failed");
      const sample = d.addSampleOpportunity ? await addSampleOpportunity(String(r.workerId)) : { created: false };
      return ok({ role: "worker", created: r.created === true, sampleOpportunity: sample.created });
    }
    const r = await rpc("account_onboard_supervisor", { p_auth: a.user.id, p_name: d.name, p_org: d.organization ?? null, p_title: d.title ?? null });
    if (!r.ok) throw new Error("onboard supervisor failed");
    return ok({ role: "supervisor", created: r.created === true });
  } catch (e) {
    logSignoffError("onboarding", e);
    return apiError("internal", "Couldn't save your profile. Please try again.");
  }
}
