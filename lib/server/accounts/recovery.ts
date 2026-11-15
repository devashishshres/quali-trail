import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { hmac } from "@/lib/server/signoff/crypto";

/**
 * Password reset is allowed only right after the person opened a reset link from their inbox. Opening the link
 * signs them in; /auth/confirm then sets this short-lived HttpOnly marker, bound to that user id. Without it, an
 * ordinary signed-in session (for example a laptop left open) can't silently change the password.
 */
export const RECOVERY_COOKIE = "qt_recovery";
export const RECOVERY_MINUTES = 15;
export const RESET_PATH = "/reset-password";

export function recoveryValue(userId: string, now = Date.now()): string {
  const exp = now + RECOVERY_MINUTES * 60_000;
  return `${exp}.${hmac("recovery", `${userId}:${exp}`)}`;
}

export function recoveryValid(value: string | undefined, userId: string, now = Date.now()): boolean {
  if (!value) return false;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const want = Buffer.from(hmac("recovery", `${userId}:${exp}`), "hex");
  const got = Buffer.from(m[2], "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/" };

export async function setRecoveryMarker(userId: string) {
  (await cookies()).set(RECOVERY_COOKIE, recoveryValue(userId), { ...cookieOptions, maxAge: RECOVERY_MINUTES * 60 });
}

export async function recoveryMarkerValid(userId: string): Promise<boolean> {
  return recoveryValid((await cookies()).get(RECOVERY_COOKIE)?.value, userId);
}

export async function clearRecoveryMarker() {
  (await cookies()).set(RECOVERY_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}
