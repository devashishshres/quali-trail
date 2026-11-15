import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { listWorkerReviews } from "@/lib/server/accounts/reviews";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AttestationsResponse, AttestationSummary } from "@/lib/types";

/**
 * GET /api/attestations — per-record customer acknowledgments and supervisor reviews for the evidence list
 * and the qualification packet. Deliberately omits customer addresses, typed signatures and comments.
 * Completed records are shown even when the features are switched off: turning a flag off never hides history.
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const items: Record<string, AttestationSummary> = {};
  const slot = (id: string) => (items[id] ??= { customer: [], supervisor: [] });
  try {
    const admin = createAdminClient();
    const { data: so, error } = await admin
      .from("signoff_requests")
      .select("id, evidence_id, evidence_version, status, delivery_mode, signoff_responses(created_at)")
      .eq("worker_id", ctx.worker.id)
      .order("created_at", { ascending: false })
      .limit(500);
    if (!error) {
      for (const r of so ?? []) {
        const resp = Array.isArray(r.signoff_responses) ? r.signoff_responses[0] : r.signoff_responses;
        slot(r.evidence_id).customer.push({ id: r.id, status: r.status, deliveryMode: r.delivery_mode, evidenceVersion: r.evidence_version, decidedAt: resp?.created_at ?? null });
      }
    }
    const reviews = await listWorkerReviews(ctx.worker.id).catch(() => []);
    for (const r of reviews) {
      slot(r.evidenceId).supervisor.push({
        id: r.id, status: r.status, evidenceVersion: r.evidenceVersion, decidedAt: r.decidedAt, observedTasks: r.observedTasks,
        reviewerName: r.reviewerName, reviewerOrganization: r.reviewerOrganization, reviewerTitle: r.reviewerTitle,
      });
    }
    return ok<AttestationsResponse>({ items });
  } catch (e) {
    console.error("GET /api/attestations failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Couldn't load acknowledgments and reviews.");
  }
}
