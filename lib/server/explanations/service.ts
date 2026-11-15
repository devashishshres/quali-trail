/**
 * Generate "Related evidence — AI-assisted explanation" for one SAVED match run. Infrastructure comes in as ports.
 *
 * Never touches requirement_results, evidence_matches, verification or counts: it only writes its own row.
 *   1. claim the run's explanation row (one generation per run; a failed one may be retried a few times)
 *   2. for each cannot_assess line: worker-scoped memory search, resolved against CURRENT owned, indexed records
 *   3. deterministic plan per line (eligibility / no related / task breakdown)
 *   4. ONE batched model call for the lines that have related records, within the remaining budget
 *   5. validate (unknown references rejected), save. A model failure keeps every deterministic part.
 */
import type { Evidence, MatchRun, Opportunity } from "@/lib/types";
import type { RunExplanations } from "@/lib/types/explanations";
import { resolveCandidates } from "../matching/candidates";
import { MemorySearchError, type MemoryHit } from "../memory/types";
import { buildModelInput, deterministicItem, plan, validateModelItems, type ModelInput, type ModelItem, type Plan } from "./analysis";

export const EXPLAIN_BUDGET_MS = 90_000;
export const SEARCH_TIMEOUT_MS = 10_000;
export const MAX_EXPLAINED_LINES = 20;
const SEARCH_CONCURRENCY = 3;

export type ClaimResult = { kind: "claimed" } | { kind: "existing"; explanations: RunExplanations } | { kind: "busy" } | { kind: "exhausted" } | { kind: "limited" } | { kind: "not_found" };

export interface ExplainPorts {
  claim(runId: string): Promise<ClaimResult>;
  search(query: string): Promise<MemoryHit[]>;
  propose(input: ModelInput, budgetMs: number): Promise<{ items: ModelItem[] | null; model: string | null }>;
  save(runId: string, data: Omit<RunExplanations, "runId" | "status" | "generatedAt">, model: string | null): Promise<RunExplanations>;
  fail(runId: string, code: string): Promise<void>;
  now(): number;
}

export type ExplainOutcome =
  | { kind: "done"; explanations: RunExplanations }
  | { kind: "refused"; code: "stale_run" | "busy" | "exhausted" | "limited" | "memory_unavailable"; message: string };

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new MemorySearchError("search timed out")), ms))]);

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]);
      }
    }),
  );
  return out;
}

export async function explainRun(ports: ExplainPorts, args: { run: MatchRun; opportunity: Opportunity; evidence: Evidence[] }): Promise<ExplainOutcome> {
  const { run, opportunity, evidence } = args;
  if (run.status !== "completed") return { kind: "refused", code: "stale_run", message: "These results are out of date. Run matching again, then ask for explanations." };

  const claim = await ports.claim(run.id);
  if (claim.kind === "existing") return { kind: "done", explanations: claim.explanations };
  if (claim.kind === "busy") return { kind: "refused", code: "busy", message: "Explanations for these results are already being prepared. Try again in a moment." };
  if (claim.kind === "limited") return { kind: "refused", code: "limited", message: "You've reached today's limit for AI-assisted explanations. Your checked results are unchanged." };
  if (claim.kind === "not_found") return { kind: "refused", code: "stale_run", message: "These results are out of date. Run matching again, then ask for explanations." };
  if (claim.kind === "exhausted") return { kind: "refused", code: "exhausted", message: "Explanations couldn't be prepared for these results. Run matching again to try once more." };

  const started = ports.now();
  try {
    const assessed = new Map(run.results.map((r) => [r.requirementId, r.assessment]));
    const lines = opportunity.requirements.filter((q) => assessed.get(q.id) === "cannot_assess").slice(0, MAX_EXPLAINED_LINES);
    const owned = new Map(evidence.map((e) => [e.id, e]));

    const searched = await mapLimit(lines, SEARCH_CONCURRENCY, async (q) => {
      try {
        const hits = await withTimeout(ports.search(q.originalText.slice(0, 300)), SEARCH_TIMEOUT_MS);
        return { ok: true as const, candidates: resolveCandidates(hits, owned).candidates };
      } catch (e) {
        if (!(e instanceof MemorySearchError)) throw e;
        return { ok: false as const, candidates: [] };
      }
    });
    if (lines.length && searched.every((s) => !s.ok)) {
      await ports.fail(run.id, "memory_unavailable");
      return { kind: "refused", code: "memory_unavailable", message: "Related records couldn't be searched right now. Your checked results are unchanged. Try again shortly." };
    }

    const plans: Plan[] = lines.map((q, i) => plan(q, searched[i].candidates));
    const { input, refs } = buildModelInput(plans);
    let aiStatus: RunExplanations["aiStatus"] = "skipped";
    let modelItems: ModelItem[] | null = null;
    let model: string | null = null;
    if (input.requirements.length) {
      try {
        const remaining = EXPLAIN_BUDGET_MS - (ports.now() - started) - 5_000;
        const r = await ports.propose(input, remaining);
        modelItems = r.items;
        model = r.model;
        aiStatus = r.items ? "ok" : "failed";
      } catch {
        aiStatus = "failed"; // deterministic content below is kept as is
      }
    }
    const { explanations: aiItems, rejectedReferences } = aiStatus === "ok" ? validateModelItems(modelItems, refs) : { explanations: plans.filter((p) => p.mode === "ai").map(deterministicItem), rejectedReferences: 0 };
    const byReq = new Map(aiItems.map((x) => [x.requirementId, x]));
    const items = plans.map((p) => byReq.get(p.requirement.id) ?? deterministicItem(p));
    // A line whose search failed is shown honestly rather than as "nothing related".
    lines.forEach((q, i) => {
      if (!searched[i].ok) {
        const it = items[i];
        it.kind = it.kind === "eligibility" ? it.kind : "ai_unavailable";
        it.clarification = [it.clarification, "Related records couldn't be searched for this line."].filter(Boolean).join(" ");
      }
    });
    return { kind: "done", explanations: await ports.save(run.id, { aiStatus, rejectedReferences, items }, model) };
  } catch (e) {
    await ports.fail(run.id, "internal").catch(() => {});
    throw e;
  }
}
