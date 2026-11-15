import type { SignoffStatus, WorkerSignoff } from "@/lib/types";
import { formatDate } from "./labels";

export const SIGNOFF_STATUS_LABEL: Record<SignoffStatus, string> = {
  pending: "Awaiting customer",
  acknowledged: "Customer acknowledged",
  correction_requested: "Correction requested",
  declined: "Declined",
  expired: "Expired",
  revoked: "Cancelled",
  superseded: "Replaced: the record changed",
  locked: "Locked (too many wrong codes)",
};

export interface SignoffLabel {
  /** Short tag text. */
  short: string;
  /** Full sentence. For an acknowledgment, says exactly what was and was not established. */
  long: string;
  tone: "neutral" | "good" | "warn" | "simulated";
}

/**
 * The ONLY place acknowledgment wording is produced. A real acknowledgment requires a code entered after
 * delivery to the address the worker provided; simulated delivery is never described as verification.
 */
export function signoffLabel(s: WorkerSignoff, currentVersion: number): SignoffLabel {
  const changed = s.evidenceVersion !== currentVersion;
  if (s.status === "acknowledged") {
    if (s.deliveryMode === "mock") {
      return { short: "Simulated acknowledgment", long: "Simulated (no real email was sent). This development test is not email verification and not a customer acknowledgment.", tone: "simulated" };
    }
    const base = `Customer acknowledged on ${formatDate(s.decidedAt?.slice(0, 10) ?? null)}. A code sent to the email address the worker provided was entered. Neither the customer's identity nor the work is independently verified.`;
    return changed
      ? { short: "Changed since acknowledged", long: `${base} The record has changed since then, so this no longer describes the current version.`, tone: "warn" }
      : { short: "Customer acknowledged", long: base, tone: "good" };
  }
  const short = SIGNOFF_STATUS_LABEL[s.status];
  const sim = s.deliveryMode === "mock" ? " (simulated; no real email was sent)" : "";
  return { short: short + (s.deliveryMode === "mock" ? " (simulated)" : ""), long: short + sim, tone: s.status === "pending" ? "neutral" : "warn" };
}
