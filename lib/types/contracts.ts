/**
 * QualiTrail shared contracts — the single source of truth for
 * frontend (Developer A) and backend (Developer B).
 *
 * Rule: every type is derived from a Zod schema with `z.infer`, so the
 * runtime validator and the TypeScript type can never drift apart.
 *
 * Owner: Developer B. Breaking changes must be announced before merging.
 */
import { z } from "zod";
import { RunExplanations } from "./explanations";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

/**
 * Independent confirmation of a record. Describes AUTHENTICITY only —
 * never relevance. Only a human reviewer (via a verification_event) can
 * produce `independently_confirmed`; the database enforces this.
 */
export const VerificationStatus = z.enum([
  "self_reported", // typed in by the worker, no document
  "document_supplied", // worker uploaded a document, not checked
  "pending_review", // submitted to a reviewer, no decision yet
  "independently_confirmed", // reviewer/issuer confirmed (human only)
  "expired_or_invalid", // explicit expiry passed or reviewer rejected
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** Documentation RELEVANCE for one requirement. Never implies verification. */
export const EvidenceAssessment = z.enum([
  "evidence_found",
  "needs_review",
  "no_sufficient_evidence",
  /**
   * QualiTrail cannot judge this requirement from records automatically (for example a driving licence,
   * work authorization, a duration, or wording outside its supported rules). Says nothing about the person.
   */
  "cannot_assess",
]);
export type EvidenceAssessment = z.infer<typeof EvidenceAssessment>;

/** Supermemory indexing lifecycle, as shown in the UI. */
export const MemoryIndexStatus = z.enum([
  "pending", // saved in Postgres, not yet sent to Supermemory
  "processing", // Supermemory accepted it, still processing
  "indexed", // Supermemory reported `done`
  "failed", // send or processing failed — retryable
]);
export type MemoryIndexStatus = z.infer<typeof MemoryIndexStatus>;

export const EvidenceType = z.enum([
  "certification", // e.g. EPA Section 608 card
  "training", // e.g. manufacturer training certificate
  "work_record", // e.g. work order, startup record
  "checklist", // e.g. commissioning checklist
  "experience_note", // free-text description from the worker
  "other",
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/** Where a record came from. `seed` = fictional demo data. */
export const EvidenceSourceKind = z.enum(["pdf_upload", "manual_text", "seed"]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKind>;

export const MatchRunStatus = z.enum(["processing", "completed", "failed", "stale"]);
export type MatchRunStatus = z.infer<typeof MatchRunStatus>;

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

const Id = z.uuid();
/** Calendar date, `YYYY-MM-DD`. */
const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });
const ShortText = z.string().trim().min(1).max(300);

/** Machine-readable error body returned by every route on failure. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      "unauthorized",
      "forbidden",
      "not_found",
      "validation_failed",
      "unsupported_file",
      "file_too_large",
      "duplicate_evidence",
      "extraction_failed",
      "memory_unavailable",
      "rate_limited",
      "onboarding_required",
      /** Setup on the server is incomplete (for example the rate limiter isn't installed). Not the caller's fault. */
      "unavailable",
      "internal",
    ]),
    message: z.string(),
    /** Present on validation_failed: field path -> messages. */
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/* ------------------------------------------------------------------ */
/* Workers                                                             */
/* ------------------------------------------------------------------ */

export const Worker = z.object({
  id: Id,
  name: ShortText,
  trade: ShortText,
  /** Worker-authored career summary. Null until one is set (older rows and records stay valid). */
  summary: z.string().max(1000).nullable().default(null),
  isSynthetic: z.boolean(),
});
export type Worker = z.infer<typeof Worker>;

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/** Details that vary by document. Stored as JSONB in `evidence.structured_data`. */
export const StructuredEvidenceData = z.object({
  skills: z.array(ShortText).max(30).default([]),
  activities: z.array(ShortText).max(30).default([]),
  equipment: z.array(ShortText).max(30).default([]),
  /** Only set when the document itself states an expiry. Never guessed. */
  expirationDate: IsoDate.nullable().default(null),
  /** Credential/certificate number as printed, if any. */
  credentialNumber: z.string().max(100).nullable().default(null),
  summary: z.string().max(2000).nullable().default(null),
});
export type StructuredEvidenceData = z.infer<typeof StructuredEvidenceData>;

export const Evidence = z.object({
  id: Id,
  workerId: Id,
  type: EvidenceType,
  title: ShortText,
  /** Date of the work/issue, `YYYY-MM-DD`. Null when the source does not state it. */
  date: IsoDate.nullable(),
  issuer: z.string().max(300).nullable(),
  structuredData: StructuredEvidenceData,
  sourceKind: EvidenceSourceKind,
  /** True when an original file exists in private storage. */
  sourceAvailable: z.boolean(),
  verificationStatus: VerificationStatus,
  indexStatus: MemoryIndexStatus,
  /** Last indexing error shown to the user, if indexStatus is `failed`. */
  indexError: z.string().nullable(),
  /** Fictional demo record. UI must label these. */
  isSynthetic: z.boolean(),
  version: z.number().int().positive(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * What Gemini proposes. Every field may be null — the model must not
 * invent missing values. `uncertainFields` lists fields the UI should
 * highlight for the worker to check.
 */
export const ExtractedEvidence = z.object({
  type: EvidenceType.nullable(),
  title: z.string().max(300).nullable(),
  date: IsoDate.nullable(),
  issuer: z.string().max(300).nullable(),
  structuredData: StructuredEvidenceData,
  uncertainFields: z
    .array(z.enum(["type", "title", "date", "issuer", "expirationDate", "credentialNumber"]))
    .default([]),
});
export type ExtractedEvidence = z.infer<typeof ExtractedEvidence>;

export const EvidenceDraft = z.object({
  draftId: Id,
  sourceKind: z.enum(["pdf_upload", "manual_text"]),
  fileName: z.string().nullable(),
  extraction: ExtractedEvidence.nullable(),
  /** Set when Gemini failed. The worker can still fill the form by hand. */
  extractionError: z.string().nullable(),
  /** Id of an existing record with the same content hash, if any. */
  duplicateOfEvidenceId: Id.nullable(),
  createdAt: IsoDateTime,
});
export type EvidenceDraft = z.infer<typeof EvidenceDraft>;

/** Fields the worker confirms. Note: no verificationStatus — the server decides. */
export const ConfirmedEvidenceFields = z.object({
  type: EvidenceType,
  title: ShortText,
  date: IsoDate.nullable(),
  issuer: z.string().trim().max(300).nullable(),
  structuredData: StructuredEvidenceData,
});
export type ConfirmedEvidenceFields = z.infer<typeof ConfirmedEvidenceFields>;

/* ------------------------------------------------------------------ */
/* Opportunities & requirements                                        */
/* ------------------------------------------------------------------ */

/**
 * Deterministic rules the matcher checks AFTER memory retrieval.
 * Supermemory finds candidates; these criteria decide what counts.
 */
export const RequirementCriteria = z.object({
  /** Evidence types that can directly satisfy this requirement. */
  acceptedTypes: z.array(EvidenceType).min(1),
  /** Types that may only contribute partial/related evidence. */
  supportingTypes: z.array(EvidenceType).default([]),
  /** At least one keyword must appear in the record's text fields. */
  keywords: z.array(ShortText).min(1),
  /** Query sent to Supermemory for this requirement. */
  retrievalQuery: ShortText,
  /** Fields a directly-satisfying record must have filled in. */
  requiredFields: z.array(z.enum(["date", "issuer"])).default([]),
  /**
   * Imported jobs only. Absent on seeded and sample requirements, which therefore evaluate exactly as before.
   * Built deterministically from the employer's ORIGINAL wording (never from model output or display edits).
   */
  rule: z.lazy(() => RequirementRule).optional(),
});
export type RequirementCriteria = z.infer<typeof RequirementCriteria>;

/** One condition of a supported rule. Every condition must be met (all-of). */
export const RuleCondition = z.object({
  /** Catalog entry id, e.g. "epa608_type2". */
  id: z.string().min(1).max(60),
  /** Plain-language name of the condition, shown in explanations. */
  label: ShortText,
  acceptedTypes: z.array(EvidenceType).min(1),
  supportingTypes: z.array(EvidenceType).default([]),
  keywords: z.array(ShortText).min(1),
  /**
   * Scope terms the record must state. Each inner list is one group; every group needs at least one term present
   * in the record's title, skills or activities. A record missing a group is "incomplete", never a direct match.
   */
  termGroups: z.array(z.array(ShortText).min(1)).default([]),
  requiredFields: z.array(z.enum(["date", "issuer"])).default([]),
  retrievalQuery: ShortText,
});
export type RuleCondition = z.infer<typeof RuleCondition>;

export const ReviewReason = z.enum([
  "unsupported_wording", // no catalog rule fully covers the wording
  "alternatives", // "or", "/", "equivalent": QualiTrail does not pick between alternatives
  "negation",
  "duration", // years / months of experience
  "driving", // licence, driving record, vehicle
  "work_authorization",
  "physical",
  "background_check",
  "education",
  "schedule",
  "marked_by_technician", // the technician chose "mark for manual review"
]);
export type ReviewReason = z.infer<typeof ReviewReason>;

export const RequirementRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supported"), conditions: z.array(RuleCondition).min(1).max(4) }),
  z.object({
    kind: z.literal("review_only"),
    reasons: z.array(ReviewReason).min(1),
    /** Conditions recognised in part of the wording; used ONLY to show related records, never to decide. */
    partial: z.array(RuleCondition).max(4).default([]),
  }),
]);
export type RequirementRule = z.infer<typeof RequirementRule>;

export const RequirementPriority = z.enum(["required", "preferred", "unspecified"]);
export type RequirementPriority = z.infer<typeof RequirementPriority>;

export const Requirement = z.object({
  id: Id,
  opportunityId: Id,
  position: z.number().int().nonnegative(),
  /** Exact wording from the job posting. Never rewritten. */
  originalText: z.string().min(1).max(1000),
  mandatory: z.boolean(),
  criteria: RequirementCriteria,
  /** Where the wording came from, e.g. "Demo job posting (fictional)". */
  source: ShortText,
  /** Imported jobs: priority as used now, and as the posting stated it. Seeded rows: null. */
  priority: RequirementPriority.nullable().optional(),
  originalPriority: RequirementPriority.nullable().optional(),
  /** Technician's cosmetic rewording for display. Never used for matching; null when unchanged. */
  displayText: z.string().max(1000).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const Opportunity = z.object({
  id: Id,
  title: ShortText,
  employer: ShortText,
  description: z.string().max(10000),
  sourceUrl: z.url().nullable(),
  isSynthetic: z.boolean(),
  requirements: z.array(Requirement),
  /** Imported jobs only (null otherwise). */
  importInfo: z
    .object({
      importId: Id,
      /** "listing_url" = retrieved from the public posting; "pasted_text" = supplied by the technician. */
      sourceKind: z.enum(["listing_url", "pasted_text"]),
      location: z.string().max(300).nullable(),
      retrievedAt: IsoDateTime.nullable(),
      finalUrl: z.string().max(2048).nullable(),
      /** Completeness warnings the technician acknowledged when confirming. */
      warnings: z.array(z.string().max(500)),
      /** Requirement lines the technician removed before confirming (count only). */
      removedCount: z.number().int().nonnegative(),
      /** Lines whose display wording the technician edited (cosmetic). */
      editedCount: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type Opportunity = z.infer<typeof Opportunity>;

/* ------------------------------------------------------------------ */
/* Matching & Evidence Constellation                                   */
/* ------------------------------------------------------------------ */

export const EvidenceRole = z.enum([
  "direct", // can satisfy the requirement on its own
  "supporting", // related, contributes partially
]);
export type EvidenceRole = z.infer<typeof EvidenceRole>;

/** One edge in the Evidence Constellation: requirement <-> evidence record. */
export const EvidenceConnection = z.object({
  evidenceId: Id,
  /** Denormalised for display; always resolved from Postgres, never from memory text. */
  evidenceTitle: ShortText,
  evidenceDate: IsoDate.nullable(),
  evidenceType: EvidenceType,
  /** Issuer as stored on the record (read live, so older saved runs show it too). Not proof of authenticity. */
  evidenceIssuer: ShortText.nullable().default(null),
  verificationStatus: VerificationStatus,
  role: EvidenceRole,
  /** What this record contributes, e.g. "Shows startup testing on a heat pump". */
  contribution: z.string().max(500),
  relevanceExplanation: z.string().max(1000),
  /** Supermemory similarity (0–1) when found via memory search; null otherwise. */
  memorySimilarity: z.number().min(0).max(1).nullable(),
});
export type EvidenceConnection = z.infer<typeof EvidenceConnection>;

export const RequirementResult = z.object({
  requirementId: Id,
  originalText: z.string(),
  mandatory: z.boolean(),
  assessment: EvidenceAssessment,
  connections: z.array(EvidenceConnection),
  /** Why the records may be relevant together (constellation summary). */
  explanation: z.string().max(2000),
  uncertainties: z.array(z.string().max(500)),
  missingDocumentation: z.array(z.string().max(500)),
});
export type RequirementResult = z.infer<typeof RequirementResult>;

export const MatchRun = z.object({
  id: Id,
  workerId: Id,
  opportunityId: Id,
  status: MatchRunStatus,
  /** Worker's evidence revision when this run was computed. */
  evidenceRevision: z.number().int().nonnegative(),
  /** Honest note when memory search was partial/unavailable. Null when fine. */
  memoryWarning: z.string().nullable(),
  results: z.array(RequirementResult),
  createdAt: IsoDateTime,
});
export type MatchRun = z.infer<typeof MatchRun>;

/** Before/after comparison for one requirement. */
export const RequirementChange = z.object({
  requirementId: Id,
  before: EvidenceAssessment,
  after: EvidenceAssessment,
  addedEvidenceIds: z.array(Id),
});
export type RequirementChange = z.infer<typeof RequirementChange>;

/* ------------------------------------------------------------------ */
/* API request / response bodies                                       */
/* ------------------------------------------------------------------ */

/** GET /api/evidence */
export const ListEvidenceResponse = z.object({
  worker: Worker,
  evidence: z.array(Evidence),
});
export type ListEvidenceResponse = z.infer<typeof ListEvidenceResponse>;

/**
 * POST /api/evidence/extract
 * Either multipart/form-data with `file` (PDF), or JSON with `text`.
 * This schema validates the JSON variant.
 */
export const ExtractTextRequest = z.object({
  text: z.string().trim().min(20).max(10000),
});
export type ExtractTextRequest = z.infer<typeof ExtractTextRequest>;

export const ExtractResponse = z.object({ draft: EvidenceDraft });
export type ExtractResponse = z.infer<typeof ExtractResponse>;

/** POST /api/evidence/confirm */
export const ConfirmEvidenceRequest = z.object({
  draftId: Id,
  fields: ConfirmedEvidenceFields,
});
export type ConfirmEvidenceRequest = z.infer<typeof ConfirmEvidenceRequest>;

export const ConfirmEvidenceResponse = z.object({ evidence: Evidence });
export type ConfirmEvidenceResponse = z.infer<typeof ConfirmEvidenceResponse>;

/** GET /api/evidence/:id */
export const GetEvidenceResponse = z.object({
  evidence: Evidence,
  /** Short-lived signed URL (60 s). Null when no original file exists. Never cache or print it. */
  documentUrl: z.url().nullable(),
});
export type GetEvidenceResponse = z.infer<typeof GetEvidenceResponse>;

/** POST /api/evidence/:id/reindex — retry a failed Supermemory index. */
export const ReindexResponse = z.object({ evidence: Evidence });
export type ReindexResponse = z.infer<typeof ReindexResponse>;

/** GET /api/opportunities */
export const ListOpportunitiesResponse = z.object({
  opportunities: z.array(Opportunity),
});
export type ListOpportunitiesResponse = z.infer<typeof ListOpportunitiesResponse>;

/** POST /api/matches/run */
export const RunMatchRequest = z.object({ opportunityId: Id });
export type RunMatchRequest = z.infer<typeof RunMatchRequest>;

/** GET /api/matches/:id and POST /api/matches/run */
export const MatchRunResponse = z.object({
  matchRun: MatchRun,
  /** Most recent earlier run for the same opportunity, for before/after. */
  previousRunId: Id.nullable(),
  /** Empty when there is no previous run. */
  changes: z.array(RequirementChange),
  /** "Related evidence — AI-assisted explanation" for this run, if generated. Never part of the assessment. */
  explanations: RunExplanations.nullable().optional(),
});
export type MatchRunResponse = z.infer<typeof MatchRunResponse>;

/** GET /api/matches/latest?opportunityId=… — what the Reports page reads. */
export const LatestMatchQuery = z.object({ opportunityId: Id });
export type LatestMatchQuery = z.infer<typeof LatestMatchQuery>;

/* ------------------------------------------------------------------ */
/* Upload limits (shared so the UI can pre-validate)                   */
/* ------------------------------------------------------------------ */

export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // 10 MB
  acceptedMimeTypes: ["application/pdf"] as const,
} as const;

/** Disclaimer required on every report. Use this exact text. */
export const REPORT_DISCLAIMER =
  "This report summarizes available documentation. It does not independently establish certification authenticity, licensing or employer eligibility.";
