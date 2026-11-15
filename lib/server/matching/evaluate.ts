/**
 * Deterministic qualification evaluator. PURE: no I/O, no clock, no network.
 *
 * Supermemory (or any retriever) only proposes CANDIDATES. This module decides
 * what they mean for a requirement, using the records' database fields.
 *
 * Two separate axes, never mixed:
 *   - assessment  = is relevant documentation present?   (this file)
 *   - verificationStatus = did a human independently confirm it? (copied
 *     through unchanged; nothing here can set or imply it)
 *
 * Retrieval similarity can make a record a *supporting* candidate, but never
 * a *direct* one: direct needs an accepted type AND content checks below.
 */
import type {
  Evidence,
  EvidenceAssessment,
  EvidenceConnection,
  EvidenceRole,
  Requirement,
  RequirementResult,
  VerificationStatus,
} from "@/lib/types";

export interface Candidate {
  evidence: Evidence;
  /** Retrieval similarity 0–1 from memory search; null if not found via memory. */
  memorySimilarity: number | null;
}

/** Retrieval similarity at/above which a topical record may be shown as supporting. */
export const SUPPORT_MIN_SIMILARITY = 0.5;

/** Statuses that mean a document exists (still NOT independent confirmation). */
const DOCUMENTED: ReadonlySet<VerificationStatus> = new Set([
  "document_supplied",
  "pending_review",
  "independently_confirmed",
]);

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.toLowerCase().replace(/[-–—_/]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keyword = word-prefix match, so "install" matches "installation" but not "reinstall". */
function hasKeyword(text: string, keyword: string): boolean {
  const k = norm(keyword);
  return k.length > 0 && new RegExp(`\\b${escapeRe(k)}`).test(text);
}

/**
 * The record's own headline content: title, skills, activities. A keyword that
 * appears only in the free-text summary, issuer or equipment is not enough for
 * a DIRECT match (a toolbox talk "for heat-pump crews" is not heat-pump training).
 */
function headlineText(e: Evidence): string {
  const d = e.structuredData;
  return norm([e.title, ...d.skills, ...d.activities].join(" \n "));
}

function recordText(e: Evidence): string {
  const d = e.structuredData;
  return norm(
    [e.title, e.issuer ?? "", d.summary ?? "", ...d.skills, ...d.activities, ...d.equipment].join(" \n "),
  );
}

/* ------------------------------------------------------------------ */
/* Additional checks that criteria alone cannot express                */
/* ------------------------------------------------------------------ */

/** EPA 608 core/Type I/Type II/Type III/Universal are different scopes. */
const EPA_ACCEPTS = [/\buniversal\b/, /\btype ?(ii|2)\b/];
const EPA_OTHER = [/\btype ?(i|1)\b/, /\btype ?(iii|3)\b/, /\bcore\b/];

type Scope = "ok" | "wrong" | "unknown" | "n/a";

function credentialScope(requirementText: string, text: string): Scope {
  const req = norm(requirementText);
  const isEpa608 = /\b(epa|section) ?608\b/.test(req) || /\b608\b/.test(req);
  const scoped = /\buniversal\b|\btype ?(ii|2)\b/.test(req);
  if (!isEpa608 || !scoped) return "n/a";
  if (EPA_ACCEPTS.some((r) => r.test(text))) return "ok";
  if (EPA_OTHER.some((r) => r.test(text))) return "wrong";
  return "unknown";
}

const HEAT_PUMP = /\bheat ?pump/;

/* ------------------------------------------------------------------ */
/* Per-candidate classification                                        */
/* ------------------------------------------------------------------ */

type Verdict =
  | { kind: "drop" }
  | { kind: "expired"; reason: string }
  | { kind: "wrong_scope"; reason: string }
  | { kind: "direct"; notes: string[] }
  | { kind: "incomplete"; missing: string[]; ambiguous?: string } // right kind of record, key facts absent or unclear
  | { kind: "supporting"; why: string };

function isExpired(e: Evidence, today: string): boolean {
  if (e.verificationStatus === "expired_or_invalid") return true;
  const exp = e.structuredData.expirationDate;
  // Only an expiry the DOCUMENT states counts. Never guessed.
  return exp !== null && exp < today;
}

function classify(req: Requirement, c: Candidate, today: string): Verdict {
  const { criteria } = req;
  const e = c.evidence;
  const text = recordText(e);

  const accepted = criteria.acceptedTypes.includes(e.type);
  const supportType = criteria.supportingTypes.includes(e.type);
  if (!accepted && !supportType) return { kind: "drop" };

  if (isExpired(e, today)) {
    return {
      kind: "expired",
      reason:
        e.verificationStatus === "expired_or_invalid"
          ? "This record is marked expired or invalid."
          : `This record states an expiry date (${e.structuredData.expirationDate}) that has passed.`,
    };
  }

  const keywordHit = criteria.keywords.some((k) => hasKeyword(text, k));
  const headline = headlineText(e);
  const headlineHit = criteria.keywords.some((k) => hasKeyword(headline, k));
  const reqNorm = norm(req.originalText);
  // Subject check: a heat-pump requirement is not met by a generic record.
  const subjectOk = !HEAT_PUMP.test(reqNorm) || HEAT_PUMP.test(text);
  const topical = subjectOk && (keywordHit || (c.memorySimilarity ?? 0) >= SUPPORT_MIN_SIMILARITY);
  if (!topical) return { kind: "drop" };

  if (!accepted) {
    return { kind: "supporting", why: "Related record type; it can support but not satisfy this requirement alone." };
  }

  // From here: accepted type. Retrieval similarity alone is not enough.
  if (!subjectOk || !keywordHit) {
    return { kind: "supporting", why: "Relevant to the topic, but its content does not state what the requirement asks for." };
  }

  const scope = credentialScope(req.originalText, text);
  if (scope === "wrong") {
    return { kind: "wrong_scope", reason: "The credential type stated on this record is not one the requirement accepts." };
  }

  const missing: string[] = [];
  if (criteria.requiredFields.includes("date") && e.date === null) missing.push("a date");
  if (criteria.requiredFields.includes("issuer") && !e.issuer) missing.push("an issuer");
  if (scope === "unknown") missing.push("the credential type or scope (the requirement names specific types)");

  // Work records and checklists must actually describe completed work.
  const needsActivities = e.type === "work_record" || e.type === "checklist";
  if (needsActivities && e.structuredData.activities.length === 0) missing.push("a description of the work performed");

  // A commissioning checklist must be about commissioning, not any checklist.
  if (/\bcommissioning\b/.test(reqNorm) && e.type === "checklist" && !/\bcommissioning\b/.test(text)) {
    return { kind: "supporting", why: "A checklist, but it does not state that it documents commissioning." };
  }

  // Installing AND starting up are separate activities. A document title
  // ending in "residential install" cannot prove that either was performed.
  const requiresInstallAndStartup = /\bexperience\b|\bhands on\b/.test(reqNorm)
    && /\binstall/.test(reqNorm) && /\bstart/.test(reqNorm);
  if (requiresInstallAndStartup && needsActivities) {
    const activities = e.structuredData.activities.map(norm).filter((a) => !/\b(?:not|never)\b/.test(a));
    const installation = activities.some((a) => /\binstall(?:ed|ing|ation)?\b|\bmounted\b|\bbraz(?:ed|ing)\b|\bconnected (?:the )?(?:refrigerant|line set)/.test(a));
    const startup = activities.some((a) => /\bstart ?up\b|\bstarted up\b|\bstarting up\b|\boperational test/.test(a));
    if (activities.length && !installation && !startup) {
      return { kind: "supporting", why: "Documents related commissioning or service checks, but does not state that installation and startup were performed." };
    }
    if (!installation) missing.push("documented installation work performed");
    if (!startup) missing.push("documented startup work performed");
  }

  if (missing.length > 0) return { kind: "incomplete", missing };

  // The requirement's terms appear only in secondary text (summary, issuer,
  // equipment), not in the title, skills or activities. That is genuine
  // ambiguity, not absence: ask a person to confirm instead of ignoring it.
  if (!headlineHit) {
    return {
      kind: "incomplete",
      missing: [],
      ambiguous: "The requirement's terms appear only in this record's summary or secondary details, not in its title, skills or activities.",
    };
  }
  return { kind: "direct", notes: [] };
}

/* ------------------------------------------------------------------ */
/* Per-requirement result                                              */
/* ------------------------------------------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function connection(
  c: Candidate,
  role: EvidenceRole,
  contribution: string,
  relevanceExplanation: string,
): EvidenceConnection {
  const e = c.evidence;
  return {
    evidenceId: e.id,
    evidenceTitle: e.title,
    evidenceDate: e.date,
    evidenceType: e.type,
    verificationStatus: e.verificationStatus,
    role,
    contribution: clip(contribution, 500),
    relevanceExplanation: clip(relevanceExplanation, 1000),
    memorySimilarity: c.memorySimilarity,
  };
}

/** Same record found twice: keep one, with the higher similarity. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byId.get(c.evidence.id);
    if (!prev || (c.memorySimilarity ?? -1) > (prev.memorySimilarity ?? -1)) byId.set(c.evidence.id, c);
  }
  return [...byId.values()];
}

const bySimilarityThenDate = (a: EvidenceConnection, b: EvidenceConnection) =>
  (b.memorySimilarity ?? -1) - (a.memorySimilarity ?? -1) || (b.evidenceDate ?? "").localeCompare(a.evidenceDate ?? "");

export function evaluateRequirement(req: Requirement, candidates: Candidate[], today: string): RequirementResult {
  const direct: EvidenceConnection[] = []; // complete direct records
  const incomplete: EvidenceConnection[] = []; // right type, key facts missing
  const directDocumented: EvidenceConnection[] = [];
  const supporting: EvidenceConnection[] = [];
  const uncertainties: string[] = [];
  const missingDocumentation: string[] = [];
  let sawIncomplete = false;
  let sawWrongScope = false;
  let sawExpired = false;

  for (const c of dedupe(candidates)) {
    const v = classify(req, c, today);
    const e = c.evidence;
    switch (v.kind) {
      case "drop":
        break;
      case "expired":
        sawExpired = true;
        uncertainties.push(clip(`"${e.title}": ${v.reason} It is not counted.`, 500));
        break;
      case "wrong_scope":
        sawWrongScope = true;
        uncertainties.push(clip(`"${e.title}": ${v.reason}`, 500));
        supporting.push(connection(c, "supporting", "Related credential of a different type.", v.reason));
        break;
      case "supporting":
        supporting.push(connection(c, "supporting", "Related evidence that supports but does not satisfy the requirement.", v.why));
        break;
      case "incomplete": {
        sawIncomplete = true;
        if (v.ambiguous) {
          uncertainties.push(clip(`"${e.title}": ${v.ambiguous} Please confirm it covers the requirement.`, 500));
          incomplete.push(connection(c, "direct", "Right kind of record that may cover the requirement; needs a person to confirm.", v.ambiguous));
          break;
        }
        const what = v.missing.join(", ");
        missingDocumentation.push(clip(`"${e.title}" does not state ${what}.`, 500));
        incomplete.push(
          connection(c, "direct", "Right kind of record, but key details are missing.", `It is the type of record the requirement asks for, but it lacks ${what}.`),
        );
        break;
      }
      case "direct": {
        const conn = connection(c, "direct", "Record of the type the requirement asks for, whose content matches it.", "Its type, content and required details match the requirement.");
        direct.push(conn);
        if (DOCUMENTED.has(e.verificationStatus)) directDocumented.push(conn);
        break;
      }
    }
  }

  let assessment: EvidenceAssessment;
  let explanation: string;

  if (directDocumented.length > 0) {
    assessment = "evidence_found";
    explanation = "A supplied document matches this requirement.";
    if (!directDocumented.some((d) => d.verificationStatus === "independently_confirmed")) {
      uncertainties.push("The matching document was supplied by the worker and has not been independently reviewed.");
    }
  } else if (direct.length > 0) {
    assessment = "needs_review";
    explanation = "A record describes relevant work or credentials, but it is self-reported with no supporting document.";
    uncertainties.push("The matching record is self-reported.");
    missingDocumentation.push("A supporting document or independent confirmation for this record");
  } else if (sawIncomplete) {
    assessment = "needs_review";
    explanation = "A record of the right kind exists, but it is missing details or is ambiguous, so a person should review it.";
  } else if (supporting.length > 0 && !sawWrongScope) {
    assessment = "no_sufficient_evidence";
    explanation = "Related records were found, but none is the kind of documentation this requirement asks for.";
    missingDocumentation.push(`A record that directly documents: ${clip(req.originalText, 200)}`);
  } else if (sawWrongScope) {
    assessment = "no_sufficient_evidence";
    explanation = "A related credential was found, but its type is not one the requirement accepts.";
    missingDocumentation.push(`A record that directly documents: ${clip(req.originalText, 200)}`);
  } else {
    assessment = "no_sufficient_evidence";
    explanation = sawExpired
      ? "The only matching record is expired or invalid."
      : "No sufficient documentation was found for this requirement.";
    missingDocumentation.push(`A record that directly documents: ${clip(req.originalText, 200)}`);
  }

  // Never double count: a record is linked once, as direct or supporting.
  const connections = [...direct.sort(bySimilarityThenDate), ...incomplete.sort(bySimilarityThenDate), ...supporting.sort(bySimilarityThenDate)];

  return {
    requirementId: req.id,
    originalText: req.originalText,
    mandatory: req.mandatory,
    assessment,
    connections,
    explanation: clip(explanation, 2000),
    uncertainties: [...new Set(uncertainties)],
    missingDocumentation: [...new Set(missingDocumentation)],
  };
}
