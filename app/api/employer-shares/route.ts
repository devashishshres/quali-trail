import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { DELIVERY_FAILURE_MESSAGE, deliver } from "@/lib/server/email/deliver";
import { emailMode, emailReady } from "@/lib/server/email/config";
import { templates } from "@/lib/server/email/templates";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { buildPacket, PacketSelectionError } from "@/lib/server/employer/packet";
import { loadPacketInputs, SELECTION_MESSAGE, SHARE_REASON } from "@/lib/server/employer/service";
import { hmac, maskEmail, newToken, normalizeEmail } from "@/lib/server/signoff/crypto";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, appBaseUrl, guarded, rpc, rpcValue } from "@/lib/server/signoff/service";
import { CreateShareRequest, PACKET_FORMAT, WorkerShare } from "@/lib/types/employer";

/** GET /api/employer-shares — this technician's shares (masked addresses, access counts). */
async function handleGET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return ok({ enabled: false, canSend: false, shares: [] });
  const list = await rpcValue<unknown[]>("employer_share_list_for_worker", { p_worker: ctx.worker.id });
  if (!Array.isArray(list)) return apiError("internal", "Couldn't load your shares.");
  return ok({ enabled: true, canSend: emailReady(), mode: emailMode(), shares: list.map((s) => WorkerShare.parse(s)) });
}

/**
 * POST /api/employer-shares — share one frozen packet with one email address. The packet is rebuilt here from the
 * technician's own data with the same builder as the preview; nothing in it comes from the request body except the
 * selection itself.
 */
async function handlePOST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return apiError("not_found", "Sharing with employers isn't available.");
  if (!emailReady()) return apiError("validation_failed", "Email isn't configured on this server yet, so packets can't be shared.");
  const body = CreateShareRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("employer-share-worker", ctx.worker.id, 3600, 10))) return apiError("rate_limited", "Too many shares this hour.");

  const d = body.data;
  try {
    const inputs = await loadPacketInputs(ctx, d.opportunityId);
    if (!inputs) return apiError("not_found", "Run a match for this job first.");
    let packet;
    try {
      packet = buildPacket(inputs, d);
    } catch (e) {
      if (e instanceof PacketSelectionError) return apiError("validation_failed", SELECTION_MESSAGE[e.reason]);
      throw e;
    }
    const email = normalizeEmail(d.email);
    const token = newToken();
    const originals = new Set(d.originalIds);
    const r = await rpc("employer_share_create", {
      p_worker: ctx.worker.id, p_run: inputs.run.id, p_packet_format: PACKET_FORMAT, p_packet: packet,
      p_records: packet.records.map((x) => ({ id: x.id, original: originals.has(x.id) })),
      p_email: email, p_email_hash: hmac("email", email), p_hint: maskEmail(email), p_token_hash: hmac("token", token), p_valid_days: d.validDays,
    });
    if (!r.ok) return apiError("validation_failed", SHARE_REASON[String(r.reason)] ?? "Couldn't share the packet.");
    const base = appBaseUrl();
    const sent = await deliver({
      kind: "employer_share_invitation",
      to: email,
      rendered: templates.employerShareInvitation({ base, mock: emailMode() === "mock", workerName: ctx.worker.name, link: `${base}/invite/employer#t=${token}`, validDays: d.validDays }),
      idempotencyKey: `employer-share-${r.id}-1`,
      related: { type: "employer_share", id: String(r.id) },
      workerId: ctx.worker.id,
    });
    if (!sent.ok) {
      await rpc("employer_share_revoke", { p_worker: ctx.worker.id, p_share: r.id });
      return apiError("internal", `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The share was cancelled.`);
    }
    return ok({ id: r.id }, 201);
  } catch (e) {
    logSignoffError("employer-share", e);
    return apiError("internal", "Couldn't share the packet.");
  }
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);
