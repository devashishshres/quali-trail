import type { ReviewStatus, WorkerReview } from "@/lib/types";
import { formatDate } from "./labels";

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "Awaiting supervisor",
  confirmed_observed: "Supervisor confirmed observing these tasks",
  confirmed_documents: "Supervisor reviewed supporting documentation",
  correction_requested: "Supervisor requested a correction",
  declined: "Supervisor could not confirm",
  revoked: "Withdrawn",
  superseded: "Replaced: the record changed",
  expired: "Expired",
};

export interface ReviewLabel {
  short: string;
  long: string;
  tone: "neutral" | "good" | "warn" | "simulated";
}

const who = (r: WorkerReview) =>
  [r.reviewerName, r.reviewerTitle, r.reviewerOrganization].filter(Boolean).join(", ") || "The supervisor";

/**
 * The ONLY place supervisor review wording is produced. Observation and document review are kept distinct,
 * and neither is described as certification, credential verification or independent confirmation.
 */
export function reviewLabel(r: WorkerReview, currentVersion: number): ReviewLabel {
  const changed = r.evidenceVersion !== currentVersion;
  const when = formatDate(r.decidedAt?.slice(0, 10) ?? null);
  const self = "Reviewer details are as they entered them and are not verified. This is not certification or credential verification.";
  let out: ReviewLabel;
  if (r.status === "confirmed_observed") {
    out = { short: "Supervisor confirmed observing these tasks", long: `${who(r)} confirmed on ${when} that they personally observed: ${r.observedTasks.join("; ")}. ${self}`, tone: "good" };
  } else if (r.status === "confirmed_documents") {
    out = { short: "Supervisor reviewed supporting documentation", long: `${who(r)} confirmed on ${when} that they reviewed the supporting document. They did not state that they observed the work, and did not confirm the document is authentic. ${self}`, tone: "good" };
  } else {
    return { short: REVIEW_STATUS_LABEL[r.status], long: REVIEW_STATUS_LABEL[r.status] + (r.supervisorName ? ` (${r.supervisorName})` : ""), tone: r.status === "pending" ? "neutral" : "warn" };
  }
  return changed
    ? { short: "Changed since review", long: `${out.long} The record has changed since then, so this review applies to an earlier version.`, tone: "warn" }
    : out;
}
