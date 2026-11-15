import { z } from "zod";
import { getSupervisorContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { rpcValue } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/supervisor/reviews/:id/document — a 60-second link to the original supporting document, only for
 * the addressed supervisor, only while the request is pending and the record is unchanged since it was sent.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSupervisorContext();
  if (!s) return apiError("unauthorized", "Sign in with a confirmed reviewer account.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("not_found", "Not available.");
  const path = await rpcValue<string | null>("review_document_path", { p_auth: s.user.id, p_request: id.data });
  if (!path) return apiError("not_found", "The document isn't available for this request.");
  const { data, error } = await createAdminClient().storage.from("evidence").createSignedUrl(path, 60);
  if (error || !data) return apiError("internal", "The document couldn't be opened. Please try again.");
  return ok({ url: data.signedUrl });
}
