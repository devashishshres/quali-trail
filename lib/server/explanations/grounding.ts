/**
 * Grounding rules for AI-written text in "Related evidence — AI-assisted explanation". PURE and deterministic.
 *
 * The model is never trusted to state facts about the worker. Structurally:
 *   - it may only CHOOSE which supplied records relate (by opaque ref); what each record says is quoted from the
 *     record's own fields by `quoteRecord`, never written by the model;
 *   - its free text (what the line asks, what is unclear, a next step) is checked clause by clause, and ONE failing
 *     clause withholds the whole AI item (the deterministic content is shown instead).
 *
 * A clause fails when it:
 *   1. names a record or requirement ref (E1, Q2): references belong in the ref list, not in prose;
 *   2. makes a positive statement about the worker or their records ("you have…", "your records show…",
 *      "the technician can…"), unless it is a hedge/negation ("if you did…", "is not stated") or an instruction
 *      ("Add…", "Ask the employer…"): positive facts come only from the deterministic task check and quotes;
 *   3. judges the worker's ability in any direction ("experienced", "lacks", "not qualified");
 *   4. uses fulfilment language ("satisfies", "meets", "qualifies", "sufficient", "demonstrates", "confirms"…)
 *      without a negation or hedge before it in the same clause, whatever the subject;
 *   5. mentions a work task whose status in the supplied records is not "documented" (assisted, done by others,
 *      not done, summary only, not established) without stating a limitation in the same clause.
 * These are deliberately strict: a false rejection only costs the AI wording, never the checked results.
 */
import type { Evidence } from "@/lib/types";
import type { TaskPartStatus } from "@/lib/types/explanations";
import { bestTaskStatus, tasksIn } from "./tasks";

export type GroundingProblem = "reference_in_text" | "worker_claim" | "fulfilment_claim" | "contradicts_records";

/** Clauses: split on sentence punctuation, commas and subordinators that can carry a separate claim. */
export const clausesOf = (s: string) =>
  s
    .split(/[.;:!?,\n]|\b(?:but|and so|so|since|because|therefore|thus|hence|which means|meaning)\b/i)
    .map((c) => c.trim())
    .filter(Boolean);

const REF = /\b[EQ]\d+\b/;
const WORKER = /\b(?:you|your|yours|you've|you're|you'd|the technician|technician's|this technician|the worker|the candidate|the applicant|this person|they|their|them|the records?|these records|this record|those records|records show)\b/i;
/** Negation or hedge that turns a clause into a non-claim. "may"/"might" are NOT hedges: they still assert. */
const HEDGE = /\b(?:not|no|never|neither|nor|none|without|whether|if|unless|cannot|unclear|unknown|unstated|missing|absent)\b|n't\b/i;
const INSTRUCTION = /^(?:please\s+)?(?:add|upload|ask|edit|describe|include|note|list|clarify|check|consider|attach|keep|update|mention|write|compare|contact|request|explain|bring|gather|record|find|look)\b/i;
const FULFIL =
  /\b(?:meet|meets|met|meeting|satisf\w*|fulfil\w*|qualif\w*|eligib\w*|sufficient\w*|adequate\w*|enough|demonstrat\w*|prove|proves|proved|proven|proving|establish\w*|confirm\w*|verif\w*|match|matches|matched|covers?|covered|suitable|suited|fits?|guarantee\w*)\b/i;
/** "Ask the employer to confirm…" / "The line asks you to meet…" describe a request, not a claim. */
const ASKED_TO = /\bask(?:s|ed|ing)?\b.*\bto\s+$/i;
/** Ability judgements about the worker, positive or negative, are never the AI's to make. */
const ABILITY = /\b(?:competent|capable|incapable|proficient|experienced|inexperienced|skilled|unskilled|expert|able|unable|ability|lack\w*|unqualified|qualified)\b/i;

/** Words that carry each limitation; the clause must contain one when the task is not documented. */
const LIMITATION: Record<Exclude<TaskPartStatus, "documented">, RegExp> = {
  assisted: /\b(?:assist\w*|help\w*|observ\w*|shadow\w*|supervis\w*|alongside)\b/i,
  by_others: /\b(?:another|someone else|other (?:crew|tech\w*|installer|person|team)|by others|different crew)\b/i,
  negated: /\b(?:not|never|no)\b|n't\b/i,
  summary_only: /\bsummary\b/i,
  not_found: /\b(?:not|no|unclear|unknown|missing)\b|n't\b/i,
};

/** A fulfilment word is acceptable only after a negation/hedge, or when asking the employer, in the same clause. */
function unhedgedFulfilment(clause: string): boolean {
  const m = FULFIL.exec(clause);
  if (!m) return false;
  const before = clause.slice(0, m.index);
  return !(HEDGE.test(before) || ASKED_TO.test(before));
}

/** Statements that work was done. "What the line asks" must describe a request, so it may not contain these. */
const DONE_CLAIM = /\b(?:was|were|has been|have been|had been|did|done|performed|completed|carried out|handled|finished)\b/i;

/**
 * The first problem in one AI-written text, or null. `records` are the records supplied for this line.
 * "asks" (what the employer's line asks for) may not mention the worker or their records at all, nor say that
 * anything was done; it may name tasks, because it restates the employer's list. "unclear" and "nextStep" are
 * checked clause by clause, including the task-limitation rule.
 */
export function groundingProblem(text: string, records: Evidence[], field: "asks" | "unclear" | "nextStep"): GroundingProblem | null {
  if (REF.test(text)) return "reference_in_text";
  for (const raw of clausesOf(text)) {
    // Leading conjunctions and pure attributions ("according to the record") carry no claim of their own.
    const clause = raw.replace(/^(?:and|or|then|also)\s+/i, "").replace(/\baccording to (?:the|your|these|this) records?\b/gi, "").trim();
    if (!clause) continue;
    if (unhedgedFulfilment(clause)) return "fulfilment_claim";
    if (field === "asks") {
      if (WORKER.test(clause) || ABILITY.test(clause)) return "worker_claim";
      if (DONE_CLAIM.test(clause)) return "contradicts_records";
      continue;
    }
    if (WORKER.test(clause) && (ABILITY.test(clause) || (!HEDGE.test(clause) && !INSTRUCTION.test(clause)))) return "worker_claim";
    for (const term of tasksIn(clause)) {
      const status = bestTaskStatus(term, records);
      if (status === "documented") continue;
      if (!(LIMITATION[status].test(clause) || HEDGE.test(clause))) return "contradicts_records";
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Deterministic description of a cited record                         */
/* ------------------------------------------------------------------ */

const GENERIC = new Set(["ability", "experience", "required", "preferred", "proficiency", "knowledge", "systems", "system", "certification", "residential", "commercial", "years", "valid", "working", "strong", "skills", "with", "from", "this", "that", "have", "must"]);
const stems = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, 4)) ?? []);

const STATUS_WORDS: Record<Evidence["verificationStatus"], string> = {
  self_reported: "self-reported",
  document_supplied: "document supplied by you",
  pending_review: "awaiting review",
  independently_confirmed: "independently confirmed",
  expired_or_invalid: "expired or invalid",
};

/**
 * What a cited record says, QUOTED from its own title, skills, work performed and equipment (never the summary),
 * keeping only lines that share task wording or a distinctive word with the requirement. Shown to the technician only.
 */
export function quoteRecord(e: Evidence, requirementText: string): string {
  const want = stems(requirementText);
  const wantTasks = new Set(tasksIn(requirementText).map((t) => t.id));
  const relevant = (line: string) => tasksIn(line).some((t) => wantTasks.has(t.id)) || [...stems(line)].some((w) => want.has(w));
  const d = e.structuredData;
  const fields: [string, string[]][] = [
    ["Work performed", d.activities],
    ["Skills", d.skills],
    ["Equipment", d.equipment],
  ];
  const quotes = fields.flatMap(([label, xs]) => xs.filter(relevant).map((x) => `${label}: "${x.trim().slice(0, 160)}"`)).slice(0, 3);
  const body = quotes.length ? quotes.join("; ") : `Title only: "${e.title.slice(0, 160)}"`;
  return `${body} (${STATUS_WORDS[e.verificationStatus]}).`.slice(0, 500);
}
