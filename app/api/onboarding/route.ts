import { getAccount } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { configProblems, describeProblems } from "@/lib/server/config";
import { allowedRoles } from "@/lib/server/accounts/roles";
import { addSampleOpportunity } from "@/lib/server/accounts/sample";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, guarded, rpc } from "@/lib/server/signoff/service";
import { OnboardRequest } from "@/lib/types";

const REFUSED = {
  worker: "Technician profiles are open only to addresses on the preview list. A supervisor invitation doesn't include one.",
  supervisor: "A reviewer profile needs an invitation from a technician (or supervisor review is switched off on this server).",
} as const;

/**
 * POST /api/onboarding — create the caller's OWN worker or supervisor profile (idempotent).
 * Requires a confirmed email. Each role is checked separately, for first-time setup and for later additions:
 * a technician profile only under the sign-up policy; a reviewer profile with an invitation, the policy, or an
 * existing technician profile, and only while supervisor review is on. Creates no evidence; a sample job is
 * added only when explicitly requested.
 */
async function handlePOST(request: Request) {
  const a = await getAccount();
  if (!a) return apiError("unauthorized", "Sign in first.");
  if (!a.user.emailConfirmed || !a.user.email) return apiError("forbidden", "Confirm your email address first.");
  const body = OnboardRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  const pepperProblem = configProblems().filter((p) => p.name === "SIGNOFF_PEPPER");
  if (pepperProblem.length) {
    logSignoffError("config", new Error(describeProblems(pepperProblem)));
    return apiError("internal", "Account setup isn't available on this server right now.");
  }
  if (!(await allow("onboard-user", a.user.id, 3600, 30))) return apiError("rate_limited", "Too many attempts. Please try again later.");

  const d = body.data;
  if (!(await allowedRoles(a))[d.role]) return apiError("forbidden", REFUSED[d.role]);

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

export const POST = guarded(handlePOST);
