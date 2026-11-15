import { randomUUID } from "node:crypto";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, fieldErrors, ok } from "@/lib/api/responses";
import { ExtractionError, extractFromPdf, extractFromText } from "@/lib/server/extraction/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanupAbandonedDrafts } from "@/lib/server/evidence/drafts";
import { hashText, looksLikePdf, sha256 } from "@/lib/server/evidence/hash";
import { EvidenceDraft, ExtractedEvidence, ExtractTextRequest, UPLOAD_LIMITS } from "@/lib/types";

const MANUAL_FALLBACK = "Gemini couldn't read this automatically. You can fill in the details by hand.";

/**
 * POST /api/evidence/extract
 * multipart/form-data `file` (PDF, <= 10 MB) or JSON { text }. Gemini proposes
 * fields; nothing is saved as evidence until the worker confirms.
 */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to add evidence.");
  const { supabase, worker, authUserId } = ctx;

  const contentType = request.headers.get("content-type") ?? "";
  // Reject oversized bodies before buffering them.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > UPLOAD_LIMITS.maxBytes + 64 * 1024) return apiError("file_too_large", "That file is larger than 10 MB.");

  let sourceKind: "pdf_upload" | "manual_text";
  let fileName: string | null = null;
  let bytes: Uint8Array | null = null;
  let text: string | null = null;
  let fileHash: string;

  if (contentType.includes("multipart/form-data")) {
    const file = (await request.formData().catch(() => null))?.get("file");
    if (!(file instanceof File)) return apiError("validation_failed", "Attach a PDF file.");
    if (file.size > UPLOAD_LIMITS.maxBytes) return apiError("file_too_large", "That file is larger than 10 MB.");
    bytes = new Uint8Array(await file.arrayBuffer());
    // Trust the bytes, not the claimed type.
    if (!UPLOAD_LIMITS.acceptedMimeTypes.includes(file.type as "application/pdf") || !looksLikePdf(bytes)) {
      return apiError("unsupported_file", "Only PDF files are supported.");
    }
    sourceKind = "pdf_upload";
    fileName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "document.pdf";
    fileHash = sha256(bytes);
  } else {
    const parsed = ExtractTextRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError("validation_failed", "Describe the work in at least 20 characters (10,000 max).", fieldErrors(parsed.error));
    }
    sourceKind = "manual_text";
    text = parsed.data.text;
    fileHash = hashText(text);
  }

  try {
    const admin = createAdminClient();
    await cleanupAbandonedDrafts(supabase, admin, worker.id, authUserId);

    const { data: dup } = await supabase.from("evidence").select("id").eq("worker_id", worker.id).eq("file_hash", fileHash).maybeSingle();
    const draftId = randomUUID();
    const createdAt = new Date().toISOString();

    if (dup) {
      // Same content already saved: no upload, no model call, nothing persisted.
      return ok({
        draft: EvidenceDraft.parse({ draftId, sourceKind, fileName, extraction: null, extractionError: null, duplicateOfEvidenceId: dup.id, createdAt }),
      });
    }

    let extraction: ExtractedEvidence | null = null;
    let extractionError: string | null = null;
    try {
      extraction = bytes ? await extractFromPdf(bytes) : await extractFromText(text!);
    } catch (e) {
      extractionError = e instanceof ExtractionError ? `${e.message} ${MANUAL_FALLBACK}` : MANUAL_FALLBACK;
      if (text) extraction = ExtractedEvidence.parse({ type: null, title: null, date: null, issuer: null, structuredData: { summary: text.slice(0, 2000) }, uncertainFields: ["type", "title", "date", "issuer"] });
    }

    let storagePath: string | null = null;
    if (bytes) {
      storagePath = `${authUserId}/${draftId}.pdf`;
      const { error } = await supabase.storage.from("evidence").upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
      if (error) {
        console.error("draft upload failed", { message: error.message });
        return apiError("internal", "Could not store the file. Please try again.");
      }
    }

    const { error: insertError } = await admin.from("evidence_drafts").insert({
      id: draftId,
      worker_id: worker.id,
      source_kind: sourceKind,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: bytes ? "application/pdf" : null,
      file_hash: fileHash,
      raw_text: text,
      extraction,
      extraction_error: extractionError,
    });
    if (insertError) {
      if (storagePath) await admin.storage.from("evidence").remove([storagePath]);
      console.error("draft insert failed", { code: insertError.code });
      return apiError("internal", "Could not save the draft. Please try again.");
    }

    return ok({ draft: EvidenceDraft.parse({ draftId, sourceKind, fileName, extraction, extractionError, duplicateOfEvidenceId: null, createdAt }) });
  } catch (e) {
    console.error("POST /api/evidence/extract failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not process that. Please try again.");
  }
}
