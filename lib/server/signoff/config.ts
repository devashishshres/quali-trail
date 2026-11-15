import { emailMode, missingEmailConfig, type EmailMode } from "@/lib/server/email/config";

export type MailMode = EmailMode;

export function signoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNOFF_ENABLED === "true";
}

/** Kept for existing callers: the shared email mode (EMAIL_MODE, or the older SIGNOFF_MAIL_MODE). */
export const mailMode = emailMode;
export const missingConfig = missingEmailConfig;

/** What the UI may do right now. Real sending is impossible unless everything is configured. */
export function signoffStatus(env: NodeJS.ProcessEnv = process.env) {
  const enabled = signoffEnabled(env);
  const mode = emailMode(env);
  const missing = enabled ? missingEmailConfig(env) : [];
  const ready = enabled && mode !== "off" && missing.length === 0;
  return { enabled, mode, ready, missing };
}
