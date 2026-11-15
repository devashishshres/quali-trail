/** Employer review portal. OFF unless explicitly "true"; when off, every employer route behaves as if absent. */
export const employerReviewEnabled = (env: NodeJS.ProcessEnv = process.env) => env.EMPLOYER_REVIEW_ENABLED === "true";

/** Version of the wording a supervisor agrees to when allowing external sharing of a confirmation. */
export const SHARE_CONSENT_VERSION = "supervisor-employer-share-v2";

export const SHARE_CONSENT_TEXT = {
  share:
    "The technician may include this confirmation in records they choose to share with prospective employers. Without this, it is never shared outside QualiTrail.",
  name: "Also show my name, organization and title with it. Without this, employers are told the supervisor didn't permit their name to be shared.",
} as const;
