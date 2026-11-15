import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { indexEvidence } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import type { ReindexResponse } from "@/lib/types";

/** POST /api/evidence/:id/reindex — retry sending a record to memory (idempotent). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to retry indexing.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid record id.");

  try {
    const read = async () =>
      (await ctx.supabase.from("evidence").select(EVIDENCE_COLUMNS).eq("id", id.data).eq("worker_id", ctx.worker.id).maybeSingle<EvidenceRow>()).data;
    const row = await read();
    if (!row) return apiError("not_found", "That record isn't available.");

    // Ownership proven above; the admin client writes only this (id, worker) row.
    if (row.index_status !== "processing") await indexEvidence(createAdminClient(), toEvidence(row));
    const after = (await read()) ?? row;
    const body: ReindexResponse = { evidence: toEvidence(after) };
    return ok(body);
  } catch (e) {
    console.error("POST /api/evidence/:id/reindex failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not retry indexing. Please try again.");
  }
}
