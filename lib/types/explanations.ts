/**
 * "Related evidence — AI-assisted explanation". A SEPARATE layer from the checked assessment: it never changes an
 * assessment, a verification status or any count. Stored per match run (server-only table match_run_explanations).
 */
import { z } from "zod";

const Id = z.string().uuid();
const Text = (n: number) => z.string().max(n);

/** What the record's own wording shows for one part of a work-task requirement (deterministic, never AI). */
export const TaskPartStatus = z.enum([
  "documented", // stated in the record's title, skills or work performed, affirmatively
  "assisted", // the record says the person assisted, helped or observed
  "checked_only", // the record says the person checked or verified it (e.g. "verified refrigerant charge"), not performed it
  "by_others", // the record says someone else did it ("done by another crew")
  "negated", // the record says it was not done
  "summary_only", // mentioned only in the record's free-text summary or equipment list
  "not_found", // no related record mentions it
]);
export type TaskPartStatus = z.infer<typeof TaskPartStatus>;

export const TaskPart = z.object({
  id: Text(60),
  label: Text(120),
  status: TaskPartStatus,
  /** Records whose wording gave this status (current, owned records only). */
  evidenceIds: z.array(Id).max(10),
});
export type TaskPart = z.infer<typeof TaskPart>;

export const TaskBreakdown = z.object({
  /** "all": every part is asked for (and / commas). "any": alternatives (or). "single": one recognised task. */
  connector: z.enum(["all", "any", "single"]),
  parts: z.array(TaskPart).min(1).max(12),
  /** True when the line also has wording no task term covers; that wording is not checked. */
  uncoveredWording: z.boolean(),
  /** e.g. "Brazing documented; pressure testing and refrigerant charging not established." */
  sentence: Text(600),
});
export type TaskBreakdown = z.infer<typeof TaskBreakdown>;

export const RelatedRecord = z.object({
  evidenceId: Id,
  /** The record version the explanation was written from. */
  evidenceVersion: z.number().int().positive(),
  evidenceTitle: Text(300),
  /** Quoted from the record's own title, skills, work performed or equipment (never AI-written, never the summary). */
  documents: Text(500),
});
export type RelatedRecord = z.infer<typeof RelatedRecord>;

export const ExplanationKind = z.enum([
  "ai", // AI-assisted explanation with validated record references
  "no_related", // no related current record was found; nothing positive is said
  "eligibility", // duration, driving, physical, work authorization, …: clarification only, never inferred
  "ai_unavailable", // the AI step failed or was rejected; only the deterministic parts are shown
]);
export type ExplanationKind = z.infer<typeof ExplanationKind>;

export const RequirementExplanation = z.object({
  requirementId: Id,
  kind: ExplanationKind,
  /** AI-written plain-language restatement of the requirement. */
  asks: Text(500).nullable(),
  related: z.array(RelatedRecord).max(5),
  /** Parts that remain unsupported or unclear. */
  unclear: z.array(Text(300)).max(8),
  /** A practical next step (AI-written for kind "ai"; fixed text otherwise). */
  nextStep: Text(500).nullable(),
  /** Deterministic task breakdown, when the line names recognised work tasks. */
  breakdown: TaskBreakdown.nullable(),
  /** Fixed text for eligibility conditions: what would need clarifying. */
  clarification: Text(800).nullable(),
  /** Set at read time when a cited record has changed since the explanation was written. */
  stale: z.boolean().default(false),
  /** Why the AI text for this line was withheld (deterministic content shown instead); null when not withheld. */
  withheld: z
    .enum(["unknown_reference", "inconsistent", "missing", "reference_in_text", "worker_claim", "fulfilment_claim", "contradicts_records"])
    .nullable()
    .default(null),
});
export type RequirementExplanation = z.infer<typeof RequirementExplanation>;

export const RunExplanations = z.object({
  runId: Id,
  status: z.enum(["processing", "completed", "failed"]),
  /** "ok" = AI step succeeded; "failed" = deterministic content only; "skipped" = nothing needed the AI. */
  aiStatus: z.enum(["ok", "failed", "skipped"]),
  /** References the AI gave that did not match a supplied record, and were therefore removed. */
  rejectedReferences: z.number().int().nonnegative(),
  generatedAt: z.string(),
  /** False when the run is no longer current (records changed): kept for reference, never shown as current. */
  current: z.boolean().default(true),
  items: z.array(RequirementExplanation).max(60),
});
export type RunExplanations = z.infer<typeof RunExplanations>;

export const ExplainRunRequest = z.object({ runId: Id });
