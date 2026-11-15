import type { AttestationSummary, WorkerReview, WorkerSignoff } from "@/lib/types";
import { signoffLabel, type SignoffLabel } from "./signoff-labels";
import { reviewLabel } from "./review-labels";

const DECIDED_CUSTOMER = new Set(["acknowledged", "correction_requested", "declined"]);
const DECIDED_SUPERVISOR = new Set(["confirmed_observed", "confirmed_documents", "correction_requested", "declined"]);

type C = AttestationSummary["customer"][number];
type S = AttestationSummary["supervisor"][number];

const asSignoff = (c: C) => ({ ...c, emailHint: null, typedName: null, comment: null }) as unknown as WorkerSignoff;
const asReview = (s: S) => ({ ...s, supervisorName: s.reviewerName, comment: null }) as unknown as WorkerReview;

export interface AttestationTag extends SignoffLabel {
  kind: "customer" | "supervisor";
  id: string;
}

/**
 * Labels for one record. `completedOnly` (the packet) keeps only recorded decisions; the evidence list also
 * shows what is still awaiting a response. Wording comes from signoffLabel/reviewLabel only.
 */
export function attestationTags(a: AttestationSummary | undefined, currentVersion: number, completedOnly = false): AttestationTag[] {
  if (!a) return [];
  const customer = a.customer.filter((c) => DECIDED_CUSTOMER.has(c.status) || (!completedOnly && c.status === "pending"));
  const supervisor = a.supervisor.filter((s) => DECIDED_SUPERVISOR.has(s.status) || (!completedOnly && s.status === "pending"));
  return [
    ...customer.map((c) => ({ kind: "customer" as const, id: c.id, ...signoffLabel(asSignoff(c), currentVersion) })),
    ...supervisor.map((s) => ({ kind: "supervisor" as const, id: s.id, ...reviewLabel(asReview(s), currentVersion) })),
  ];
}
