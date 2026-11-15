import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const DRAFT_TTL_HOURS = 24;
const CLEANUP_BATCH = 20;

/**
 * Bounded cleanup of THIS worker's abandoned drafts and their uploaded PDFs.
 * Only drafts (never evidence) older than 24 h are touched, at most 20 per
 * call. A draft's file lives at <auth_uid>/<draftId>.pdf; after confirmation
 * that same path belongs to the evidence row, but the draft row is already
 * gone by then, so a live record's file is never selected here.
 */
export async function cleanupAbandonedDrafts(user: SupabaseClient, admin: SupabaseClient, workerId: string, authUserId: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - DRAFT_TTL_HOURS * 3600_000).toISOString();
    const { data } = await user
      .from("evidence_drafts")
      .select("id, storage_path")
      .eq("worker_id", workerId)
      .lt("created_at", cutoff)
      .limit(CLEANUP_BATCH);
    if (!data?.length) return;

    // Never remove a file an evidence row still references.
    const { data: live, error: liveError } = await user
      .from("evidence")
      .select("storage_path")
      .eq("worker_id", workerId)
      .in("storage_path", data.map((d) => d.storage_path).filter((p): p is string => !!p));
    if (liveError) return; // Never delete files when reference lookup failed.
    const keep = new Set((live ?? []).map((r) => r.storage_path));
    const files = data.map((d) => d.storage_path).filter((p): p is string => !!p && p.startsWith(`${authUserId}/`) && !keep.has(p));

    if (files.length) await admin.storage.from("evidence").remove(files);
    await admin.from("evidence_drafts").delete().eq("worker_id", workerId).in("id", data.map((d) => d.id));
  } catch {
    /* cleanup is best-effort and must never fail a request */
  }
}
