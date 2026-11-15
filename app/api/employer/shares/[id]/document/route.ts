import { z } from "zod";
import { getAccount } from "@/lib/api/auth";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { allow, guarded, json, off, rpcValue, tooMany } from "@/lib/server/signoff/service";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/employer/shares/:id/document?record=… — a 60-second link to an original the technician explicitly shared
 * in this packet, while the share is active and the record is still the shared version. The link is returned to
 * the caller only; it is never logged or stored.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!employerReviewEnabled()) return off();
  const a = await getAccount();
  if (!a || !a.user.emailConfirmed) return json({ error: { code: "unauthorized", message: "Sign in with a confirmed email address." } }, 401);
  const id = z.uuid().safeParse((await params).id);
  const record = z.uuid().safeParse(new URL(request.url).searchParams.get("record"));
  if (!id.success || !record.success) return off();
  if (!(await allow("employer-doc-user", a.user.id, 600, 30))) return tooMany();
  const path = await rpcValue<string | null>("employer_share_document_path", { p_auth: a.user.id, p_share: id.data, p_record: record.data });
  if (!path) return json({ error: { code: "not_found", message: "This document isn't available." } }, 404);
  const { data, error } = await createAdminClient().storage.from("evidence").createSignedUrl(path, 60);
  if (error || !data) return json({ error: { code: "internal", message: "The document couldn't be opened. Please try again." } }, 500);
  return json({ url: data.signedUrl });
}

export const GET = guarded(handleGET);
