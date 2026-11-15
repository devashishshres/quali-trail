import "server-only";
import type { AuthedContext } from "@/lib/api/auth";
import { listWorkerReviews } from "@/lib/server/accounts/reviews";
import { latestRunId, loadWorkerEvidence, readRun } from "@/lib/server/matching/store";
import { getWorkerOpportunity } from "@/lib/server/opportunities/queries";
import { hmac } from "@/lib/server/signoff/crypto";
import { rpcValue } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { employerReviewEnabled } from "./flags";
import type { CustomerAck, PacketInputs } from "./packet";

/** Does this address hold an open employer share? Used ONLY to let it register an account; never for any role. */
export async function hasPendingEmployerShare(email: string): Promise<boolean> {
  if (!employerReviewEnabled()) return false;
  return (await rpcValue<boolean>("account_has_pending_employer_share", { p_email_hash: hmac("email", email.trim().toLowerCase()) })) === true;
}

/**
 * Everything the packet builder needs, read for THIS worker only. Returns null when the job or its report is not
 * theirs or does not exist. Supervisor reviewer names are passed along with the consent list; the builder drops
 * them unless consent was recorded.
 */
export async function loadPacketInputs(ctx: AuthedContext, opportunityId: string): Promise<PacketInputs | null> {
  const opportunity = await getWorkerOpportunity(ctx.supabase, ctx.worker.id, opportunityId);
  if (!opportunity) return null;
  const runId = await latestRunId(ctx.supabase, ctx.worker.id, opportunityId);
  if (!runId) return null;
  const [run, evidence, reviews, consented, acks] = await Promise.all([
    readRun(ctx.supabase, ctx.worker.id, runId),
    loadWorkerEvidence(ctx.supabase, ctx.worker.id),
    listWorkerReviews(ctx.worker.id),
    rpcValue<string[]>("review_share_consented", { p_worker: ctx.worker.id }),
    customerAcks(ctx.worker.id),
  ]);
  if (!run) return null;
  return {
    worker: { name: ctx.worker.name, trade: ctx.worker.trade, isSynthetic: ctx.worker.is_synthetic },
    opportunity,
    run,
    evidence,
    customerAcks: acks,
    reviews,
    consentedReviewIds: new Set(consented ?? []),
    now: new Date(),
  };
}

async function customerAcks(workerId: string): Promise<CustomerAck[]> {
  const { data, error } = await createAdminClient()
    .from("signoff_requests")
    .select("evidence_id, evidence_version, status, delivery_mode, signoff_responses(created_at)")
    .eq("worker_id", workerId)
    .eq("status", "acknowledged")
    .limit(500);
  if (error) throw new Error(`acknowledgments query failed (${error.code})`);
  return (data ?? []).map((r) => {
    const resp = Array.isArray(r.signoff_responses) ? r.signoff_responses[0] : r.signoff_responses;
    return { evidenceId: r.evidence_id, evidenceVersion: r.evidence_version, status: r.status, deliveryMode: r.delivery_mode, decidedAt: resp?.created_at ?? null };
  });
}

export const SHARE_REASON: Record<string, string> = {
  own_email: "Share with someone else: this is your own address.",
  suppressed: "This address has opted out or can't receive email.",
  limit: "You've shared a lot today. Try again tomorrow.",
  changed: "One of the records changed while you were sharing. Preview again and resend.",
  no_report: "This job has no current report. Run matching again before sharing.",
  no_original: "That record has no original document to share.",
  not_found: "One of the selected records isn't available.",
  invalid: "The selection didn't match the preview. Preview again and resend.",
};

export const SELECTION_MESSAGE: Record<string, string> = {
  no_report: "This job has no current report. Run matching again before sharing.",
  no_records: "Select at least one record to share.",
  not_in_report: "Only records linked in this job's report can be shared.",
  no_original: "An original can only be shared for a selected record that has one.",
};
