/**
 * Planning, minimal model input and output validation for "Related evidence — AI-assisted explanation". PURE.
 *
 * Boundaries (see docs/JOB_IMPORT.txt, "AI-assisted explanation"):
 *   - Only requirements the strict evaluator could not assess (`cannot_assess`) are explained.
 *   - Eligibility conditions (duration, driving, physical, work authorization, background, education, schedule,
 *     negative conditions) are NEVER sent to the model and never inferred: fixed clarification text only.
 *   - The model sees the requirement's own wording and, per related record, only: type, title, date (month),
 *     issuer, skills, work performed, equipment and verification label. Never the summary, credential numbers,
 *     original files, signatures, sign-off or review data, customer details, the worker's name or profile summary.
 *     Emails, phone numbers and street addresses are redacted from what is sent.
 *   - Record references are opaque ("E1"). Every reference the model returns must be one supplied FOR THAT
 *     requirement; anything else is rejected and counted. Text that claims a match, qualification, eligibility or
 *     verification is rejected.
 */
import type { Evidence, Requirement, ReviewReason } from "@/lib/types";
import type { RelatedRecord, RequirementExplanation, TaskBreakdown } from "@/lib/types/explanations";
import type { Candidate } from "../matching/evaluate";
import { groundingProblem, quoteRecord, relevantExcerpts, type GroundingProblem } from "./grounding";
import { tasksIn } from "./tasks";
import { taskBreakdown } from "./tasks";

/* ------------------------------------------------------------------ */
/* Eligibility: clarification only                                     */
/* ------------------------------------------------------------------ */

export const ELIGIBILITY_TEXT: Partial<Record<ReviewReason, string>> = {
  duration:
    "The listing asks for an amount of experience. QualiTrail does not add up time from records. Ask the employer how they count experience, and be ready to describe your work history.",
  driving: "The listing asks about driving or a licence. QualiTrail does not check this. Confirm with the employer what licence and driving record they need.",
  physical: "The listing describes physical conditions of the work. QualiTrail does not assess these. Ask the employer if anything is unclear.",
  work_authorization: "Work authorization is between you and the employer. QualiTrail does not assess it.",
  background_check: "Background or screening requirements are handled by the employer. QualiTrail does not assess them.",
  education: "Education requirements are outside the records QualiTrail compares. Check with the employer what they accept.",
  schedule: "Schedule and availability are not assessed from records. Confirm the expectations with the employer.",
  negation: "The wording sets a negative condition, which records cannot show. Clarify it with the employer if it applies to you.",
};

export const NO_RELATED_STEP =
  "No related record was found among your saved records. If you have done this work or hold this document, add a record in My Evidence; otherwise ask the employer what they accept.";
export const AI_UNAVAILABLE_STEP = "The AI-assisted explanation isn't available for this line. Compare it with your records yourself, or ask the employer to clarify it.";

/* ------------------------------------------------------------------ */
/* Plan per requirement                                                */
/* ------------------------------------------------------------------ */

/**
 * A record is related ONLY when one of its permitted fields (title, work performed, skills, equipment) has an excerpt
 * that names a task of the line or shares a distinctive word with it (grounding.ts `relevantExcerpts`). Memory
 * similarity only decides which records are looked at, and in what order; it never makes a record related.
 */
export const MAX_RECORDS_PER_REQUIREMENT = 5;

const STUB_GENERIC = new Set(["ability", "experience", "required", "preferred", "proficiency", "knowledge", "systems", "system", "certification", "residential", "commercial", "years", "valid", "working", "strong", "skills"]);
const stubWords = (s: string) => new Set(s.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !STUB_GENERIC.has(w)).map((w) => w.slice(0, 4)) ?? []);
/**
 * Isolated-local stand-in for memory search: 0.6 when a record's own wording shares a distinctive word stem with the
 * query, else 0.2. Deterministic, so local tests can tell related from unrelated records. Never used in live mode.
 */
export function stubSimilarity(query: string, e: Evidence): number {
  const q = stubWords(query);
  const own = stubWords([e.title, ...e.structuredData.skills, ...e.structuredData.activities, ...e.structuredData.equipment].join(" "));
  return [...q].some((w) => own.has(w)) ? 0.6 : 0.2;
}

/** Stored limit for `clarification` (lib/types/explanations.ts). */
export const CLARIFICATION_MAX = 800;
export const MORE_CONDITIONS = "The line also sets other conditions QualiTrail does not assess; ask the employer about each of them.";
export const SEARCH_FAILED_NOTE = "Related records couldn't be searched for this line.";
export const CONTEXT_ONLY_NOTE = "Any work records listed here are context only; they do not establish this condition.";

/**
 * Fixed clarification text that always fits the stored limit. Whole condition sentences are kept in order while they
 * fit; if any are left out, one fixed sentence says further conditions need clarifying. Notes (context-only caveat,
 * search failure) are always kept. Never cuts a sentence and never drops the clarification, so a long line can't
 * make saving fail.
 */
export function joinClarification(conditions: string[], notes: string[] = [], max = CLARIFICATION_MAX): string | null {
  const unique = [...new Set(conditions)];
  const full = [...unique, ...notes].join(" ");
  if (full.length <= max) return full || null;
  const kept: string[] = [];
  for (const c of unique) if ([...kept, c, MORE_CONDITIONS, ...notes].join(" ").length <= max) kept.push(c);
  return [...kept, MORE_CONDITIONS, ...notes].join(" ");
}

export interface Plan {
  requirement: Requirement;
  mode: "eligibility" | "no_related" | "ai";
  breakdown: TaskBreakdown | null;
  clarification: string | null;
  /** The parts `clarification` was built from, so a later note can be added without exceeding the limit. */
  conditions: string[];
  notes: string[];
  records: Evidence[];
}

const reasonsOf = (r: Requirement): ReviewReason[] => (r.criteria.rule?.kind === "review_only" ? r.criteria.rule.reasons : []);

export function plan(requirement: Requirement, candidates: Candidate[]): Plan {
  const reasons = reasonsOf(requirement);
  const elig = reasons.map((r) => ELIGIBILITY_TEXT[r]).filter((t): t is string => !!t);
  // Breakdown is judged against every resolved candidate; a record that names the task is related by definition.
  const all = candidates.map((c) => c.evidence);
  const breakdown = taskBreakdown(requirement.originalText, all);
  const taskIds = new Set(breakdown?.parts.flatMap((p) => p.evidenceIds) ?? []);
  const records = [...candidates]
    .sort((a, b) => (b.memorySimilarity ?? 0) - (a.memorySimilarity ?? 0))
    .map((c) => c.evidence)
    .filter((e) => relevantExcerpts(e, requirement.originalText).length > 0)
    .slice(0, MAX_RECORDS_PER_REQUIREMENT);

  if (elig.length) {
    const notes = breakdown ? [CONTEXT_ONLY_NOTE] : [];
    return { requirement, mode: "eligibility", breakdown, clarification: joinClarification(elig, notes), conditions: elig, notes, records: breakdown ? records.filter((e) => taskIds.has(e.id)) : [] };
  }
  if (!records.length) return { requirement, mode: "no_related", breakdown, clarification: null, conditions: [], notes: [], records: [] };
  return { requirement, mode: "ai", breakdown, clarification: null, conditions: [], notes: [], records };
}

/* ------------------------------------------------------------------ */
/* Minimal model input                                                 */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<Evidence["verificationStatus"], string> = {
  self_reported: "self-reported",
  document_supplied: "document supplied by the technician",
  pending_review: "awaiting review",
  independently_confirmed: "independently confirmed",
  expired_or_invalid: "expired or invalid",
};

/** Removes contact details a technician may have typed into a record. */
export function redact(s: string): string {
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone removed]")
    .replace(/\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle)\b\.?/g, "[address removed]");
}
const clipList = (xs: string[], n: number, len: number) => xs.slice(0, n).map((x) => redact(x).slice(0, len));

export interface ModelRecord {
  ref: string;
  type: Evidence["type"];
  title: string;
  skills: string[];
  workPerformed: string[];
  equipment: string[];
  status: string;
}
export interface ModelRequirement {
  ref: string;
  text: string;
  /** Deterministic task check, so the model explains it rather than re-deciding it. */
  taskCheck: { connector: string; parts: { task: string; status: string; recordRefs: string[] }[] } | null;
  recordRefs: string[];
}
export interface ModelInput {
  requirements: ModelRequirement[];
  records: ModelRecord[];
}
export interface RefMap {
  requirementByRef: Map<string, Plan>;
  evidenceByRef: Map<string, Evidence>;
  allowed: Map<string, Set<string>>; // requirement ref -> record refs supplied for it
}

export function buildModelInput(plans: Plan[]): { input: ModelInput; refs: RefMap } {
  const evRef = new Map<string, string>();
  const evidenceByRef = new Map<string, Evidence>();
  const records: ModelRecord[] = [];
  const refOf = (e: Evidence) => {
    let r = evRef.get(e.id);
    if (!r) {
      r = `E${evRef.size + 1}`;
      evRef.set(e.id, r);
      evidenceByRef.set(r, e);
      const d = e.structuredData;
      records.push({
        ref: r,
        type: e.type,
        title: redact(e.title).slice(0, 200),
        skills: clipList(d.skills, 12, 120),
        workPerformed: clipList(d.activities, 12, 200),
        equipment: clipList(d.equipment, 8, 80),
        status: STATUS_LABEL[e.verificationStatus],
      });
    }
    return r;
  };
  const requirementByRef = new Map<string, Plan>();
  const allowed = new Map<string, Set<string>>();
  const requirements = plans
    .filter((p) => p.mode === "ai")
    .map((p, i) => {
      const ref = `Q${i + 1}`;
      requirementByRef.set(ref, p);
      const recordRefs = p.records.map(refOf);
      allowed.set(ref, new Set(recordRefs));
      const taskCheck = p.breakdown
        ? {
            connector: p.breakdown.connector,
            parts: p.breakdown.parts.map((x) => ({ task: x.label, status: x.status, recordRefs: x.evidenceIds.map((id) => evRef.get(id)).filter((r): r is string => !!r && recordRefs.includes(r)) })),
          }
        : null;
      return { ref, text: p.requirement.originalText.slice(0, 600), taskCheck, recordRefs };
    });
  return { input: { requirements, records }, refs: { requirementByRef, evidenceByRef, allowed } };
}

/* ------------------------------------------------------------------ */
/* Output validation                                                   */
/* ------------------------------------------------------------------ */

export interface ModelItem {
  ref: string;
  noRelatedEvidence: boolean;
  /** Refs of supplied records the model judges related. The model never describes them (see quoteRecord). */
  related: string[];
  unclear: string[];
  nextStep: string;
}

const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n) : "");

export function parseModelItems(raw: unknown): ModelItem[] | null {
  const items = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return null;
  return items.slice(0, 60).map((o) => {
    const x = (o ?? {}) as Record<string, unknown>;
    return {
      ref: clean(x.ref, 10),
      noRelatedEvidence: x.noRelatedEvidence === true,
      related: (Array.isArray(x.related) ? x.related : []).slice(0, 10).map((r) => clean(typeof r === "string" ? r : (r as Record<string, unknown>)?.evidenceRef, 10)),
      unclear: (Array.isArray(x.unclear) ? x.unclear : []).slice(0, 8).map((u) => clean(u, 300)).filter(Boolean),
      nextStep: clean(x.nextStep, 500),
    };
  });
}

const UNCLEAR: Record<Exclude<TaskBreakdown["parts"][number]["status"], "documented">, string> = {
  assisted: "assisted or observed only",
  checked_only: "the record mentions checking or verifying it, not performing it",
  by_others: "done by someone else, according to the record",
  negated: "the record says it was not done",
  summary_only: "mentioned only in a record's summary",
  not_found: "not stated in any related record",
};

function deterministic(p: Plan, kind: RequirementExplanation["kind"], nextStep: string | null): RequirementExplanation {
  return {
    requirementId: p.requirement.id,
    kind,
    asks: null,
    related: [],
    unclear: p.breakdown ? p.breakdown.parts.flatMap((x) => (x.status === "documented" ? [] : [`${x.label}: ${UNCLEAR[x.status]}`])).slice(0, 8) : [],
    nextStep,
    breakdown: p.breakdown,
    clarification: p.clarification,
    stale: false,
    withheld: null,
  };
}

/** Items for plans that never go to the model. */
export function deterministicItem(p: Plan): RequirementExplanation {
  if (p.mode === "eligibility") {
    const item = deterministic(p, "eligibility", null);
    item.related = p.records.map((e) => ({ evidenceId: e.id, evidenceVersion: e.version, evidenceTitle: e.title.slice(0, 300), documents: "Shown for context only (task wording in this record)." }));
    return item;
  }
  if (p.mode === "no_related") return deterministic(p, "no_related", NO_RELATED_STEP);
  return deterministic(p, "ai_unavailable", AI_UNAVAILABLE_STEP);
}

/**
 * Merge model output into explanation items. The WHOLE AI item is withheld (deterministic content shown instead,
 * with the reason recorded) when it cites any record not supplied for that line, says nothing relates while citing
 * records, cites nothing valid while saying records relate, or any of its text fails a grounding rule
 * (grounding.ts). Record descriptions are always quoted from the records, never AI-written. The deterministic
 * limitations of the task check are always listed first under "unclear", so they cannot be dropped.
 */
export function validateModelItems(items: ModelItem[] | null, refs: RefMap): { explanations: RequirementExplanation[]; rejectedReferences: number } {
  let rejected = 0;
  const byRef = new Map<string, ModelItem>();
  for (const it of items ?? []) if (refs.requirementByRef.has(it.ref) && !byRef.has(it.ref)) byRef.set(it.ref, it);

  const withhold = (p: Plan, reason: Withheld): RequirementExplanation => ({ ...deterministicItem(p), withheld: reason });
  const explanations = [...refs.requirementByRef.entries()].map(([qref, p]) => {
    const it = byRef.get(qref);
    if (!it || !it.nextStep) return withhold(p, "missing");
    const allowed = refs.allowed.get(qref)!;
    const unknown = it.related.filter((r) => !allowed.has(r));
    if (unknown.length) {
      rejected += unknown.length;
      return withhold(p, "unknown_reference");
    }
    const cited = [...new Set(it.related)];
    if (it.noRelatedEvidence ? cited.length > 0 : cited.length === 0) return withhold(p, "inconsistent");
    for (const t of [it.nextStep, ...it.unclear]) {
      const problem = groundingProblem(t, p.records, p.requirement.originalText);
      if (problem) return withhold(p, problem);
    }
    const base = deterministic(p, "no_related", null);
    const unclear = dedupeUnclear(p, base.unclear, it.unclear, it.nextStep);
    if (it.noRelatedEvidence) return { ...base, nextStep: it.nextStep, unclear };
    const related: RelatedRecord[] = cited.slice(0, 5).flatMap((r) => {
      const e = refs.evidenceByRef.get(r)!;
      const documents = quoteRecord(e, p.requirement.originalText);
      return documents ? [{ evidenceId: e.id, evidenceVersion: e.version, evidenceTitle: e.title.slice(0, 300), documents }] : [];
    });
    if (!related.length) return withhold(p, "inconsistent");
    return { ...base, kind: "ai" as const, related, unclear, nextStep: it.nextStep };
  });
  return { explanations, rejectedReferences: rejected };
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Unclear points: the task check's limitations first (always kept), then AI points that add something. An AI point
 * is dropped when it names a task the task check already lists, repeats another point, or repeats the next step.
 */
export function dedupeUnclear(p: Plan, base: string[], ai: string[], nextStep: string): string[] {
  const covered = new Set(p.breakdown?.parts.filter((x) => x.status !== "documented").map((x) => x.id) ?? []);
  const seen = new Set([...base.map(key), key(nextStep)]);
  const out = [...base];
  for (const u of ai) {
    const k = key(u);
    if (!k || seen.has(k) || tasksIn(u).some((t) => covered.has(t.id))) continue;
    seen.add(k);
    out.push(u);
  }
  return out.slice(0, 8);
}

export type Withheld = GroundingProblem | "unknown_reference" | "inconsistent" | "missing";
