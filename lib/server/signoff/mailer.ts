import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mailMode, missingConfig } from "./config";

export type MessageKind = "invitation" | "code";

export interface OutboundMessage {
  kind: MessageKind;
  to: string;
  subject: string;
  text: string;
  /** Stable per logical send, so a retried request cannot send twice. */
  idempotencyKey: string;
  /** Mock outbox only: lets the worker see just their own simulated messages. Not sent to a provider. */
  meta?: { workerId: string; requestId: string };
}

export interface SendResult {
  mode: "resend" | "mock";
  /** Provider message id (Resend) or a local id (mock). Safe to store: contains no address. */
  messageId: string;
}

export class MailNotConfigured extends Error {}

export const OUTBOX_PATH = ".signoff-outbox/outbox.jsonl";

/** Mock delivery: nothing leaves this machine. The message is appended to a git-ignored dev outbox. */
export async function sendMock(msg: OutboundMessage, path = OUTBOX_PATH): Promise<SendResult> {
  const messageId = `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ messageId, simulated: true, at: new Date().toISOString(), ...msg }) + "\n", { mode: 0o600 });
  return { mode: "mock", messageId };
}

export async function sendResend(
  msg: OutboundMessage,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const missing = missingConfig(env);
  if (missing.length) throw new MailNotConfigured(`missing: ${missing.join(", ")}`);
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": msg.idempotencyKey,
    },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [msg.to], subject: msg.subject, text: msg.text }), // meta is never sent
    signal: AbortSignal.timeout(10_000),
  });
  // Never include the response body in errors: it can echo the address.
  if (!res.ok) throw new Error(`resend rejected the message (${res.status})`);
  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) throw new Error("resend returned no message id");
  return { mode: "resend", messageId: body.id };
}

/** The ONLY entry point. Mode is explicit; `off` refuses, and `resend` refuses without full configuration. */
export async function sendMessage(msg: OutboundMessage, env: NodeJS.ProcessEnv = process.env): Promise<SendResult> {
  const mode = mailMode(env);
  if (mode === "off") throw new MailNotConfigured("mail is off");
  return mode === "mock" ? sendMock(msg) : sendResend(msg, env);
}

const PRIVACY = (base: string) => `Privacy notice: ${base}/signoff/privacy`;

export function invitationMessage(opts: { workerName: string; link: string; base: string; validDays: number; mock: boolean }): Pick<OutboundMessage, "subject" | "text"> {
  return {
    subject: `${opts.mock ? "[SIMULATED] " : ""}${opts.workerName} asked you to acknowledge a work description`,
    text: [
      opts.mock ? "SIMULATED MESSAGE. No real email was sent." : "",
      `${opts.workerName} asked you to review a short description of work and acknowledge it.`,
      "",
      "Open this link to continue (it only opens a sign-in step; you will get a separate code by email before seeing any details):",
      opts.link,
      "",
      `The link expires in ${opts.validDays} days. If you were not expecting this, ignore this email or opt out on that page.`,
      PRIVACY(opts.base),
    ].filter((l, i) => l !== "" || i > 0).join("\n"),
  };
}

export function codeMessage(opts: { workerName: string; code: string; base: string; mock: boolean }): Pick<OutboundMessage, "subject" | "text"> {
  return {
    subject: `${opts.mock ? "[SIMULATED] " : ""}Your verification code`,
    text: [
      opts.mock ? "SIMULATED MESSAGE. No real email was sent." : "",
      `Your code for the ${opts.workerName} acknowledgment is: ${opts.code}`,
      "It works once and expires in 10 minutes. If you did not ask for it, ignore this email.",
      PRIVACY(opts.base),
    ].filter((l, i) => l !== "" || i > 0).join("\n"),
  };
}
