/** Employer review portal. OFF unless explicitly "true"; when off, every employer route behaves as if absent. */
export const employerReviewEnabled = (env: NodeJS.ProcessEnv = process.env) => env.EMPLOYER_REVIEW_ENABLED === "true";

/** Version of the wording a supervisor agrees to when allowing their name to be shown to employers. */
export const SHARE_CONSENT_VERSION = "supervisor-employer-share-v1";

export const SHARE_CONSENT_TEXT =
  "The technician may show my name, organization and title with this confirmation in packets they choose to share with prospective employers. Without this, employers see the confirmation without my details.";
