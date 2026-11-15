/**
 * Grounding rules for AI-written text in "Related evidence — AI-assisted explanation". PURE and deterministic.
 *
 * The model is never trusted to state facts about the worker. Structurally:
 *   - it may only CHOOSE which supplied records relate (by opaque ref); what each record says is quoted from the
 *     record's own fields by `quoteRecord`, never written by the model;
 *   - the employer's wording is always shown as written; the model does not restate it;
 *   - its free text (what is unclear, a next step) is checked clause by clause, and ONE failing clause withholds
 *     the whole AI item (the deterministic content is shown instead). Rejected text is never stored or logged:
 *     only a reason code is kept.
 *
 * A clause fails when it:
 *   1. names a record or requirement ref (E1, Q2): references belong in the ref list, not in prose;
 *   2. makes a positive statement about the worker or their records ("you have…", "your records show…",
 *      "the technician can…"), unless it is a hedge/negation ("if you did…", "is not stated") or an instruction
 *      ("Add…", "Ask the employer…"): positive facts come only from the deterministic task check and quotes;
 *   3. judges the worker's ability in any direction ("experienced", "lacks", "not qualified"). The employer's own
 *      wording ("Ability to read wiring diagrams …") is masked first, so restating the requirement is allowed;
 *   4. uses fulfilment language ("satisfies", "meets", "qualifies", "sufficient", "demonstrates", "confirms"…)
 *      without a negation or hedge before it in the same clause, whatever the subject;
 *   5. mentions a work task whose status in the supplied records is not "documented" (assisted, done by others,
 *      checked only, not done, summary only, not established) without stating a limitation in the same clause.
 * These are deliberately strict: a false rejection only costs the AI wording, never the checked results.
 */
import type { Evidence } from "@/lib/types";
import type { TaskPartStatus } from "@/lib/types/explanations";
import { bestTaskStatus, TASK_WORDS, tasksIn } from "./tasks";

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
  /\b(?:meet|meets|met|meeting|satisf\w*|fulfil\w*|qualif\w*|eligib\w*|sufficient\w*|adequate\w*|enough|demonstrat\w*|prove|proves|proved|proven|proving|establish\w*|confirm\w*|verif\w*|match|matches|matched|covers?|covered|suitable|suited|fits?|guarantee\w*|evident|apparent|shown|shows|displays?|exhibits?)\b/i;
/** Stating the checked-only LIMITATION ("listed as checked or verified only", "checking or verifying it, not
 *  performing it") uses checking words that are not fulfilment claims; they are replaced by one neutral token before the clause checks. */
const CHECK_WORD = String.raw`(?:check\w*|verif\w*|confirm\w*|measur\w*|inspect\w*)`;
const CHECK_LIMITATION = new RegExp(
  String.raw`\b${CHECK_WORD}(?:\s+(?:or|and|and\/or)\s+${CHECK_WORD})?\s+only\b|\bonly\s+${CHECK_WORD}(?:\s+(?:or|and)\s+${CHECK_WORD})?\b|\b${CHECK_WORD}(?:\s+(?:or|and)\s+${CHECK_WORD})?(?:\s+(?:it|them|the \w+))?,?\s+(?:not|rather than)\s+(?:perform\w*|done|doing|carr\w+ out)\b`,
  "gi",
);

/** "Ask the employer to confirm…" / "The line asks you to meet…" describe a request, not a claim. */
const ASKED_TO = /\bask(?:s|ed|ing)?\b.*\bto\s+$/i;
/** Ability judgements about the worker, positive or negative, are never the AI's to make. */
const ABILITY = /\b(?:competent|capable|incapable|proficient|experienced|inexperienced|skilled|unskilled|expert|able|unable|ability|lack\w*|unqualified|qualified)\b/i;

/** Words that carry each limitation; the clause must contain one when the task is not documented. */
const LIMITATION: Record<Exclude<TaskPartStatus, "documented">, RegExp> = {
  assisted: /\b(?:assist\w*|help\w*|observ\w*|shadow\w*|supervis\w*|alongside)\b/i,
  checked_only: /\b(?:check\w*|verif\w*|measur\w*|inspect\w*)\b/i,
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


/** Lower case, hyphens and slashes to spaces, punctuation dropped: for comparing wording, not for display. */
const norm = (s: string) => ` ${s.toLowerCase().replace(/[-/]/g, " ").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim()} `;

/**
 * Masks the employer's OWN wording (any run of 2+ consecutive words of the requirement) before the ability and
 * fulfilment checks, so "Ability to read wiring diagrams is not stated" is not mistaken for an ability judgement.
 * The task-limitation and worker-subject checks always use the unmasked clause.
 */
export function maskRequirementWording(clause: string, requirementText: string): string {
  const words = norm(requirementText).trim().split(" ").filter(Boolean);
  let out = norm(clause);
  for (let n = Math.min(words.length, 30); n >= 2; n--) {
    for (let k = 0; k + n <= words.length; k++) {
      const gram = ` ${words.slice(k, k + n).join(" ")} `;
      while (out.includes(gram)) out = out.replace(gram, " REQ ");
    }
  }
  return out;
}

/**
 * The first problem in one AI-written text ("unclear" item or next step), or null. `records` are the records
 * supplied for this line; `requirementText` is the employer's wording of the line.
 */
export function groundingProblem(text: string, records: Evidence[], requirementText: string): GroundingProblem | null {
  if (REF.test(text)) return "reference_in_text";
  // The checked-only limitation becomes one token that still reads as a limitation ("check…") but not as a claim.
  for (const raw of clausesOf(text.replace(CHECK_LIMITATION, " checkedonly "))) {
    // Leading conjunctions and pure attributions ("according to the record") carry no claim of their own.
    const clause = raw.replace(/^(?:and|or|then|also)\s+/i, "").replace(/\baccording to (?:the|your|these|this) records?\b/gi, "").trim();
    if (!clause) continue;
    const masked = maskRequirementWording(clause, requirementText);
    if (unhedgedFulfilment(masked)) return "fulfilment_claim";
    const ability = ABILITY.test(masked);
    if (WORKER.test(clause) && (ability || (!HEDGE.test(clause) && !INSTRUCTION.test(clause)))) return "worker_claim";
    if (ability && !HEDGE.test(masked)) return "worker_claim"; // "Strong mechanical ability is evident"
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

/** Words that say nothing distinctive about a requirement or a record, so they never establish relevance. */
const GENERIC = new Set(
  (
    "ability able experience experienced required require requires preferred prefer proficiency proficient knowledge understanding " +
    "understand system systems certification certified residential commercial years year valid working work works worked strong solid " +
    "skill skills with from this that have must hvac equipment complete completing related including include independently independent " +
    "part team excellent attention detail details environment environments outdoor other ensure perform performing performed read " +
    "reading solve solving issue issues job jobs record records test fictional real qualitrail note notes good great plus knowledgeable " +
    "familiar familiarity hands general basic advanced level levels using used tasks task duties duty field service"
  ).split(" "),
);
const stemOf = (w: string) => {
  for (const suf of ["ations", "ation", "ings", "ing", "ers", "er", "ed", "es", "s"]) if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w;
};
const words = (s: string) =>
  new Set(norm(s).trim().split(" ").filter((w) => w.length >= 4 && !GENERIC.has(w) && !TASK_WORDS.has(w)).map(stemOf).filter((w) => !GENERIC.has(w) && !TASK_WORDS.has(w)));

const STATUS_WORDS: Record<Evidence["verificationStatus"], string> = {
  self_reported: "self-reported",
  document_supplied: "document supplied by you",
  pending_review: "awaiting review",
  independently_confirmed: "independently confirmed",
  expired_or_invalid: "expired or invalid",
};

export interface Excerpt {
  field: "Title" | "Work performed" | "Skills" | "Equipment";
  text: string;
}

/**
 * The record's own lines that relate to the requirement: from the PERMITTED fields only (title, work performed,
 * skills, equipment; never the summary), sharing a recognised task of the line or a distinctive word with it.
 * Relevance is established ONLY by such an excerpt; memory similarity alone never makes a record related.
 */
export function relevantExcerpts(e: Evidence, requirementText: string): Excerpt[] {
  const want = words(requirementText);
  const wantTasks = new Set(tasksIn(requirementText).map((t) => t.id));
  const relevant = (line: string) => tasksIn(line).some((t) => wantTasks.has(t.id)) || [...words(line)].some((w) => want.has(w));
  const d = e.structuredData;
  const fields: [Excerpt["field"], string[]][] = [
    ["Work performed", d.activities],
    ["Skills", d.skills],
    ["Equipment", d.equipment],
    ["Title", [e.title]],
  ];
  return fields.flatMap(([field, xs]) => xs.filter(relevant).map((x) => ({ field, text: x.trim().slice(0, 160) }))).slice(0, 3);
}

/** What a cited record says that relates, QUOTED from its permitted fields; null when nothing relates. */
export function quoteRecord(e: Evidence, requirementText: string): string | null {
  const ex = relevantExcerpts(e, requirementText);
  if (!ex.length) return null;
  return `${ex.map((x) => `${x.field}: "${x.text}"`).join("; ")} (${STATUS_WORDS[e.verificationStatus]}).`.slice(0, 500);
}
