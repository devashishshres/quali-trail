import { apiError, ok } from "@/lib/api/responses";
import { importGate, UUID } from "@/lib/server/imports/http";
import { draftImport, toView } from "@/lib/server/imports/service";
import { importPorts, parseDraft } from "@/lib/server/imports/store";
import { guarded } from "@/lib/server/signoff/service";

export const maxDuration = 120;

/**
 * POST /api/imports/:id/draft — retry drafting after a failed attempt. Uses the stored listing (no new retrieval).
 * Concurrent or repeated calls never start a second model call, and a drafted or confirmed draft is never redone.
 */
async function handlePOST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate("start");
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError("not_found", "That import isn't available.");
  const ports = importPorts(gate.ctx.worker.id);
  if (!(await ports.load(id))) return apiError("not_found", "That import isn't available.");
  try {
    return ok(toView(await draftImport(ports, id), parseDraft));
  } catch (e) {
    console.error("POST /api/imports/:id/draft failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Drafting didn't finish. Please try again.");
  }
}

export const POST = guarded(handlePOST);
