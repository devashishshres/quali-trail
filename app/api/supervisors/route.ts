import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { DELIVERY_FAILURE_MESSAGE, deliver } from "@/lib/server/email/deliver";
import { emailMode, emailReady } from "@/lib/server/email/config";
import { templates } from "@/lib/server/email/templates";
import { hmac, maskEmail, newToken, normalizeEmail } from "@/lib/server/signoff/crypto";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, appBaseUrl, guarded, rpc } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { InviteSupervisorRequest, type WorkerRelationship } from "@/lib/types";

const VALID_DAYS = 14;
const REASON: Record<string, string> = {
  own_email: "Invite someone else: you can't review your own work.",
  suppressed: "This address has opted out or can't receive email.",
  already_connected: "This person is already one of your supervisors.",
  duplicate_open: "There's already an open invitation to this address.",
  limit: "You've sent a lot of invitations today. Try again tomorrow.",
};

/** GET /api/supervisors — this worker's supervisor relationships (masked addresses only). */
async function handleGET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return ok({ enabled: false, relationships: [] });
  const admin = createAdminClient();
  await admin.rpc("review_expire_due");
  const { data, error } = await admin
    .from("supervisor_relationships")
    .select("id, status, email_hint, supervisor_auth_user_id, created_at, accepted_at, expires_at")
    .eq("worker_id", ctx.worker.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return apiError("internal", "Couldn't load your supervisors.");
  const ids = [...new Set((data ?? []).map((r) => r.supervisor_auth_user_id).filter(Boolean))] as string[];
  const { data: profiles } = ids.length
    ? await admin.from("supervisor_profiles").select("auth_user_id, name, organization, title").in("auth_user_id", ids)
    : { data: [] as { auth_user_id: string; name: string; organization: string | null; title: string | null }[] };
  const byId = new Map((profiles ?? []).map((p) => [p.auth_user_id, p]));
  const relationships: WorkerRelationship[] = (data ?? []).map((r) => {
    const p = r.supervisor_auth_user_id ? byId.get(r.supervisor_auth_user_id) : undefined;
    return {
      id: r.id, status: r.status, emailHint: r.email_hint,
      supervisorName: p?.name ?? null, supervisorOrganization: p?.organization ?? null, supervisorTitle: p?.title ?? null,
      createdAt: r.created_at, acceptedAt: r.accepted_at, expiresAt: r.expires_at,
    };
  });
  return ok({ enabled: true, canSend: emailReady(), mode: emailMode(), relationships });
}

/** POST /api/supervisors — invite a supervisor by email. */
async function handlePOST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!supervisorReviewEnabled()) return apiError("not_found", "Supervisor review isn't available.");
  if (!emailReady()) return apiError("validation_failed", "Email isn't configured on this server yet, so invitations can't be sent.");
  const body = InviteSupervisorRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  if (!(await allow("sup-invite-worker", ctx.worker.id, 3600, 10))) return apiError("rate_limited", "Too many invitations this hour.");

  const email = normalizeEmail(body.data.email);
  const token = newToken();
  try {
    const r = await rpc("sup_invite_create", {
      p_worker: ctx.worker.id, p_email: email, p_email_hash: hmac("email", email), p_hint: maskEmail(email), p_token_hash: hmac("token", token), p_valid_days: VALID_DAYS,
    });
    if (!r.ok) return apiError("validation_failed", REASON[String(r.reason)] ?? "Couldn't create the invitation.");
    const base = appBaseUrl();
    const sent = await deliver({
      kind: "supervisor_invitation",
      to: email,
      rendered: templates.supervisorInvitation({ base, mock: emailMode() === "mock", workerName: ctx.worker.name, link: `${base}/invite/supervisor#t=${token}`, validDays: VALID_DAYS }),
      idempotencyKey: `sup-invite-${r.id}-1`,
      related: { type: "supervisor_relationship", id: String(r.id) },
      workerId: ctx.worker.id,
    });
    if (!sent.ok) {
      await rpc("sup_relationship_revoke", { p_auth: ctx.authUserId, p_relationship: r.id });
      return apiError("internal", `${DELIVERY_FAILURE_MESSAGE[sent.reason]} The invitation was cancelled.`);
    }
    return ok({ id: r.id }, 201);
  } catch (e) {
    logSignoffError("sup-invite", e);
    return apiError("internal", "Couldn't send the invitation.");
  }
}

export const GET = guarded(handleGET);

export const POST = guarded(handlePOST);
