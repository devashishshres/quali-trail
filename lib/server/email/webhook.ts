import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { hmac, normalizeEmail } from "@/lib/server/signoff/crypto";

/** The parts of a Resend webhook event we use. Anything else in the payload is ignored and never stored. */
export interface ResendEvent {
  type?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string } };
}

export type WebhookAction =
  | { kind: "ignore" }
  | { kind: "status"; status: "delivered" | "delayed" | "failed" | "bounced_transient" }
  | { kind: "suppress"; status: "bounced" | "complained"; reason: "bounce" | "complaint" };

/**
 * Hard (permanent) bounces and complaints suppress the address. Transient/undetermined bounces are recorded
 * but do not suppress: a full mailbox should not block future legitimate messages.
 */
export function classify(e: ResendEvent): WebhookAction {
  switch (e.type) {
    case "email.delivered":
      return { kind: "status", status: "delivered" };
    case "email.delivery_delayed":
      return { kind: "status", status: "delayed" };
    case "email.failed":
      return { kind: "status", status: "failed" };
    case "email.complained":
      return { kind: "suppress", status: "complained", reason: "complaint" };
    case "email.bounced":
      return (e.data?.bounce?.type ?? "").toLowerCase() === "permanent"
        ? { kind: "suppress", status: "bounced", reason: "bounce" }
        : { kind: "status", status: "bounced_transient" };
    default:
      return { kind: "ignore" };
  }
}

/**
 * Apply a verified event at most once in effect. The event is recorded as processed only AFTER it was applied,
 * so a failure mid-way lets the provider's retry finish the job. Applying twice is harmless (suppression and
 * status updates are idempotent), which also covers two copies arriving at the same moment.
 */
export async function applyWebhook(webhookId: string, e: ResendEvent): Promise<"duplicate" | "applied" | "ignored"> {
  const admin = createAdminClient();
  const seen = await admin.from("email_webhook_events").select("webhook_id").eq("webhook_id", webhookId).maybeSingle();
  if (seen.error) throw new Error(`webhook lookup failed (${seen.error.code})`);
  if (seen.data) return "duplicate";

  const action = classify(e);
  if (action.kind !== "ignore") {
    const messageId = e.data?.email_id;
    if (messageId) {
      const r = await admin.rpc("email_delivery_event", { p_message_id: messageId, p_status: action.status });
      if (r.error) throw new Error(`delivery status failed (${r.error.code})`);
    }
    if (action.kind === "suppress") {
      const recipients = Array.isArray(e.data?.to) ? e.data!.to : e.data?.to ? [e.data.to] : [];
      for (const to of recipients) {
        const r = await admin.rpc("signoff_add_suppression", { p_email_hash: hmac("email", normalizeEmail(to)), p_reason: action.reason, p_message_id: messageId ?? null });
        if (r.error) throw new Error(`suppression failed (${r.error.code})`);
      }
    }
  }
  const done = await admin.rpc("email_webhook_first_seen", { p_webhook_id: webhookId, p_event_type: String(e.type ?? "unknown").slice(0, 60) });
  if (done.error) throw new Error(`webhook record failed (${done.error.code})`);
  return action.kind === "ignore" ? "ignored" : "applied";
}
