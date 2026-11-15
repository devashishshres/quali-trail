import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { RESET_PATH } from "@/lib/server/accounts/recovery";
import { configProblems, describeProblems } from "@/lib/server/config";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, clientIp } from "@/lib/server/signoff/service";
import { createUserClient } from "@/lib/supabase/server";
import { RecoverRequest } from "@/lib/types";

const SENT = "If an account uses this address, we've sent a link to reset the password. Open it in this browser within an hour.";

/**
 * POST /api/auth/recover { email } — ask Supabase Auth to email a password-reset link.
 * Same answer whether or not the account exists (no enumeration). Uses the cookie-bound client so the link
 * completes in this browser (PKCE). Not behind a feature flag: people must always be able to get back in.
 */
export async function POST(request: Request) {
  const body = RecoverRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Enter a valid email address.", fieldErrors(body.error));
  const pepperProblem = configProblems().filter((p) => p.name === "SIGNOFF_PEPPER");
  if (pepperProblem.length) {
    logSignoffError("config", new Error(describeProblems(pepperProblem)));
    return apiError("internal", "Password reset isn't available on this server right now.");
  }
  if (!(await allow("recover-ip", await clientIp(), 3600, 10))) return apiError("rate_limited", "Too many attempts. Please try again later.");
  const email = body.data.email;
  if (!(await allow("recover-email", email, 3600, 3))) return ok({ message: SENT });

  const base = (process.env.APP_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
  try {
    const supabase = await createUserClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${base}/auth/confirm?next=${encodeURIComponent(RESET_PATH)}` });
    if (error) {
      if (error.status === 429) return apiError("rate_limited", "Too many attempts. Please try again later.");
      logSignoffError("recover", new Error(`auth status ${error.status}`));
    }
  } catch (e) {
    logSignoffError("recover", e);
    return apiError("internal", "Couldn't start the reset. Please try again.");
  }
  return ok({ message: SENT });
}
