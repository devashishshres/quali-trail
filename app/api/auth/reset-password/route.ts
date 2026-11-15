import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { clearRecoveryMarker, recoveryMarkerValid } from "@/lib/server/accounts/recovery";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, guarded } from "@/lib/server/signoff/service";
import { createUserClient } from "@/lib/supabase/server";
import { ResetPasswordRequest } from "@/lib/types";

/** GET /api/auth/reset-password — may this browser set a new password right now? Changes nothing. */
async function handleGET() {
  const { data } = await (await createUserClient()).auth.getUser();
  return ok({ ready: Boolean(data.user && (await recoveryMarkerValid(data.user.id))) });
}

/**
 * POST /api/auth/reset-password { password } — set a new password. Needs BOTH the session created by opening the
 * reset link AND the 15-minute reset permission /auth/confirm set for that same user. Afterwards every other
 * session of the account is signed out.
 */
async function handlePOST(request: Request) {
  const supabase = await createUserClient();
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data.user) return apiError("unauthorized", "This reset link has expired. Request a new one.");
  if (!(await recoveryMarkerValid(data.user.id))) return apiError("forbidden", "This reset link has expired. Request a new one.");
  const body = ResetPasswordRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("reset-user", data.user.id, 3600, 10))) return apiError("rate_limited", "Too many attempts. Please try again later.");

  const { error } = await supabase.auth.updateUser({ password: body.data.password });
  if (error) {
    if (error.code === "same_password") return apiError("validation_failed", "Choose a password different from your current one.", { password: ["Choose a different password."] });
    if (error.code === "weak_password" || /password/i.test(error.message)) return apiError("validation_failed", "Choose a stronger password.", { password: ["Choose a stronger password."] });
    logSignoffError("reset-password", new Error(`auth status ${error.status}`));
    return apiError("internal", "Couldn't change the password. Please try again.");
  }
  await clearRecoveryMarker();
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
  return ok({ changed: true });
}

export const GET = guarded(handleGET);

export const POST = guarded(handlePOST);
