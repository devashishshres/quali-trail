import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { hmac, normalizeEmail } from "@/lib/server/signoff/crypto";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { emailMode, missingEmailConfig } from "./config";
import type { EmailKind, Rendered } from "./templates";
import { FatalSendError, sendMockMessage, sendResendOnce, withRetries } from "./transport";

export interface DeliveryRequest {
  kind: EmailKind;
  to: string;
  rendered: Rendered;
  /** Same key => at most one successful send, across retries and concurrent requests. */
  idempotencyKey: string;
  related?: { type: "signoff_request" | "supervisor_relationship" | "review_request" | "employer_share"; id: string };
  /** Mock outbox only: which worker the message was sent on behalf of. */
  workerId?: string;
}

export type DeliveryOutcome =
  | { ok: true; mode: "resend" | "mock"; duplicate: boolean }
  | { ok: false; reason: "off" | "not_configured" | "suppressed" | "in_progress" | "exhausted" | "failed" };

const MAX_ATTEMPTS_PER_KEY = 5;

/**
 * The single way the app sends email. Off/mock/resend is explicit; resend refuses without full configuration.
 * Suppressed addresses (opt-out, hard bounce, complaint) are never sent to. Outcomes are recorded without the
 * address or the body, and failures are returned to the caller so the UI can show them.
 */
export async function deliver(req: DeliveryRequest, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryOutcome> {
  const mode = emailMode(env);
  if (mode === "off") return { ok: false, reason: "off" };
  if (missingEmailConfig(env).length) return { ok: false, reason: "not_configured" };

  const admin = createAdminClient();
  const to = normalizeEmail(req.to);
  const { data: suppressed } = await admin.from("signoff_suppressions").select("email_hash").eq("email_hash", hmac("email", to)).maybeSingle();
  if (suppressed) return { ok: false, reason: "suppressed" };

  const begin = await admin.rpc("email_delivery_begin", {
    p_key: req.idempotencyKey,
    p_kind: req.kind,
    p_mode: mode,
    p_related_type: req.related?.type ?? null,
    p_related_id: req.related?.id ?? null,
    p_max_attempts: MAX_ATTEMPTS_PER_KEY,
  });
  if (begin.error) {
    logSignoffError("email:begin", new Error(`code ${begin.error.code}`));
    return { ok: false, reason: "failed" };
  }
  if (begin.data === "duplicate") return { ok: true, mode, duplicate: true };
  if (begin.data === "in_progress") return { ok: false, reason: "in_progress" };
  if (begin.data === "exhausted") return { ok: false, reason: "exhausted" };

  try {
    const messageId =
      mode === "mock"
        ? await sendMockMessage(to, req.rendered, { kind: req.kind, workerId: req.workerId, relatedId: req.related?.id })
        : await withRetries(() => sendResendOnce(to, req.rendered, req.idempotencyKey, env));
    await admin.rpc("email_delivery_finish", { p_key: req.idempotencyKey, p_ok: true, p_message_id: messageId, p_error: null });
    return { ok: true, mode, duplicate: false };
  } catch (e) {
    const code = e instanceof Error ? e.message : "unknown";
    await admin.rpc("email_delivery_finish", { p_key: req.idempotencyKey, p_ok: false, p_message_id: null, p_error: code });
    logSignoffError(`email:${req.kind}`, e instanceof FatalSendError ? e : new Error(code));
    return { ok: false, reason: "failed" };
  }
}

export const DELIVERY_FAILURE_MESSAGE: Record<Exclude<DeliveryOutcome, { ok: true }>["reason"], string> = {
  off: "Email is switched off on this server.",
  not_configured: "Email isn't configured on this server yet.",
  suppressed: "This address has opted out or can't receive email, so nothing was sent.",
  in_progress: "This message is already being sent. Check again in a minute.",
  exhausted: "This message failed too many times. Try again later or check the address.",
  failed: "The email couldn't be sent. Please try again.",
};
