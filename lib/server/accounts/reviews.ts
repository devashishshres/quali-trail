import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkerReview } from "@/lib/types";

/** Read helper shared with the attestation summary. Worker-scoped; includes the reviewer's self-entered details. */
export async function listWorkerReviews(workerId: string, evidenceId?: string): Promise<WorkerReview[]> {
  const admin = createAdminClient();
  await admin.rpc("review_expire_due");
  let q = admin
    .from("review_requests")
    .select("id, evidence_id, evidence_version, relationship_id, status, supervisor_auth_user_id, created_at, expires_at, review_responses(decision, observed_tasks, comment, reviewer_name, reviewer_organization, reviewer_title, created_at)")
    .eq("worker_id", workerId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (evidenceId) q = q.eq("evidence_id", evidenceId);
  const { data, error } = await q;
  if (error) throw new Error(`reviews list failed (${error.code})`);
  const ids = [...new Set((data ?? []).map((r) => r.supervisor_auth_user_id))];
  const { data: profiles } = ids.length ? await admin.from("supervisor_profiles").select("auth_user_id, name").in("auth_user_id", ids) : { data: [] as { auth_user_id: string; name: string }[] };
  const names = new Map((profiles ?? []).map((p) => [p.auth_user_id, p.name]));
  return (data ?? []).map((r) => {
    const resp = Array.isArray(r.review_responses) ? r.review_responses[0] : r.review_responses;
    return {
      id: r.id, evidenceId: r.evidence_id, evidenceVersion: r.evidence_version, relationshipId: r.relationship_id, status: r.status,
      supervisorName: names.get(r.supervisor_auth_user_id) ?? null, createdAt: r.created_at, expiresAt: r.expires_at,
      decision: resp?.decision ?? null, observedTasks: resp?.observed_tasks ?? [], comment: resp?.comment ?? null,
      reviewerName: resp?.reviewer_name ?? null, reviewerOrganization: resp?.reviewer_organization ?? null, reviewerTitle: resp?.reviewer_title ?? null,
      decidedAt: resp?.created_at ?? null,
    };
  });
}
