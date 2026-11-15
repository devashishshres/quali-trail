import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { indexEvidence } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import { ConfirmEvidenceRequest, type ConfirmEvidenceResponse } from "@/lib/types";

/**
 * POST /api/evidence/confirm  { draftId, fields }
 * Idempotent: the evidence id IS the draft id, so a repeated or concurrent
 * confirm returns the same saved record. Source, verification and index state
 * are decided HERE, never taken from the client.
 */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to save evidence.");
  const { supabase, worker } = ctx;

  const body = ConfirmEvidenceRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  }
  const { draftId, fields } = body.data;

  const readSaved = async () => {
    const { data } = await supabase.from("evidence").select(EVIDENCE_COLUMNS).eq("id", draftId).eq("worker_id", worker.id).maybeSingle<EvidenceRow>();
    return data ? toEvidence(data) : null;
  };

  try {
    // Already confirmed (retry or double click): return it.
    const existing = await readSaved();
    if (existing) return ok<ConfirmEvidenceResponse>({ evidence: existing });

    const { data: draft, error } = await supabase
      .from("evidence_drafts")
      .select("id, source_kind, storage_path, mime_type, file_hash")
      .eq("id", draftId)
      .eq("worker_id", worker.id)
      .maybeSingle();
    if (error) throw new Error(`draft query failed (${error.code})`);
    if (!draft) return apiError("not_found", "That draft has expired. Add the record again.");

    const admin = createAdminClient();
    const { error: insertError } = await admin.from("evidence").insert({
      id: draft.id,
      worker_id: worker.id, // from the session, never the request
      type: fields.type,
      title: fields.title,
      source_date: fields.date,
      issuer: fields.issuer,
      structured_data: fields.structuredData,
      source_kind: draft.source_kind,
      storage_path: draft.storage_path,
      mime_type: draft.mime_type,
      file_hash: draft.file_hash,
      // Server-derived. A worker cannot claim anything stronger.
      verification_status: draft.source_kind === "pdf_upload" ? "document_supplied" : "self_reported",
      index_status: "pending",
      is_synthetic: worker.is_synthetic,
    });

    if (insertError) {
      if (insertError.code === "23505") {
        const raced = await readSaved(); // concurrent confirm of the same draft
        if (raced) return ok<ConfirmEvidenceResponse>({ evidence: raced });
        const { data: dup } = await supabase.from("evidence").select("id").eq("worker_id", worker.id).eq("file_hash", draft.file_hash).maybeSingle();
        return apiError("duplicate_evidence", `This is already saved${dup ? ` (record ${dup.id.slice(-12)})` : ""}.`);
      }
      throw new Error(`evidence insert failed (${insertError.code})`);
    }

    await admin.from("evidence_drafts").delete().eq("id", draft.id).eq("worker_id", worker.id);

    // Saved first; indexing can fail without losing the record.
    const saved = await readSaved();
    if (!saved) throw new Error("saved evidence could not be read back");
    await indexEvidence(admin, saved);
    const final = (await readSaved()) ?? saved;
    return ok<ConfirmEvidenceResponse>({ evidence: final });
  } catch (e) {
    console.error("POST /api/evidence/confirm failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not save this record. Please try again.");
  }
}
