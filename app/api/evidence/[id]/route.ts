import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { EDIT_PROBLEM_MESSAGE, EDITABLE_STATUSES, editProblem } from "@/lib/server/signoff/edit-rules";
import { indexEvidence } from "@/lib/server/memory/indexing";
import { reconcileIndexing } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import { EditEvidenceRequest, type GetEvidenceResponse } from "@/lib/types";
import type { ConfirmEvidenceResponse } from "@/lib/types";

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

/**
 * PATCH /api/evidence/:id  { fields }
 * Phase 1: only work records and checklists whose status is self-reported or document-supplied.
 * Never changes verification_status (so an edit can never confirm or un-confirm anything) and never
 * changes the type. Existing database triggers bump the version, mark the record for re-indexing and
 * stale saved reports; open customer sign-off requests for the old version become "superseded".
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to edit this record.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid record id.");
  const body = EditEvidenceRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  const { fields } = body.data;

  try {
    const { data: row, error } = await ctx.supabase
      .from("evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("id", id.data)
      .eq("worker_id", ctx.worker.id)
      .maybeSingle<EvidenceRow>();
    if (error) throw new Error(`evidence query failed (${error.code})`);
    if (!row) return apiError("not_found", "That record isn't available.");

    const current = toEvidence(row);
    const problem = editProblem(current, fields.type);
    if (problem) return apiError("forbidden", EDIT_PROBLEM_MESSAGE[problem]);

    // The conditions are repeated in the UPDATE so a status change between the read and the write is not overwritten.
    const { data: updated, error: updateError } = await ctx.supabase
      .from("evidence")
      .update({
        title: fields.title,
        source_date: fields.date,
        issuer: fields.issuer,
        structured_data: fields.structuredData,
      })
      .eq("id", id.data)
      .eq("worker_id", ctx.worker.id)
      .eq("type", current.type)
      .in("verification_status", [...EDITABLE_STATUSES])
      .select("id");
    if (updateError) throw new Error(`evidence update failed (${updateError.code})`);
    if (!updated?.length) return apiError("forbidden", EDIT_PROBLEM_MESSAGE.not_editable);

    const read = async () =>
      (await ctx.supabase.from("evidence").select(EVIDENCE_COLUMNS).eq("id", id.data).eq("worker_id", ctx.worker.id).maybeSingle<EvidenceRow>()).data;
    const saved = await read();
    if (!saved) throw new Error("edited evidence could not be read back");
    // Saved first; indexing can fail without losing the edit (the record shows its index state).
    await indexEvidence(createAdminClient(), toEvidence(saved));
    const final = (await read()) ?? saved;
    return ok<ConfirmEvidenceResponse>({ evidence: toEvidence(final) });
  } catch (e) {
    console.error("PATCH /api/evidence/:id failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not save your changes. Please try again.");
  }
}
