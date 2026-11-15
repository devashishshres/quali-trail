import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { rpc } from "@/lib/server/signoff/service";

/** POST /api/reviews/:id/revoke — withdraw a pending review request. Completed reviews cannot be withdrawn. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid id.");
  const r = await rpc("review_revoke", { p_worker: ctx.worker.id, p_request: id.data });
  if (!r.ok) return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", "Only a pending request can be withdrawn.");
  return ok({ revoked: true });
}
