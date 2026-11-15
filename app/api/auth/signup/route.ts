import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { mayRegister, safeNext } from "@/lib/server/accounts/policy";
import { hmac } from "@/lib/server/signoff/crypto";
import { allow, clientIp, rpcValue } from "@/lib/server/signoff/service";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { createUserClient } from "@/lib/supabase/server";
import { SignupRequest } from "@/lib/types";

const SENT = "If this address can register, we've sent a confirmation link to it. Open it on this device to continue.";

/**
 * POST /api/auth/signup — create an account that must confirm its email before anything else.
 * The answer is the same whether or not the address may register or already has an account (no enumeration).
 * Runs through the cookie-bound client so the confirmation link completes in this browser (PKCE).
 */
export async function POST(request: Request) {
  const body = SignupRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("signup-ip", await clientIp(), 3600, 10))) return apiError("rate_limited", "Too many attempts. Please try again later.");

  const { email, password } = body.data;
  const hasInvite = process.env.SIGNOFF_PEPPER ? (await rpcValue<boolean>("account_has_pending_invite", { p_email_hash: hmac("email", email) })) === true : false;
  if (!mayRegister(email, hasInvite)) return ok({ message: SENT });

  const base = (process.env.APP_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
  const next = safeNext(body.data.next, "/onboarding");
  try {
    const supabase = await createUserClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${base}/auth/confirm?next=${encodeURIComponent(next)}` },
    });
    if (error && error.status !== 422) {
      if (error.status === 429) return apiError("rate_limited", "Too many attempts. Please try again later.");
      if (/password/i.test(error.message)) return apiError("validation_failed", "Choose a stronger password.", { password: ["Choose a stronger password."] });
      logSignoffError("signup", new Error(`auth status ${error.status}`));
    }
  } catch (e) {
    logSignoffError("signup", e);
    return apiError("internal", "Couldn't start sign-up. Please try again.");
  }
  return ok({ message: SENT });
}
