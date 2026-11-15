import type { EvidenceAssessment, EvidenceType, MemoryIndexStatus, RequirementPriority, VerificationStatus } from "@/lib/types";

/** Documentation relevance. Never implies verification. */
export const ASSESSMENT_LABEL: Record<EvidenceAssessment, string> = {
  evidence_found: "Evidence found",
  needs_review: "Needs review",
  no_sufficient_evidence: "No sufficient evidence found",
  cannot_assess: "Can't assess automatically",
};

/** Short note for `cannot_assess`. It is about QualiTrail's limits, never about the person. */
export const CANNOT_ASSESS_NOTE = "QualiTrail can't judge this from records. It says nothing about whether you meet it.";

/** Independent confirmation. Only a human can produce `independently_confirmed`. */
export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  self_reported: "Self-reported",
  document_supplied: "Document supplied",
  pending_review: "Pending independent review",
  independently_confirmed: "Independently confirmed",
  expired_or_invalid: "Expired or invalid",
};

export const INDEX_LABEL: Record<MemoryIndexStatus, string> = {
  pending: "Waiting to index",
  processing: "Indexing in memory…",
  indexed: "Searchable in memory",
  failed: "Indexing failed",
};

export const TYPE_LABEL: Record<EvidenceType, string> = {
  certification: "Certification",
  training: "Training",
  work_record: "Work record",
  checklist: "Checklist",
  experience_note: "Experience note",
  other: "Other",
};

export const NO_EVIDENCE_NOTE = "No evidence found does not mean the skill is missing.";

// Dates are calendar dates (YYYY-MM-DD); format in UTC so they never shift a day.
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });
const LONG = fmt({ year: "numeric", month: "short", day: "numeric" });
const MONTH = fmt({ year: "numeric", month: "long" });
const STAMP = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export const formatDate = (iso: string | null) => (iso ? LONG.format(new Date(iso)) : "Date not stated");
export const formatMonth = (iso: string | null) => (iso ? MONTH.format(new Date(iso)) : "Date not stated");
export const formatStamp = (iso: string) => STAMP.format(new Date(iso));

export const PRIORITY_LABEL: Record<RequirementPriority, string> = {
  required: "Required",
  preferred: "Preferred",
  unspecified: "Priority not stated",
};

/** Shown with every fit summary. No scores, no probabilities, no hiring prediction. */
export const FIT_NOTE =
  "This compares the job's stated requirements with the records you've saved. Missing documentation is not missing ability, and this is not a prediction of whether you'd be hired.";
