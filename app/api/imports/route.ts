import { apiError, ok } from "@/lib/api/responses";
import { importGate } from "@/lib/server/imports/http";
import { startImport, toView } from "@/lib/server/imports/service";
import { importPorts, parseDraft } from "@/lib/server/imports/store";
import { guarded } from "@/lib/server/signoff/service";
import { StartImportRequest } from "@/lib/types/imports";

/** Our own budget (100 s) is enforced in code; this only keeps the platform from cutting in earlier. */
export const maxDuration = 120;

/**
 * POST /api/imports  { url } | { text }
 * Retrieves ONE public listing (TinyFish receives the URL only) or takes pasted text, then drafts requirements for
 * the technician to review. Nothing is compared and nothing is saved as a job until the technician confirms.
 */
async function handlePOST(request: Request) {
  const gate = await importGate("start");
  if ("response" in gate) return gate.response;
  const body = StartImportRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Paste a job listing link, or at least a few lines of the listing text.");
  try {
    const out = await startImport(importPorts(gate.ctx.worker.id), body.data);
    if (out.kind === "rejected") return apiError("validation_failed", out.message, { url: [out.message] });
    if (out.kind === "busy") {
      return apiError("rate_limited", out.reason === "daily_limit" ? "You've reached today's limit for retrieving job listings. You can still paste listing text." : "That listing is already being retrieved. Wait a moment.");
    }
    return ok(toView(out.row, parseDraft), 201);
  } catch (e) {
    console.error("POST /api/imports failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "The import didn't finish. Please try again.");
  }
}

export const POST = guarded(handlePOST);
