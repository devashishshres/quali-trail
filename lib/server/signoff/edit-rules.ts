import type { EvidenceType, VerificationStatus } from "@/lib/types";

/** Phase 1 limits: only work records and checklists, and never a record a human independently confirmed. */
export const SIGNOFF_TYPES: readonly EvidenceType[] = ["work_record", "checklist"];
export const EDITABLE_STATUSES: readonly VerificationStatus[] = ["self_reported", "document_supplied"];

export type EditProblem = "unsupported_type" | "type_change" | "not_editable";

export function editProblem(
  current: { type: EvidenceType; verificationStatus: VerificationStatus },
  nextType: EvidenceType,
): EditProblem | null {
  if (!SIGNOFF_TYPES.includes(current.type)) return "unsupported_type";
  if (nextType !== current.type) return "type_change";
  if (!EDITABLE_STATUSES.includes(current.verificationStatus)) return "not_editable";
  return null;
}

export const EDIT_PROBLEM_MESSAGE: Record<EditProblem, string> = {
  unsupported_type: "Only work records and checklists can be edited in this version.",
  type_change: "The record type can't be changed.",
  not_editable: "A record that is pending review, independently confirmed, or expired can't be edited here.",
};
