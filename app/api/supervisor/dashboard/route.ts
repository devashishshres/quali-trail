import { getSupervisorContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/supervisor/dashboard — the caller's own connections and the requests addressed to them. */
export async function GET() {
  const s = await getSupervisorContext();
  if (!s) return apiError("unauthorized", "Sign in with a confirmed reviewer account.");
  const admin = createAdminClient();
  const { data: rels } = await admin
    .from("supervisor_relationships")
    .select("id, worker_id, accepted_at")
    .eq("supervisor_auth_user_id", s.user.id)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false });
  const workerIds = [...new Set((rels ?? []).map((r) => r.worker_id))];
  const { data: workers } = workerIds.length ? await admin.from("workers").select("id, name, trade").in("id", workerIds) : { data: [] as { id: string; name: string; trade: string }[] };
  const names = new Map((workers ?? []).map((w) => [w.id, w]));
  const reviews = supervisorReviewEnabled() ? ((await admin.rpc("review_list_for_supervisor", { p_auth: s.user.id })).data ?? []) : [];
  return ok({
    enabled: supervisorReviewEnabled(),
    profile: { name: s.supervisor.name, organization: s.supervisor.organization, title: s.supervisor.title },
    connections: (rels ?? []).map((r) => ({ id: r.id, workerName: names.get(r.worker_id)?.name ?? "Unknown", trade: names.get(r.worker_id)?.trade ?? "", acceptedAt: r.accepted_at })),
    reviews,
  });
}
