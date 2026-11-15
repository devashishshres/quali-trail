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
import { contributionText, relationshipText, termsClause } from "./explain";
import { REVIEW_REASON_TEXT } from "../opportunities/requirement-rules";
import { GAP_AMBIGUOUS, GAP_CONFIRMATION, gapAmbiguousUncertainty, gapIncomplete, gapNoRecord } from "@/lib/next-steps";
import type {
  Evidence,
  EvidenceAssessment,
  EvidenceConnection,
  EvidenceRole,
  Requirement,
  RequirementResult,
  RuleCondition,
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

/** The requirement keywords the record itself states (title, skills, activities, summary, issuer, equipment). */
export function matchedTerms(req: Requirement, e: Evidence): string[] {
  const text = recordText(e);
  return req.criteria.keywords.filter((k) => hasKeyword(text, k));
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

/**
 * Rule-condition options. `checkText` replaces the requirement wording for the text-triggered checks below
 * (subject, scope, commissioning), so a condition is checked against its own catalog meaning. `termGroups`
 * are scope terms the record must state; a missing group makes the record incomplete, never direct.
 */
interface ClassifyOptions {
  checkText?: string;
  termGroups?: string[][];
}

/**
 * Record text for term groups: the record's HEADLINE only (title, skills, activities), where the term is not negated
 * (see affirmedMatch). A summary or equipment list that merely mentions a term ("startup was done by another crew")
 * is not the record stating it did that work, so it can never satisfy a scope term.
 */
function headlineSegments(e: Evidence): string[] {
  const d = e.structuredData;
  return [e.title, ...d.skills, ...d.activities];
}

/**
 * Negation applies only to the work it negates, judged clause by clause (same rule as the explanation task
 * breakdown): a negation word in the 4 words before the match ("did not install", "no residential work"), or
 * "not/never/…n't" within 3 words after it ("startup was not performed"). "Installed residential heat pump, no leaks
 * found" still states the installation. Contractions ("didn't", "wasn't") count as negations.
 */
const NEG_BEFORE = /\b(?:not|never|no|without|unable to|cannot)\b|n'?t\b/;
const NEG_AFTER = /^(?: \S+){0,3} (?:not|never|\S+n'?t)\b/;
const toClauses = (s: string) => norm(s.replace(/[’‘]/g, "'")).split(/[;.,:]| but | while | however | although | except /).map((c) => c.trim()).filter(Boolean);

export function affirmedMatch(segments: string[], re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const clause of segments.flatMap(toClauses)) {
    for (const m of clause.matchAll(g)) {
      const before = clause.slice(0, m.index).trim().split(" ").slice(-4).join(" ");
      const after = clause.slice(m.index! + m[0].length);
      if (!NEG_BEFORE.test(before) && !NEG_AFTER.test(after)) return true;
    }
  }
  return false;
}

const termRe = (term: string) => new RegExp(`\\b${escapeRe(norm(term))}(?![a-z0-9])`);

function classify(req: Requirement, c: Candidate, today: string, opts: ClassifyOptions = {}): Verdict {
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
  const reqNorm = norm(opts.checkText ?? req.originalText);
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

  const scope = credentialScope(opts.checkText ?? req.originalText, text);
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
    const activities = e.structuredData.activities;
    const installation = affirmedMatch(activities, /\binstall(?:ed|ing|ation)?\b|\bmounted\b|\bbraz(?:ed|ing)\b|\bconnected (?:the )?(?:refrigerant|line set)/);
    const startup = affirmedMatch(activities, /\bstart ?up\b|\bstarted up\b|\bstarting up\b|\boperational test/);
    if (activities.length && !installation && !startup) {
      return { kind: "supporting", why: "Documents related commissioning or service checks, but does not state that installation and startup were performed." };
    }
    if (!installation) missing.push("documented installation work performed");
    if (!startup) missing.push("documented startup work performed");
  }

  if (opts.termGroups?.length) {
    const segments = headlineSegments(e);
    for (const group of opts.termGroups) {
      if (!group.some((t) => affirmedMatch(segments, termRe(t)))) missing.push(`"${group.length > 1 ? `${group[0]}" (or ${group.slice(1).map((t) => `"${t}"`).join(", ")})` : `${group[0]}"`}`);
    }
  }

  if (missing.length > 0) return { kind: "incomplete", missing };

  // The requirement's terms appear only in secondary text (summary, issuer,
  // equipment), not in the title, skills or activities. That is genuine
  // ambiguity, not absence: ask a person to confirm instead of ignoring it.
  if (!headlineHit) {
    return {
      kind: "incomplete",
      missing: [],
      ambiguous: GAP_AMBIGUOUS,
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
    evidenceIssuer: e.issuer,
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

function evaluateBasic(req: Requirement, candidates: Candidate[], today: string, opts: ClassifyOptions = {}): RequirementResult {
  const direct: EvidenceConnection[] = []; // complete direct records
  const incomplete: EvidenceConnection[] = []; // right type, key facts missing
  const directDocumented: EvidenceConnection[] = [];
  const supporting: EvidenceConnection[] = [];
  const uncertainties: string[] = [];
  const missingDocumentation: string[] = [];
  let sawIncomplete = false;
  let sawWrongScope = false;
  let sawExpired = false;
  const related: { e: Evidence; terms: string[]; direct: boolean }[] = [];

  for (const c of dedupe(candidates)) {
    const v = classify(req, c, today, opts);
    const e = c.evidence;
    const terms = matchedTerms(req, e);
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
        supporting.push(connection(c, "supporting", `${contributionText(e, terms, "supporting")}`, `${v.reason} ${termsClause(terms)}`));
        related.push({ e, terms, direct: false });
        break;
      case "supporting":
        supporting.push(connection(c, "supporting", contributionText(e, terms, "supporting"), `${v.why} ${termsClause(terms)}`));
        related.push({ e, terms, direct: false });
        break;
      case "incomplete": {
        sawIncomplete = true;
        if (v.ambiguous) {
          uncertainties.push(clip(gapAmbiguousUncertainty(e.title), 500));
          incomplete.push(connection(c, "direct", contributionText(e, terms, "incomplete"), `${v.ambiguous} ${termsClause(terms)}`));
          related.push({ e, terms, direct: true });
          break;
        }
        const what = v.missing.join(", ");
        missingDocumentation.push(clip(gapIncomplete(e.title, what), 500));
        incomplete.push(
          connection(c, "direct", contributionText(e, terms, "incomplete"), `It is the type of record the requirement asks for, but it does not state ${what}. ${termsClause(terms)}`),
        );
        related.push({ e, terms, direct: true });
        break;
      }
      case "direct": {
        const conn = connection(c, "direct", contributionText(e, terms, "direct"), `Its type, stated content and required details match the requirement. ${termsClause(terms)}`);
        direct.push(conn);
        related.push({ e, terms, direct: true });
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
    missingDocumentation.push(GAP_CONFIRMATION);
  } else if (sawIncomplete) {
    assessment = "needs_review";
    explanation = "A record of the right kind exists, but it is missing details or is ambiguous, so a person should review it.";
  } else if (supporting.length > 0 && !sawWrongScope) {
    assessment = "no_sufficient_evidence";
    explanation = "Related records were found, but none is the kind of documentation this requirement asks for.";
    missingDocumentation.push(gapNoRecord(clip(req.originalText, 200)));
  } else if (sawWrongScope) {
    assessment = "no_sufficient_evidence";
    explanation = "A related credential was found, but its type is not one the requirement accepts.";
    missingDocumentation.push(gapNoRecord(clip(req.originalText, 200)));
  } else {
    assessment = "no_sufficient_evidence";
    explanation = sawExpired
      ? "The only matching record is expired or invalid."
      : "No sufficient documentation was found for this requirement.";
    missingDocumentation.push(gapNoRecord(clip(req.originalText, 200)));
  }

  const relationship = relationshipText(related);
  if (relationship) explanation = `${explanation} ${relationship}`;

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

/* ------------------------------------------------------------------ */
/* Imported requirements: rule routing                                 */
/* ------------------------------------------------------------------ */

const RANK: Record<EvidenceAssessment, number> = { no_sufficient_evidence: 0, needs_review: 1, evidence_found: 2, cannot_assess: -1 };

/** The condition as its own requirement: its own types, keywords and fields; the real id and wording. */
function conditionRequirement(req: Requirement, c: RuleCondition): Requirement {
  return {
    ...req,
    originalText: c.label,
    criteria: {
      acceptedTypes: c.acceptedTypes,
      supportingTypes: c.supportingTypes,
      keywords: c.keywords,
      retrievalQuery: c.retrievalQuery,
      requiredFields: c.requiredFields,
    },
  };
}

/** Checks one condition. Scope is enforced by term groups, so the check text is the condition's unscoped keywords. */
function evaluateCondition(req: Requirement, c: RuleCondition, candidates: Candidate[], today: string): RequirementResult {
  return evaluateBasic(conditionRequirement(req, c), candidates, today, { checkText: c.keywords.join(" "), termGroups: c.termGroups });
}

/** One record, one link: direct wins over supporting; best similarity kept. */
function mergeConnections(lists: EvidenceConnection[][]): EvidenceConnection[] {
  const byId = new Map<string, EvidenceConnection>();
  for (const c of lists.flat()) {
    const prev = byId.get(c.evidenceId);
    if (!prev || (prev.role === "supporting" && c.role === "direct")) byId.set(c.evidenceId, c);
  }
  return [...byId.values()].sort((a, b) => (a.role === b.role ? bySimilarityThenDate(a, b) : a.role === "direct" ? -1 : 1));
}

/**
 * Supported rule: every condition is checked separately and the requirement takes the WEAKEST result
 * (all-of). A record that covers one part never counts for the whole line.
 */
function evaluateSupported(req: Requirement, conditions: RuleCondition[], candidates: Candidate[], today: string): RequirementResult {
  const parts = conditions.map((c) => ({ c, r: evaluateCondition(req, c, candidates, today) }));
  const worst = parts.reduce((w, p) => (RANK[p.r.assessment] < RANK[w.r.assessment] ? p : w), parts[0]);
  const explanation =
    parts.length === 1
      ? worst.r.explanation
      : `This requirement has ${parts.length} parts, and each is checked on its own; the overall result is the weakest part. ${parts
          .map((p) => `${p.c.label}: ${p.r.explanation}`)
          .join(" ")}`;
  return {
    requirementId: req.id,
    originalText: req.originalText,
    mandatory: req.mandatory,
    assessment: worst.r.assessment,
    connections: mergeConnections(parts.map((p) => p.r.connections)),
    explanation: clip(explanation, 2000),
    uncertainties: [...new Set(parts.flatMap((p) => p.r.uncertainties.map((u) => clip(parts.length > 1 ? `${p.c.label}: ${u}` : u, 500))))],
    missingDocumentation: [...new Set(parts.flatMap((p) => p.r.missingDocumentation.map((m) => clip(parts.length > 1 ? `${p.c.label}: ${m}` : m, 500))))],
  };
}

/**
 * Review-only rule: never decided automatically. Records related to any recognised part are shown as
 * supporting context only, and nothing is listed as missing.
 */
function evaluateReviewOnly(req: Requirement, rule: Extract<NonNullable<Requirement["criteria"]["rule"]>, { kind: "review_only" }>, candidates: Candidate[], today: string): RequirementResult {
  const parts = rule.partial.map((c) => ({ c, r: evaluateCondition(req, c, candidates, today) }));
  const connections = mergeConnections(parts.map((p) => p.r.connections)).map((c) => ({
    ...c,
    role: "supporting" as const,
    relevanceExplanation: clip(`Shown for context only; this requirement is not assessed automatically. ${c.relevanceExplanation}`, 1000),
  }));
  const reasons = rule.reasons.map((r) => REVIEW_REASON_TEXT[r]);
  const context = parts.length
    ? ` For context, QualiTrail recognised part of the wording: ${parts.map((p) => `${p.c.label} (${p.r.assessment.replace(/_/g, " ")})`).join("; ")}. That part alone does not decide this requirement.`
    : "";
  return {
    requirementId: req.id,
    originalText: req.originalText,
    mandatory: req.mandatory,
    assessment: "cannot_assess",
    connections,
    explanation: clip(`Not assessed automatically. ${reasons.join(" ")}${context} Compare your records with this requirement yourself, or ask the employer.`, 2000),
    uncertainties: reasons.map((r) => clip(r, 500)),
    missingDocumentation: [],
  };
}

export function evaluateRequirement(req: Requirement, candidates: Candidate[], today: string): RequirementResult {
  const rule = req.criteria.rule;
  if (!rule) return evaluateBasic(req, candidates, today);
  if (rule.kind === "supported") return evaluateSupported(req, rule.conditions, candidates, today);
  return evaluateReviewOnly(req, rule, candidates, today);
}
