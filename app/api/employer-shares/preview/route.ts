import { connection } from "next/server";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { buildPacket, PacketSelectionError } from "@/lib/server/employer/packet";
import { loadCandidates, SELECTION_MESSAGE } from "@/lib/server/employer/service";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, guarded, off } from "@/lib/server/signoff/service";
import { ShareSelection } from "@/lib/types/employer";

/** POST /api/employer-shares/preview — exactly what an employer would see for this selection. Nothing is saved or sent. */
async function handlePOST(request: Request) {
  await connection(); // per request, never prerendered
  if (!employerReviewEnabled()) return off(); // disabled: absent for everyone, before any sign-in or role check
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const body = ShareSelection.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check your selection.", fieldErrors(body.error));
  if (!(await allow("employer-preview-worker", ctx.worker.id, 600, 60))) return apiError("rate_limited", "Too many previews. Please wait a few minutes.");
  try {
    const candidates = await loadCandidates(ctx.worker.id);
    if (!candidates) return apiError("internal", "Couldn't load your records.");
    return ok({ packet: buildPacket(candidates, body.data, new Date()) });
  } catch (e) {
    if (e instanceof PacketSelectionError) return apiError("validation_failed", SELECTION_MESSAGE[e.reason]);
    logSignoffError("employer-preview", e);
    return apiError("internal", "Couldn't build the preview.");
  }
}

export const POST = guarded(handlePOST);
