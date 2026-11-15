import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { guarded, rpc } from "@/lib/server/signoff/service";
import { SharedPacket } from "@/lib/types/employer";

type Params = { params: Promise<{ id: string }> };

/** GET /api/employer-shares/:id — the technician's own copy of exactly what was shared. Readable even when withdrawn. */
async function handleGET(_request: Request, { params }: Params) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return apiError("not_found", "Not found.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("not_found", "Not found.");
  const r = await rpc("employer_share_worker_get", { p_worker: ctx.worker.id, p_share: id.data });
  if (!r.ok) return apiError("not_found", "Not found.");
  return ok(SharedPacket.parse(r));
}

/** DELETE /api/employer-shares/:id — withdraw access now. The packet record is kept (immutable), unreadable to the reviewer. */
async function handleDELETE(_request: Request, { params }: Params) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!employerReviewEnabled()) return apiError("not_found", "Not found.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("not_found", "Not found.");
  const r = await rpc("employer_share_revoke", { p_worker: ctx.worker.id, p_share: id.data });
  if (!r.ok) return apiError("not_found", "Not found.");
  return ok({ status: r.status });
}

export const GET = guarded(handleGET);
export const DELETE = guarded(handleDELETE);
