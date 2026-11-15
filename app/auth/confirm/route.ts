import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { safeNext } from "@/lib/server/accounts/policy";
import { RESET_PATH, setRecoveryMarker } from "@/lib/server/accounts/recovery";
import { createUserClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["signup", "email", "recovery", "invite", "email_change", "magiclink"];

/**
 * GET /auth/confirm — where Supabase confirmation and password-reset links land.
 * Accepts either a PKCE `code` (default email templates) or `token_hash` + `type` (custom templates).
 * Redirects only to a same-site relative path. This route establishes the user's own session (and, for a reset
 * link, a 15-minute reset permission for that user); it never accepts or approves any review or acknowledgment.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const tokenHash = q.get("token_hash");
  const type = q.get("type") as EmailOtpType | null;
  const recovery = type === "recovery" || safeNext(q.get("next"), "") === RESET_PATH;
  const next = recovery ? RESET_PATH : safeNext(q.get("next"), "/onboarding");
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const failed = (why: "expired" | "browser") =>
    recovery ? to(`/forgot-password?error=${why}`) : to(`/sign-in?notice=${why === "expired" ? "expired" : "confirm"}&next=${encodeURIComponent(next)}`);

  // Supabase reports an expired or already-used link by redirecting here with an error instead of a code.
  if (q.get("error") || q.get("error_code")) return failed("expired");

  const supabase = await createUserClient();
  const code = q.get("code");
  try {
    let userId: string | null = null;
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return failed("browser");
      userId = data.user?.id ?? null;
    } else if (tokenHash && type && OTP_TYPES.includes(type)) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return failed("expired");
      userId = data.user?.id ?? null;
    } else {
      return failed("expired");
    }
    if (recovery) {
      if (!userId) return failed("expired");
      await setRecoveryMarker(userId);
    }
    return to(next);
  } catch {
    return failed("browser");
  }
}
