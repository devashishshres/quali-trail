/**
 * Who may create an account. Default is CLOSED (invite-only): only addresses holding an open supervisor
 * invitation may register. `allowlist` also admits SIGNUP_ALLOWLIST entries (exact addresses, or "@domain").
 * `open` admits anyone with a confirmed email. Existing accounts are never affected.
 *
 * This is enforced again at onboarding, so an account created by calling Supabase directly still gets no
 * worker or supervisor profile, and therefore no access, unless it is allowed here.
 */
export type SignupMode = "closed" | "allowlist" | "open";

export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
  const m = env.SIGNUP_MODE;
  return m === "allowlist" || m === "open" ? m : "closed";
}

export function onAllowlist(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return (env.SIGNUP_ALLOWLIST ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => (entry.startsWith("@") ? entry === domain : entry === e));
}

/** Policy decision without the invitation lookup (the caller supplies `hasInvite`). */
export function mayRegister(email: string, hasInvite: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = signupMode(env);
  if (hasInvite) return true;
  if (mode === "open") return true;
  if (mode === "allowlist") return onAllowlist(email, env);
  return false;
}

/** Only same-site relative paths, never `//host`, `/\host`, schemes or control characters. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
