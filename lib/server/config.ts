/**
 * Server configuration checks. Every message names a variable and what is wrong with it, never its value.
 *
 * Which parts of the app need what:
 *  - Always (sign-up, sign-in, password reset, onboarding, rate limits): Supabase vars + SIGNOFF_PEPPER.
 *  - Any email (EMAIL_MODE=mock|resend): APP_BASE_URL.
 *  - EMAIL_MODE=resend: RESEND_API_KEY, RESEND_FROM, RESEND_WEBHOOK_SECRET.
 *  - EMAIL_MODE=mock: only on an isolated local setup (see `isolatedLocal`), never hosted.
 */

export type ConfigProblem = { name: string; problem: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Running on a hosting platform (Vercel sets VERCEL=1 for builds and functions, including previews). */
export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
}

/**
 * True only when nothing can leave this machine: not hosted, and both the app's public URL and Supabase are
 * loopback addresses. Simulated email is allowed only here, so a simulated acknowledgment can never be recorded
 * against shared data.
 */
export function isolatedLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isHosted(env)) return false;
  const app = hostOf(env.APP_BASE_URL);
  const db = hostOf(env.NEXT_PUBLIC_SUPABASE_URL);
  return app !== null && db !== null && LOOPBACK.has(app) && LOOPBACK.has(db);
}

export const BOOLEAN_FLAGS = ["SIGNOFF_ENABLED", "SUPERVISOR_REVIEW_ENABLED"] as const;

export function configProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const need = (name: string, why: string) => {
    if (!env[name]) out.push({ name, problem: `is not set (${why})` });
  };

  need("NEXT_PUBLIC_SUPABASE_URL", "required");
  need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "required");
  need("SUPABASE_SECRET_KEY", "required, server-only");
  if (!env.SIGNOFF_PEPPER) out.push({ name: "SIGNOFF_PEPPER", problem: "is not set (required for sign-up, onboarding and rate limits)" });
  else if (env.SIGNOFF_PEPPER.length < 32) out.push({ name: "SIGNOFF_PEPPER", problem: "must be at least 32 characters" });

  for (const n of Object.keys(env)) {
    if (n.startsWith("NEXT_PUBLIC_") && /SECRET|PEPPER|RESEND|GEMINI|SUPERMEMORY|PASSWORD|API_KEY/.test(n)) {
      out.push({ name: n, problem: "looks like a secret but is exposed to browsers; use a server-only name" });
    }
  }

  const signup = env.SIGNUP_MODE;
  if (signup !== undefined && !["closed", "allowlist", "open"].includes(signup)) out.push({ name: "SIGNUP_MODE", problem: "must be closed, allowlist or open (treated as closed)" });
  if (signup === "allowlist" && !env.SIGNUP_ALLOWLIST) out.push({ name: "SIGNUP_ALLOWLIST", problem: "is empty, so nobody can create a technician profile" });
  for (const f of BOOLEAN_FLAGS) {
    if (env[f] !== undefined && env[f] !== "true" && env[f] !== "false") out.push({ name: f, problem: "must be true or false (treated as false)" });
  }

  const modeRaw = env.EMAIL_MODE ?? env.SIGNOFF_MAIL_MODE;
  const modeName = env.EMAIL_MODE !== undefined ? "EMAIL_MODE" : "SIGNOFF_MAIL_MODE";
  if (modeRaw !== undefined && !["off", "mock", "resend"].includes(modeRaw)) out.push({ name: modeName, problem: "must be off, mock or resend (treated as off)" });
  if (modeRaw === "mock" || modeRaw === "resend") {
    const host = hostOf(env.APP_BASE_URL);
    if (!env.APP_BASE_URL) out.push({ name: "APP_BASE_URL", problem: "is not set (email links need it)" });
    else if (!host) out.push({ name: "APP_BASE_URL", problem: "is not a valid URL" });
    else if (!LOOPBACK.has(host) && !env.APP_BASE_URL.startsWith("https://")) out.push({ name: "APP_BASE_URL", problem: "must use https outside this machine" });
  }
  if (modeRaw === "mock" && !isolatedLocal(env)) {
    out.push({ name: modeName, problem: "mock is only allowed on an isolated local setup (not hosted; APP_BASE_URL and Supabase both on localhost)" });
  }
  if (modeRaw === "resend") {
    need("RESEND_API_KEY", "required when EMAIL_MODE=resend");
    if (!env.RESEND_FROM) out.push({ name: "RESEND_FROM", problem: "is not set (required when EMAIL_MODE=resend)" });
    else if (!/<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?\s*$/.test(env.RESEND_FROM)) out.push({ name: "RESEND_FROM", problem: "must be an address like QualiTrail <no-reply@mail.example.com>" });
    need("RESEND_WEBHOOK_SECRET", "required when EMAIL_MODE=resend; bounces and complaints must be handled");
  }
  return out;
}

/** One line per problem, safe to log: names and reasons only. */
export function describeProblems(problems: ConfigProblem[]): string {
  return problems.map((p) => `${p.name} ${p.problem}`).join("; ");
}
