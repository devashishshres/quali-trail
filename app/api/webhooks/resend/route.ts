import { NextResponse } from "next/server";
import { hmac, normalizeEmail } from "@/lib/server/signoff/crypto";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { featureOn, off, rpc } from "@/lib/server/signoff/service";
import { verifyWebhook } from "@/lib/server/signoff/webhook";

/**
 * POST /api/webhooks/resend — bounces and complaints suppress the address. Required before real customer use.
 * The signature is checked against the RAW body first. Stored: a hash of the address and the provider message id.
 */
export async function POST(request: Request) {
  if (!featureOn()) return off();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const raw = await request.text();
  const valid = verifyWebhook(secret, {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  }, raw);
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 400 });

  try {
    const event = JSON.parse(raw) as { type?: string; data?: { email_id?: string; to?: string[] } };
    const reason = event.type === "email.bounced" ? "bounce" : event.type === "email.complained" ? "complaint" : null;
    if (reason) {
      for (const to of event.data?.to ?? []) {
        await rpc("signoff_add_suppression", { p_email_hash: hmac("email", normalizeEmail(to)), p_reason: reason, p_message_id: event.data?.email_id ?? null });
      }
    }
    return NextResponse.json({ received: true });
  } catch (e) {
    logSignoffError("webhook", e);
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
}
