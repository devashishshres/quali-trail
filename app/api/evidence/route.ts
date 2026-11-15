import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { readWorkerSummary } from "@/lib/server/profile";
import { reconcileIndexing } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, toWorker, type EvidenceRow } from "@/lib/supabase/mappers";
import type { ListEvidenceResponse } from "@/lib/types";

/**
 * GET /api/evidence
 * Returns the signed-in worker's profile and evidence, newest first.
 * RLS restricts rows to the caller; the explicit worker_id filter is a
 * second, independent check.
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to view your evidence.");

  const { data, error } = await ctx.supabase
    .from("evidence")
    .select(EVIDENCE_COLUMNS)
    .eq("worker_id", ctx.worker.id)
    .order("source_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .returns<EvidenceRow[]>();

  if (error) {
    console.error("GET /api/evidence failed", { code: error.code });
    return apiError("internal", "Could not load evidence. Please try again.");
  }

  // Check actual indexing progress (bounded, best-effort) before answering.
  let rows = data;
  try {
    rows = await reconcileIndexing(createAdminClient(), ctx.supabase, ctx.worker.id, data);
  } catch (e) {
    console.error("index reconcile skipped", { message: e instanceof Error ? e.message : "unknown" });
  }

  const body: ListEvidenceResponse = {
    worker: toWorker({ ...ctx.worker, summary: await readWorkerSummary(ctx.supabase, ctx.worker.id) }),
    evidence: rows.map(toEvidence),
  };
  return ok(body);
}
