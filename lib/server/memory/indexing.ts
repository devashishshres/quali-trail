import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Evidence } from "@/lib/types";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import { memoryDocId } from "./conventions";
import { deleteMemoryDocument, readIndexState, submitEvidence } from "./client";

type IndexStatus = "pending" | "processing" | "indexed" | "failed";

/**
 * Trusted index-state writes. `admin` bypasses RLS, so EVERY write is pinned to
 * (id, worker_id) of a row the caller already loaded as the signed-in worker.
 */
async function setIndexState(
  admin: SupabaseClient,
  evidence: Pick<Evidence, "id" | "workerId" | "version">,
  status: IndexStatus,
  error: string | null,
): Promise<void> {
  const { error: dbError } = await admin
    .from("evidence")
    .update({ index_status: status, index_error: error, memory_document_id: memoryDocId(evidence.id, evidence.version) })
    .eq("id", evidence.id)
    .eq("worker_id", evidence.workerId)
    .eq("version", evidence.version);
  if (dbError) throw new Error(`index state write failed (${dbError.code})`);
}

/**
 * Submit a record to memory. NEVER throws: the saved record must survive an
 * indexing failure, which is shown as `failed` and can be retried.
 * `supersedes` is the previously indexed document id of an older version.
 */
export async function indexEvidence(admin: SupabaseClient, evidence: Evidence, supersedes?: string | null): Promise<void> {
  try {
    const status = await submitEvidence(evidence);
    await setIndexState(admin, evidence, status, status === "failed" ? "Memory processing failed. Try again." : null);
    const current = memoryDocId(evidence.id, evidence.version);
    if (supersedes && supersedes !== current) await deleteMemoryDocument(evidence.workerId, supersedes);
  } catch (e) {
    console.error("memory submit failed", { evidenceId: evidence.id, status: (e as { statusCode?: number }).statusCode });
    await setIndexState(admin, evidence, "failed", "Memory is unavailable right now. Try again.").catch(() => {});
  }
}

/**
 * Bring in-flight records up to date:
 *  - `pending` rows are submitted;
 *  - `indexed` rows whose memory_document_id is for an OLDER version (the record
 *    changed, e.g. a verification update bumped its version) are re-submitted
 *    under the new versioned id;
 *  - `processing` rows are checked for ACTUAL completion at the provider.
 * Bounded per call; a provider outage leaves rows as they were.
 * Returns rows re-read from the database.
 */
export async function reconcileIndexing(
  admin: SupabaseClient,
  user: SupabaseClient,
  workerId: string,
  rows: EvidenceRow[],
  max = 8,
): Promise<EvidenceRow[]> {
  if (rows.length === 0) return rows;

  const { data: docs } = await user.from("evidence").select("id, memory_document_id").eq("worker_id", workerId).in("id", rows.map((r) => r.id));
  const docId = new Map((docs ?? []).map((d) => [d.id as string, (d.memory_document_id as string | null) ?? null]));

  const needsWork = (r: EvidenceRow) =>
    r.index_status === "pending" ||
    r.index_status === "processing" ||
    (r.index_status === "indexed" && docId.get(r.id) !== memoryDocId(r.id, r.version));
  const work = rows.filter(needsWork).slice(0, max);
  if (work.length === 0) return rows;

  await Promise.all(
    work.map(async (row) => {
      const e = toEvidence(row);
      const expected = memoryDocId(e.id, e.version);
      if (row.index_status === "processing" && docId.get(row.id) === expected) {
        try {
          const state = await readIndexState(workerId, e.id, e.version);
          if (state.status !== "processing") await setIndexState(admin, e, state.status, state.error);
        } catch {
          /* provider unreachable: leave as processing, next poll retries */
        }
        return;
      }
      // pending, or indexed under an older version's id
      await indexEvidence(admin, e, docId.get(row.id));
    }),
  );

  const { data } = await user
    .from("evidence")
    .select(EVIDENCE_COLUMNS)
    .eq("worker_id", workerId)
    .in("id", work.map((w) => w.id))
    .returns<EvidenceRow[]>();
  const fresh = new Map((data ?? []).map((r) => [r.id, r]));
  return rows.map((r) => fresh.get(r.id) ?? r);
}
