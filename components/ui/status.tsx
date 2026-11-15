import type { EvidenceAssessment, MemoryIndexStatus, VerificationStatus } from "@/lib/types";
import { ASSESSMENT_LABEL, INDEX_LABEL, VERIFICATION_LABEL } from "@/lib/client/labels";
import { Icon, type IconName } from "./icons";

/*
 * Two visual systems that must never be confused:
 *  - Assessment (relevance): a filled/half/hollow disc + coloured label.
 *  - Verification (authenticity): a neutral tag with an icon. Only a
 *    human-confirmed record gets the seal and teal colour.
 */

const ASSESSMENT_TONE: Record<EvidenceAssessment, { text: string; fill: string }> = {
  evidence_found: { text: "text-teal-ink", fill: "var(--color-teal)" },
  needs_review: { text: "text-orange-ink", fill: "var(--color-orange)" },
  no_sufficient_evidence: { text: "text-slate", fill: "var(--color-slate)" },
};

export function AssessmentDisc({ assessment, className = "size-3.5" }: { assessment: EvidenceAssessment; className?: string }) {
  const { fill } = ASSESSMENT_TONE[assessment];
  return (
    <svg viewBox="0 0 16 16" className={`${className} shrink-0`} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={fill} strokeWidth="2" />
      {assessment === "evidence_found" && <circle cx="8" cy="8" r="4" fill={fill} />}
      {assessment === "needs_review" && <path d="M8 4a4 4 0 0 1 0 8z" fill={fill} />}
    </svg>
  );
}

export function AssessmentLabel({ assessment }: { assessment: EvidenceAssessment }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold ${ASSESSMENT_TONE[assessment].text}`}>
      <AssessmentDisc assessment={assessment} />
      {ASSESSMENT_LABEL[assessment]}
    </span>
  );
}

const VERIFICATION_ICON: Record<VerificationStatus, IconName> = {
  self_reported: "pen",
  document_supplied: "doc",
  pending_review: "clock",
  independently_confirmed: "seal",
  expired_or_invalid: "alert",
};

export function VerificationTag({ status }: { status: VerificationStatus }) {
  const tone =
    status === "independently_confirmed"
      ? "border-teal text-teal-ink bg-teal-wash"
      : status === "expired_or_invalid"
        ? "border-danger/40 text-danger bg-danger-wash"
        : "border-line text-slate bg-white";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      <Icon name={VERIFICATION_ICON[status]} className="size-3.5" />
      {VERIFICATION_LABEL[status]}
    </span>
  );
}

export function IndexStatus({ status }: { status: MemoryIndexStatus }) {
  const tone = { pending: "text-slate", processing: "text-orange-ink", indexed: "text-teal-ink", failed: "text-danger" }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`} role="status">
      <span
        className={`size-2 rounded-full bg-current ${status === "processing" ? "animate-pulse" : ""} ${status === "pending" ? "bg-transparent ring-1 ring-current" : ""}`}
        aria-hidden="true"
      />
      {INDEX_LABEL[status]}
    </span>
  );
}

export function FictionalTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-navy px-1.5 py-0.5 text-[11px] font-semibold text-white">
      <span className="hazard size-2 rounded-[1px]" aria-hidden="true" />
      Fictional demo data
    </span>
  );
}

/** Customer sign-off state. Deliberately not styled like "Independently confirmed". */
export function SignoffTag({ short, tone }: { short: string; tone: "neutral" | "good" | "warn" | "simulated" }) {
  const cls =
    tone === "simulated"
      ? "border-dashed border-orange text-orange-ink bg-orange-wash"
      : tone === "warn"
        ? "border-orange/50 text-orange-ink bg-white"
        : "border-line text-slate bg-white";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      <Icon name="pen" className="size-3.5" />
      {short}
    </span>
  );
}
