/**
 * Deterministic, source-grounded wording for evidence connections. PURE.
 * Every phrase comes from facts stored on the record (type, issuer, date,
 * stated skills and activities, verification status) or from the requirement's
 * own keywords. Nothing here asserts independence, authenticity or a
 * qualification: relatedness is not proof that records describe the same work.
 */
import type { Evidence } from "@/lib/types";

const TYPE_LABEL: Record<Evidence["type"], string> = {
  certification: "certification",
  training: "training record",
  work_record: "work record",
  checklist: "checklist",
  experience_note: "experience note",
  other: "record",
};

export const typeLabel = (e: Evidence) => TYPE_LABEL[e.type];

const PROVENANCE: Record<Evidence["verificationStatus"], string> = {
  self_reported: "Self-reported with no document",
  document_supplied: "Document supplied by the worker, not independently confirmed",
  pending_review: "Awaiting review",
  independently_confirmed: "Independently confirmed",
  expired_or_invalid: "Marked expired or invalid",
};

export const provenance = (e: Evidence) => PROVENANCE[e.verificationStatus];

/** "training record from Northwind, 2025-03-14". Only stored fields; missing parts are omitted. */
export function describeSource(e: Evidence): string {
  return `${typeLabel(e)}${e.issuer ? ` from ${e.issuer}` : ""}${e.date ? `, dated ${e.date}` : ""}`;
}

/** The record's own stated items that contain a matched term, falling back to its first stated items. */
export function statedFacts(e: Evidence, terms: string[], max = 3): string[] {
  const items = [...e.structuredData.activities, ...e.structuredData.skills];
  const lower = terms.map((t) => t.toLowerCase());
  const hits = items.filter((i) => lower.some((t) => i.toLowerCase().includes(t)));
  return (hits.length ? hits : items).slice(0, max);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What this specific record contributes. */
export function contributionText(e: Evidence, terms: string[], kind: "direct" | "incomplete" | "supporting"): string {
  const facts = statedFacts(e, terms);
  const states = facts.length ? ` It states: ${facts.join("; ")}.` : "";
  const lead = `${cap(typeLabel(e))} "${e.title}"${e.issuer ? ` from ${e.issuer}` : ""}${e.date ? `, dated ${e.date}` : ""}.${states}`;
  const tail = kind === "supporting" ? " It supports the requirement but does not itself state what it asks for." : "";
  return `${lead}${tail} ${provenance(e)}.`;
}

export function termsClause(terms: string[]): string {
  return terms.length
    ? `Shares these requirement terms: ${terms.join(", ")}.`
    : "Found by memory search; it shares no requirement terms, so its relevance is unconfirmed.";
}

/**
 * How the records for one requirement relate. Describes what each states and
 * why they are grouped, and says plainly that grouping proves nothing about
 * the same job, the same people or independent review.
 */
export function relationshipText(items: { e: Evidence; terms: string[]; direct: boolean }[]): string | null {
  if (items.length < 2) return null;
  const shown = items.slice(0, 4).map(({ e, terms, direct }) => {
    const facts = statedFacts(e, terms, 2);
    return `${cap(typeLabel(e))}${e.date ? ` (${e.date})` : ""}${direct ? "" : ", related only"}: ${facts.length ? facts.join("; ") : e.title}`;
  });
  const more = items.length > 4 ? ` (+${items.length - 4} more)` : "";
  const shared = items.map((i) => i.terms.map((t) => t.toLowerCase())).reduce((a, b) => a.filter((t) => b.includes(t)));
  const why = shared.length ? ` Common terms: ${[...new Set(shared)].join(", ")}.` : "";
  return `Records considered together: ${shown.join(" | ")}${more}.${why} They are listed together because each was found for this requirement; this does not show they describe the same job or were reviewed independently.`;
}
