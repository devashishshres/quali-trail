import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { createUserClient } from "@/lib/supabase/server";
import { signoffStatus } from "@/lib/server/signoff/config";
import { hmac, maskEmail, newToken, normalizeEmail } from "@/lib/server/signoff/crypto";
import { DELIVERY_FAILURE_MESSAGE, deliver } from "@/lib/server/email/deliver";
import { templates } from "@/lib/server/email/templates";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, appBaseUrl, featureOn, guarded, rpc } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { CreateSignoffRequest, type ListSignoffsResponse, type WorkerSignoff } from "@/lib/types";

const VALID_DAYS = 7;

const REASON_MESSAGE: Record<string, string> = {
  not_found: "That record isn't available.",
  unsupported_type: "Customer sign-off is available for work records and checklists only.",
  not_eligible: "This record can't be sent for sign-off in its current verification state.",
  own_email: "Use the customer's address, not your own.",
  suppressed: "This address has opted out or could not receive email, so no request can be sent to it.",
  duplicate_open: "There is already an open request for this record. Revoke it first to send a new one.",
  declined_same_version: "This customer declined this version of the record. Edit the record before asking again.",
  cap_reached: "The limit of requests to this customer for this record has been reached.",
};

/** GET /api/signoff/requests?evidenceId=… — this worker's requests (masked address only). */
async function handleGET(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!featureOn()) return ok<ListSignoffsResponse>({ requests: [] }); // existing acknowledgments are shown only when the feature is on
  const evidenceId = new URL(request.url).searchParams.get("evidenceId");
  if (evidenceId && !z.uuid().safeParse(evidenceId).success) return apiError("validation_failed", "That isn't a valid record id.");

  try {
    const admin = createAdminClient();
    await admin.rpc("signoff_expire_due");
    let q = admin
      .from("signoff_requests")
      .select("id, evidence_id, evidence_version, status, email_hint, delivery_mode, created_at, expires_at, email_verified_at, signoff_responses(decision, typed_name, comment, created_at)")
      .eq("worker_id", ctx.worker.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (evidenceId) q = q.eq("evidence_id", evidenceId);
    const { data, error } = await q;
    if (error) throw new Error(`list failed (${error.code})`);
    const requests: WorkerSignoff[] = (data ?? []).map((r) => {
      const resp = Array.isArray(r.signoff_responses) ? r.signoff_responses[0] : r.signoff_responses;
      return {
        id: r.id,
        evidenceId: r.evidence_id,
        evidenceVersion: r.evidence_version,
        status: r.status,
        emailHint: r.email_hint,
        deliveryMode: r.delivery_mode,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        emailVerifiedAt: r.email_verified_at,
        decision: resp?.decision ?? null,
        decidedAt: resp?.created_at ?? null,
        typedName: resp?.typed_name ?? null,
        comment: resp?.comment ?? null,
      };
    });
    return ok<ListSignoffsResponse>({ requests });
  } catch (e) {
    logSignoffError("list", e);
    return apiError("internal", "Could not load sign-off requests.");
  }
}

/** POST /api/signoff/requests — create a request and send the invitation. */
async function handlePOST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const status = signoffStatus();
  if (!status.enabled) return apiError("not_found", "Customer sign-off isn't available.");
  if (!status.ready) return apiError("validation_failed", "Customer sign-off isn't configured on this server yet.");

  const body = CreateSignoffRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("create-worker", ctx.worker.id, 3600, 20))) return apiError("rate_limited", "Too many requests this hour. Please try again later.");

  const email = normalizeEmail(body.data.customerEmail);
  const token = newToken();
  try {
    const { data: userData } = await (await createUserClient()).auth.getUser();
    const own = userData.user?.email ? hmac("email", normalizeEmail(userData.user.email)) : null;
    const created = await rpc("signoff_create_request", {
      p_worker: ctx.worker.id,
      p_evidence: body.data.evidenceId,
      p_email: email,
      p_name: body.data.customerName ?? null,
      p_email_hash: hmac("email", email),
      p_hint: maskEmail(email),
      p_token_hash: hmac("token", token),
      p_delivery_mode: status.mode === "resend" ? "resend" : "mock",
      p_worker_email_hash: own,
      p_valid_days: VALID_DAYS,
    });
    if (!created.ok) {
      const reason = String(created.reason);
      return apiError(reason === "not_found" ? "not_found" : "validation_failed", REASON_MESSAGE[reason] ?? "Could not create the request.");
    }
    const requestId = String(created.id);
    const base = appBaseUrl();
    const link = `${base}/signoff#t=${token}`;
    const sent = await deliver({
      kind: "customer_invitation",
      to: email,
      rendered: templates.customerInvitation({ base, mock: status.mode === "mock", workerName: ctx.worker.name, link, validDays: VALID_DAYS }),
      idempotencyKey: `invite-${requestId}-1`,
      related: { type: "signoff_request", id: requestId },
      workerId: ctx.worker.id,
    });
    if (!sent.ok) {
      await rpc("signoff_revoke_request", { p_worker: ctx.worker.id, p_request: requestId });
      return apiError("internal", `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The request was cancelled so nothing is left half-sent.`);
    }
    return ok({ id: requestId, mode: status.mode }, 201);
  } catch (e) {
    logSignoffError("create", e);
    return apiError("internal", "Could not create the request.");
  }
}

export const GET = guarded(handleGET);

export const POST = guarded(handlePOST);
