import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { featureOn, rpc } from "@/lib/server/signoff/service";

/** POST /api/signoff/requests/:id/revoke — only an open request can be revoked; a recorded decision stays. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!featureOn()) return apiError("not_found", "Customer sign-off isn't available.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid request id.");
  const r = await rpc("signoff_revoke_request", { p_worker: ctx.worker.id, p_request: id.data });
  if (!r.ok) return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", "Only an open request can be revoked.");
  return ok({ revoked: true });
}
