export type MailMode = "off" | "mock" | "resend";

export function signoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNOFF_ENABLED === "true";
}

export function mailMode(env: NodeJS.ProcessEnv = process.env): MailMode {
  const m = env.SIGNOFF_MAIL_MODE;
  return m === "mock" || m === "resend" ? m : "off";
}

/** Names of required variables that are missing for the chosen mode (names only, never values). */
export function missingConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const required = ["SIGNOFF_PEPPER", "APP_BASE_URL"];
  if (mailMode(env) === "resend") required.push("RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET");
  return required.filter((n) => !env[n]);
}

/** What the UI may do right now. Real sending is impossible unless everything is configured. */
export function signoffStatus(env: NodeJS.ProcessEnv = process.env) {
  const enabled = signoffEnabled(env);
  const mode = mailMode(env);
  const missing = enabled ? missingConfig(env) : [];
  const ready = enabled && mode !== "off" && missing.length === 0;
  return { enabled, mode, ready, missing };
}
