import { z } from "zod";
import { getSupervisorContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { DOCUMENTS_STATEMENT, OBSERVED_STATEMENT } from "@/lib/server/accounts/review-text";
import { rpc } from "@/lib/server/signoff/service";

/**
 * GET /api/supervisor/reviews/:id — read only. Visible only to the addressed supervisor while the relationship
 * is accepted. Opening this (or the email link) never records a decision.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSupervisorContext();
  if (!s) return apiError("unauthorized", "Sign in with a confirmed reviewer account.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("not_found", "That review isn't available.");
  const r = await rpc("review_get", { p_auth: s.user.id, p_request: id.data });
  if (!r.ok) return apiError("not_found", "That review isn't available to you.");
  const { ok: _ok, ...review } = r;
  void _ok;
  return ok({ review, statements: { observed: OBSERVED_STATEMENT, documents: DOCUMENTS_STATEMENT } });
}
