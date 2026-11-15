import "server-only";
import { hmac } from "@/lib/server/signoff/crypto";
import { rpcValue } from "@/lib/server/signoff/service";
import { employerReviewEnabled } from "./flags";
import type { Candidates } from "./packet";

/** Does this address hold an open employer share? Used ONLY to let it register an account; never for any role. */
export async function hasPendingEmployerShare(email: string): Promise<boolean> {
  if (!employerReviewEnabled()) return false;
  return (await rpcValue<boolean>("account_has_pending_employer_share", { p_email_hash: hmac("email", email.trim().toLowerCase()) })) === true;
}

/** This worker's shareable items, from the database's eligibility rules. Null if the worker doesn't exist. */
export async function loadCandidates(workerId: string): Promise<Candidates | null> {
  const c = await rpcValue<Candidates | null>("employer_share_candidates", { p_worker: workerId });
  if (c === null || typeof c !== "object") return null;
  return c;
}

export const SHARE_REASON: Record<string, string> = {
  own_email: "Share with someone else: this is your own address.",
  suppressed: "This address has opted out or can't receive email.",
  limit: "You've shared a lot today. Try again tomorrow.",
  changed: "One of the items changed while you were sharing. Preview again and resend.",
  not_eligible: "One of the selected items can't be shared. Preview again.",
  no_original: "Only certificate originals can be shared.",
  not_found: "One of the selected items isn't available.",
  invalid: "The selection didn't match the preview. Preview again and resend.",
};

export const SELECTION_MESSAGE: Record<string, string> = {
  no_items: "Select at least one confirmed job or certification.",
  not_eligible: "Only work with a confirmation that may be shared, and uploaded certifications, can be included.",
  no_original: "An original can only be shared for a selected certification.",
};
