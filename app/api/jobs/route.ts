import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { hashText } from "@/lib/server/evidence/hash";
import { indexEvidence } from "@/lib/server/memory/indexing";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import { LogJobRequest, type ConfirmEvidenceResponse } from "@/lib/types";

/**
 * POST /api/jobs — log a completed job the worker describes themselves (no supporting document).
 * Saved as an ordinary work record/checklist: self-reported, indexed into memory, matched like any record.
 * (A job WITH a supporting document goes through the existing upload -> review -> confirm path instead.)
 */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to log a job.");
  const body = LogJobRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError("validation_failed", "Check the highlighted fields.", fieldErrors(body.error));
  const j = body.data;
  const structured = { skills: j.skills, activities: j.activities, equipment: j.equipment, expirationDate: null, credentialNumber: null, summary: j.summary };
  const fileHash = hashText(JSON.stringify([j.type, j.title, j.date, j.issuer, structured]));
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("evidence")
      .insert({
        worker_id: ctx.worker.id, // from the session, never the request
        type: j.type,
        title: j.title,
        source_date: j.date,
        issuer: j.issuer,
        structured_data: structured,
        source_kind: "manual_text",
        file_hash: fileHash,
        verification_status: "self_reported", // server-decided; never stronger
        index_status: "pending",
        is_synthetic: ctx.worker.is_synthetic,
      })
      .select(EVIDENCE_COLUMNS)
      .single<EvidenceRow>();
    if (error?.code === "23505") return apiError("duplicate_evidence", "You've already logged this exact job.");
    if (error || !data) throw new Error(`job insert failed (${error?.code})`);
    await indexEvidence(admin, toEvidence(data));
    const { data: fresh } = await ctx.supabase.from("evidence").select(EVIDENCE_COLUMNS).eq("id", data.id).eq("worker_id", ctx.worker.id).maybeSingle<EvidenceRow>();
    return ok<ConfirmEvidenceResponse>({ evidence: toEvidence(fresh ?? data) }, 201);
  } catch (e) {
    console.error("POST /api/jobs failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Couldn't save this job. Please try again.");
  }
}
