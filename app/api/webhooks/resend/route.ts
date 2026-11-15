import { NextResponse } from "next/server";
import { applyWebhook, type ResendEvent } from "@/lib/server/email/webhook";
import { verifyWebhook } from "@/lib/server/email/webhook-signature";
import { logSignoffError } from "@/lib/server/signoff/redact";

/**
 * POST /api/webhooks/resend — delivery outcomes, bounces and complaints. Required before real customer use.
 * Signature is verified on the RAW body first. Duplicates (provider retries) are acknowledged and ignored.
 * Stored: a hash of the address (for suppression) and the provider message id. Never the address or body.
 * Deliberately NOT behind the sign-off flag: suppression must keep working even while features are off.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const raw = await request.text();
  const id = request.headers.get("svix-id");
  const valid = verifyWebhook(secret, { id, timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") }, raw);
  if (!valid || !id) return NextResponse.json({ error: "invalid signature" }, { status: 400 });

  let event: ResendEvent;
  try {
    event = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  try {
    const result = await applyWebhook(id, event);
    return NextResponse.json({ received: true, result });
  } catch (e) {
    logSignoffError("webhook", e);
    // 500 so the provider retries; the duplicate guard makes the retry safe.
    return NextResponse.json({ error: "temporary failure" }, { status: 500 });
  }
}
