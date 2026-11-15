import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Sign-off secrets (invitation tokens, codes, session tokens, addresses used for lookup)
 * are only ever stored or compared as HMAC-SHA256 digests keyed by SIGNOFF_PEPPER.
 * Each purpose has its own label so a hash from one context cannot be replayed in another.
 */
export type HashPurpose = "token" | "code" | "session" | "email" | "ip" | "rate" | "recovery";

export function pepper(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.SIGNOFF_PEPPER;
  if (!p || p.length < 32) throw new Error("SIGNOFF_PEPPER must be set to at least 32 characters");
  return p;
}

export function hmac(purpose: HashPurpose, value: string, key: string = pepper()): string {
  return createHmac("sha256", key).update(`${purpose}:${value}`).digest("hex");
}

/** 256-bit URL-safe invitation token. */
export const newToken = () => randomBytes(32).toString("base64url");
/** 256-bit session token (HttpOnly cookie). */
export const newSessionToken = () => randomBytes(32).toString("base64url");
/** 6-digit code from a CSPRNG, uniformly distributed. */
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** `casey@example.com` -> `c***@example.com`. For the gate page; never the full address. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 1)}***@${domain ?? ""}`;
}
