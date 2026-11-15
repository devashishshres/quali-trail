import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { buildPacket, PacketSelectionError } from "@/lib/server/employer/packet";
import { loadPacketInputs, SELECTION_MESSAGE } from "@/lib/server/employer/service";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, guarded } from "@/lib/server/signoff/service";
import { ShareSelection } from "@/lib/types/employer";

/** POST /api/employer-shares/preview — exactly what an employer would see for this selection. Nothing is saved or sent. */
async function handlePOST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return apiError("not_found", "Sharing with employers isn't available.");
  const body = ShareSelection.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check your selection.", fieldErrors(body.error));
  if (!(await allow("employer-preview-worker", ctx.worker.id, 600, 60))) return apiError("rate_limited", "Too many previews. Please wait a few minutes.");
  try {
    const inputs = await loadPacketInputs(ctx, body.data.opportunityId);
    if (!inputs) return apiError("not_found", "Run a match for this job first.");
    return ok({ packet: buildPacket(inputs, body.data) });
  } catch (e) {
    if (e instanceof PacketSelectionError) return apiError("validation_failed", SELECTION_MESSAGE[e.reason]);
    logSignoffError("employer-preview", e);
    return apiError("internal", "Couldn't build the preview.");
  }
}

export const POST = guarded(handlePOST);
