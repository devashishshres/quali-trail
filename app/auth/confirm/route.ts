import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { safeNext } from "@/lib/server/accounts/policy";
import { createUserClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["signup", "email", "recovery", "invite", "email_change", "magiclink"];

/**
 * GET /auth/confirm — where Supabase confirmation and reset links land.
 * Accepts either a PKCE `code` (default email templates) or `token_hash` + `type` (custom templates).
 * Redirects only to a same-site relative path. This route establishes the user's own session; it never
 * accepts or approves any review or acknowledgment.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), "/onboarding");
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const supabase = await createUserClient();

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  try {
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return to(next);
    } else if (tokenHash && type && OTP_TYPES.includes(type)) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (!error) return to(type === "recovery" ? "/reset-password" : next);
    }
  } catch {
    // fall through
  }
  // The link may have been opened in another browser (PKCE needs the original one). The email is usually
  // confirmed regardless, so ask the person to sign in.
  return to(`/sign-in?notice=confirm&next=${encodeURIComponent(next)}`);
}
