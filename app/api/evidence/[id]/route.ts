import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { reconcileIndexing } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import type { GetEvidenceResponse } from "@/lib/types";

const SIGNED_URL_SECONDS = 60;

/**
 * GET /api/evidence/:id
 * The record plus, when an original exists, a 60-second signed URL created
 * with the caller's own session (storage RLS applies). The URL is returned,
 * never stored or logged.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to view this record.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid record id.");

  try {
    const { data: row, error } = await ctx.supabase
      .from("evidence")
      .select(`${EVIDENCE_COLUMNS}`)
      .eq("id", id.data)
      .eq("worker_id", ctx.worker.id)
      .maybeSingle<EvidenceRow>();
    if (error) throw new Error(`evidence query failed (${error.code})`);
    if (!row) return apiError("not_found", "That record isn't available.");

    const [fresh] = await reconcileIndexing(createAdminClient(), ctx.supabase, ctx.worker.id, [row]);

    let documentUrl: string | null = null;
    if (fresh.storage_path) {
      const { data, error: signError } = await ctx.supabase.storage.from("evidence").createSignedUrl(fresh.storage_path, SIGNED_URL_SECONDS);
      // An original exists: failing to sign it is an error, not "no file".
      if (signError || !data) return apiError("internal", "The original document couldn't be opened. Please try again.");
      documentUrl = data.signedUrl;
    }
    const body: GetEvidenceResponse = { evidence: toEvidence(fresh), documentUrl };
    return ok(body);
  } catch (e) {
    console.error("GET /api/evidence/:id failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not load this record. Please try again.");
  }
}
