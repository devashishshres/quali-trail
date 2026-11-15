import { z } from "zod";
import { getAccount } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { rpc } from "@/lib/server/signoff/service";

/**
 * POST /api/supervisors/:id/revoke — either side ends the relationship (or the worker cancels an invitation).
 * Pending reviews close; completed reviews are kept. Works even with the feature flag off, so access can
 * always be withdrawn.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await getAccount();
  if (!a) return apiError("unauthorized", "Sign in first.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid id.");
  const r = await rpc("sup_relationship_revoke", { p_auth: a.user.id, p_relationship: id.data });
  if (!r.ok) return apiError(r.reason === "not_found" ? "not_found" : "validation_failed", "This relationship is already closed.");
  return ok({ revoked: true, closedReviews: r.closedReviews });
}
