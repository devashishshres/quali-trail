import { apiError, ok } from "@/lib/api/responses";
import { importGate, UUID } from "@/lib/server/imports/http";
import { buildConfirmation, ReviewError } from "@/lib/server/imports/service";
import { confirmImport, importPorts, parseDraft } from "@/lib/server/imports/store";
import { guarded } from "@/lib/server/signoff/service";
import { ConfirmImportRequest, type ConfirmImportResponse } from "@/lib/types/imports";

/**
 * POST /api/imports/:id/confirm  { version, acknowledgeWarnings }
 * Creates the job and its requirements in ONE database transaction. Repeating it returns the same job.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate("write");
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError("not_found", "That import isn't available.");
  const body = ConfirmImportRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Reload the draft and try again.");

  const row = await importPorts(gate.ctx.worker.id).load(id);
  if (!row) return apiError("not_found", "That import isn't available.");
  if (row.status === "confirmed" && row.opportunity_id) return ok<ConfirmImportResponse>({ opportunityId: row.opportunity_id, repeated: true });
  const draft = row.status === "drafted" ? parseDraft(row.draft) : null;
  if (!draft) return apiError("validation_failed", "This draft isn't ready to confirm.");
  if ((row.warnings ?? []).length > 0 && !body.data.acknowledgeWarnings) {
    return apiError("validation_failed", "Read the warnings about this listing and tick the box to continue.", { acknowledgeWarnings: ["Required"] });
  }
  try {
    const retrievedOn = (row.retrieved_at ?? new Date().toISOString()).slice(0, 10);
    const p = buildConfirmation(row, draft, retrievedOn);
    const r = await confirmImport(gate.ctx.worker.id, id, body.data.version, p.opportunity, p.requirements);
    if (r.ok && r.opportunityId) return ok<ConfirmImportResponse>({ opportunityId: r.opportunityId, repeated: r.repeated === true });
    const msg = { changed: "This draft changed in another tab. Reload it and try again.", expired: "This draft expired. Import the listing again.", not_ready: "This draft isn't ready to confirm.", not_found: "That import isn't available." }[r.reason ?? "not_ready"];
    return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", msg);
  } catch (e) {
    if (e instanceof ReviewError) return apiError("validation_failed", e.message);
    console.error("POST /api/imports/:id/confirm failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "The job wasn't saved. Please try again.");
  }
}

export const POST = guarded(handlePOST);
