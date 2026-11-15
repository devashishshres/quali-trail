import { configProblems, isolatedLocal } from "@/lib/server/config";

export type EmailMode = "off" | "mock" | "resend";

/** EMAIL_MODE (preferred) or the older SIGNOFF_MAIL_MODE. Anything unrecognised means off. */
export function emailMode(env: NodeJS.ProcessEnv = process.env): EmailMode {
  const m = env.EMAIL_MODE ?? env.SIGNOFF_MAIL_MODE;
  return m === "mock" || m === "resend" ? m : "off";
}

const EMAIL_VARS = new Set(["SIGNOFF_PEPPER", "APP_BASE_URL", "EMAIL_MODE", "SIGNOFF_MAIL_MODE", "RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET"]);

/**
 * Names (never values) of variables that stop the current mode from sending. Includes EMAIL_MODE itself when
 * mock is requested outside an isolated local setup: simulated email is refused on any hosted deployment.
 */
export function missingEmailConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(configProblems(env).filter((p) => EMAIL_VARS.has(p.name)).map((p) => p.name))];
}

export function emailReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailMode(env) !== "off" && missingEmailConfig(env).length === 0;
}

/** The simulated outbox exists only in mock mode on an isolated local setup. */
export function mockOutboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailMode(env) === "mock" && isolatedLocal(env);
}
