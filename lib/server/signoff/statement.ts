/** Customer-facing wording. Versioned so a stored response can be matched to the text the customer saw. */
export const STATEMENT_VERSION = "customer-ack-v1";

export const STATEMENT_TEXT =
  "I have read the description above. To the best of my knowledge it fairly describes work I received from or witnessed with this technician. I understand this is a simple acknowledgment and not a certification, licence or inspection.";

/**
 * Used for NEW requests' answers while the employer review portal is on. Adds a prospective notice only; a v1
 * acknowledgment keeps its meaning and is never treated as having agreed to anything more.
 */
export const STATEMENT_VERSION_V2 = "customer-ack-v2";
export const STATEMENT_TEXT_V2 = `${STATEMENT_TEXT} The technician may show that this description was acknowledged, without my name or contact details, in records they choose to share with prospective employers.`;

const KNOWN: Record<string, string> = { [STATEMENT_VERSION]: STATEMENT_TEXT, [STATEMENT_VERSION_V2]: STATEMENT_TEXT_V2 };

/** The statement to show now. */
export function customerStatement(employerReviewOn: boolean): { version: string; text: string } {
  return employerReviewOn ? { version: STATEMENT_VERSION_V2, text: STATEMENT_TEXT_V2 } : { version: STATEMENT_VERSION, text: STATEMENT_TEXT };
}

/** The version to record: the one the customer was shown (echoed by the page) if it is a known one, else the current. */
export function recordedStatementVersion(shown: string | undefined, employerReviewOn: boolean): string {
  return shown && KNOWN[shown] ? shown : customerStatement(employerReviewOn).version;
}

export const CORRECTION_MAX = 1000;
