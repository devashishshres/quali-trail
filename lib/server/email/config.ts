export type EmailMode = "off" | "mock" | "resend";

/** EMAIL_MODE (preferred) or the older SIGNOFF_MAIL_MODE. Anything unrecognised means off. */
export function emailMode(env: NodeJS.ProcessEnv = process.env): EmailMode {
  const m = env.EMAIL_MODE ?? env.SIGNOFF_MAIL_MODE;
  return m === "mock" || m === "resend" ? m : "off";
}

/** Names (never values) of variables the current mode still needs. */
export function missingEmailConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const required = ["SIGNOFF_PEPPER", "APP_BASE_URL"];
  if (emailMode(env) === "resend") required.push("RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET");
  return required.filter((n) => !env[n]);
}

export function emailReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailMode(env) !== "off" && missingEmailConfig(env).length === 0;
}

/** The mock outbox exists only outside production builds. */
export function mockOutboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailMode(env) === "mock" && env.NODE_ENV !== "production";
}
