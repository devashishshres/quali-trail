import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { importGate, UUID } from "@/lib/server/imports/http";
import { applyReview, ReviewError, toView } from "@/lib/server/imports/service";
import { importPorts, parseDraft, saveReview } from "@/lib/server/imports/store";
import { guarded } from "@/lib/server/signoff/service";
import { SaveImportReviewRequest } from "@/lib/types/imports";

type Params = { params: Promise<{ id: string }> };

/** GET /api/imports/:id — the technician's own draft. */
async function handleGET(_: Request, { params }: Params) {
  const gate = await importGate("read");
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError("not_found", "That import isn't available.");
  const row = await importPorts(gate.ctx.worker.id).load(id);
  if (!row) return apiError("not_found", "That import isn't available.");
  return ok(toView(row, parseDraft));
}

/** PUT /api/imports/:id — save review edits (cosmetic wording, priority, remove, mark for manual review). */
async function handlePUT(request: Request, { params }: Params) {
  const gate = await importGate("write");
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError("not_found", "That import isn't available.");
  const body = SaveImportReviewRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  const ports = importPorts(gate.ctx.worker.id);
  const row = await ports.load(id);
  if (!row) return apiError("not_found", "That import isn't available.");
  const draft = row.status === "drafted" ? parseDraft(row.draft) : null;
  if (!draft) return apiError("validation_failed", row.status === "confirmed" ? "This job was already confirmed." : "This draft can't be edited right now.");
  try {
    const next = applyReview(draft, body.data);
    const v = await saveReview(gate.ctx.worker.id, id, body.data.version, next);
    if (v === null) return apiError("validation_failed", "This draft changed in another tab, or expired. Reload it and try again.");
    return ok(toView((await ports.load(id))!, parseDraft));
  } catch (e) {
    if (e instanceof ReviewError) return apiError("validation_failed", e.message);
    console.error("PUT /api/imports/:id failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Your changes weren't saved. Please try again.");
  }
}

export const GET = guarded(handleGET);
export const PUT = guarded(handlePUT);
