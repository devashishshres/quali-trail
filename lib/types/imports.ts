/**
 * Job-import contracts (feature flag OPPORTUNITY_IMPORT_ENABLED). The draft is stored on the server and edited
 * there; the browser never holds the only copy. The employer's original wording is never editable.
 */
import { z } from "zod";
import { RequirementPriority, ReviewReason } from "./contracts";

export const ImportLine = z.object({
  /** Stable key within the draft. */
  key: z.string().min(1).max(40),
  /** Exact wording from the listing. Never edited; every rule is built from this. */
  originalText: z.string().min(1).max(1000),
  /** Surrounding listing text, for the technician's reference. */
  sourceExcerpt: z.string().max(2000).nullable(),
  /** Priority as the listing stated it (from its section heading or wording). */
  originalPriority: RequirementPriority,
  /** Priority used for the fit summary; the technician may change it, and the report shows both. */
  priority: RequirementPriority,
  category: z.string().max(60).nullable(),
  /** Cosmetic rewording for display only. Labelled wherever shown; never used for matching. */
  displayText: z.string().trim().min(1).max(1000).nullable(),
  /** Removed lines are not compared; the number removed is disclosed on the job and report. */
  removed: z.boolean(),
  /** Forces "can't assess automatically". */
  manualReview: z.boolean(),
});
export type ImportLine = z.infer<typeof ImportLine>;

export const ImportDraft = z.object({
  title: z.string().trim().min(1).max(300),
  employer: z.string().trim().min(1).max(300),
  location: z.string().trim().max(300).nullable(),
  description: z.string().max(10000),
  lines: z.array(ImportLine).max(40),
  /** Lines the model proposed that were not found word-for-word in the listing, so were left out. */
  failedLines: z.number().int().nonnegative(),
  /** The model reported the listing looked incomplete. */
  modelIncomplete: z.boolean(),
});
export type ImportDraft = z.infer<typeof ImportDraft>;

/** How a line will be assessed, computed on the server from its ORIGINAL wording. */
export const LineAssessmentPreview = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supported"), conditions: z.array(z.string()) }),
  z.object({ kind: z.literal("review_only"), reasons: z.array(ReviewReason), reasonText: z.array(z.string()) }),
]);
export type LineAssessmentPreview = z.infer<typeof LineAssessmentPreview>;

export const ImportStatus = z.enum(["fetching", "fetched", "drafting", "drafted", "confirmed", "failed", "expired"]);
export type ImportStatus = z.infer<typeof ImportStatus>;

export const ImportView = z.object({
  id: z.string(),
  status: ImportStatus,
  sourceKind: z.enum(["listing_url", "pasted_text"]),
  submittedUrl: z.string().nullable(),
  finalUrl: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  /** Completeness warnings. Confirming requires acknowledging them. */
  warnings: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  version: z.number().int(),
  draft: ImportDraft.nullable(),
  previews: z.record(z.string(), LineAssessmentPreview),
  expiresAt: z.string(),
  opportunityId: z.string().nullable(),
});
export type ImportView = z.infer<typeof ImportView>;

export const StartImportRequest = z.union([
  z.object({ url: z.string().trim().min(1).max(2048) }),
  z.object({ text: z.string().trim().min(40).max(30000) }),
]);
export type StartImportRequest = z.infer<typeof StartImportRequest>;

export const SaveImportReviewRequest = z.object({
  version: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(300),
  employer: z.string().trim().min(1).max(300),
  location: z.string().trim().max(300).nullable(),
  lines: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        priority: RequirementPriority,
        displayText: z.string().trim().max(1000).nullable(),
        removed: z.boolean(),
        manualReview: z.boolean(),
      }),
    )
    .max(40),
});
export type SaveImportReviewRequest = z.infer<typeof SaveImportReviewRequest>;

export const ConfirmImportRequest = z.object({
  version: z.number().int().nonnegative(),
  /** Required (true) whenever the draft carries completeness warnings. */
  acknowledgeWarnings: z.boolean(),
});
export type ConfirmImportRequest = z.infer<typeof ConfirmImportRequest>;

export const ConfirmImportResponse = z.object({ opportunityId: z.string(), repeated: z.boolean() });
export type ConfirmImportResponse = z.infer<typeof ConfirmImportResponse>;
