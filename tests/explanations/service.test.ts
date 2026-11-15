/** Orchestration with fake ports: failures keep deterministic content; checked results are never touched. */
import { vi, describe, expect, it } from "vitest";
vi.mock("server-only", () => ({}));
import type { Evidence, MatchRun, Opportunity, Requirement } from "@/lib/types";
import { RunExplanations } from "@/lib/types/explanations";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";
import { EXPLAIN_BUDGET_MS, explainRun, type ExplainPorts } from "@/lib/server/explanations/service";
import { explainWithStub } from "@/lib/server/explanations/model";
import { MemorySearchError } from "@/lib/server/memory/types";
import type { ModelInput } from "@/lib/server/explanations/analysis";

const W = "a0000000-0000-4000-8000-000000000001";
let n = 0;
function rec(title: string, activities: string[], over: Partial<Evidence> = {}): Evidence {
  n += 1;
  return { id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, workerId: W, type: "work_record", title, date: "2025-03-14", issuer: null, structuredData: { skills: [], activities, equipment: [], expirationDate: null, credentialNumber: null, summary: null }, sourceKind: "seed", sourceAvailable: true, verificationStatus: "self_reported", indexStatus: "indexed", indexError: null, isSynthetic: true, version: 1, createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", ...over };
}
let r = 0;
const req = (text: string): Requirement => {
  r += 1;
  return { id: `c0000000-0000-4000-8000-${String(r).padStart(12, "0")}`, opportunityId: "b0000000-0000-4000-8000-000000000001", position: r, originalText: text, mandatory: true, criteria: analyzeRequirement(text).criteria, source: "Imported job posting", priority: "required", originalPriority: "required", displayText: null, category: null };
};

const lines = [
  req("EPA 608 certification required"), // checked line: never explained
  req("Proficiency with brazing, pressure testing, evacuation, refrigerant charging, and system start-up"),
  req("Valid driver's license with an acceptable driving record"),
  req("Ability to read wiring diagrams"),
];
const opportunity = { id: "b0000000-0000-4000-8000-000000000001", title: "Fictional HVAC Installer", requirements: lines } as unknown as Opportunity;
const brazing = rec("Fictional line set job", ["Brazed line set", "Startup was done by another crew"]);
const thermostat = rec("Thermostat swap", ["Replaced thermostat"]);
const evidence = [brazing, thermostat];
const assessments = ["no_sufficient_evidence", "cannot_assess", "cannot_assess", "cannot_assess"] as const;
const run = (status: MatchRun["status"] = "completed") =>
  ({ id: "d0000000-0000-4000-8000-000000000001", workerId: W, opportunityId: opportunity.id, status, evidenceRevision: 3, memoryWarning: null, createdAt: "2026-11-15T00:00:00Z", results: lines.map((q, i) => ({ requirementId: q.id, originalText: q.originalText, mandatory: true, assessment: assessments[i], connections: [], explanation: "x", uncertainties: [], missingDocumentation: [] })) }) as MatchRun;

function fakePorts(over: Partial<ExplainPorts> = {}) {
  const calls = { claim: 0, search: [] as string[], propose: [] as { input: ModelInput; budget: number }[], saved: null as unknown, failed: [] as string[] };
  const ports: ExplainPorts = {
    now: () => 0,
    async claim() {
      calls.claim += 1;
      return { kind: "claimed" };
    },
    async search(q) {
      calls.search.push(q);
      // Retrieval scores depend on the query: the brazing record is close only to the brazing line.
      return evidence.map((e) => ({ evidenceId: e.id, version: e.version, similarity: e === brazing && /brazing/i.test(q) ? 0.7 : 0.3 }));
    },
    async propose(input, budget) {
      calls.propose.push({ input, budget });
      return explainWithStub(input, { jobTitle: "Fictional" });
    },
    async save(runId, d, model) {
      calls.saved = { runId, d, model };
      return RunExplanations.parse({ runId, status: "completed", generatedAt: "2026-11-15T00:00:00Z", ...d });
    },
    async fail(_id, code) {
      calls.failed.push(code);
    },
    ...over,
  };
  return { ports, calls };
}

describe("explainRun", () => {
  it("explains only cannot_assess lines; eligibility never reaches the model; checked results untouched", async () => {
    const { ports, calls } = fakePorts();
    const theRun = run();
    const before = JSON.stringify(theRun);
    const out = await explainRun(ports, { run: theRun, opportunity, evidence });
    expect(out.kind).toBe("done");
    expect(JSON.stringify(theRun)).toBe(before);
    expect(calls.search).toHaveLength(3);
    expect(calls.propose).toHaveLength(1);
    expect(calls.propose[0].input.requirements.map((q) => q.text)).toEqual([lines[1].originalText]); // not the licence, not "wiring diagrams" (nothing related)
    expect(calls.propose[0].budget).toBeLessThanOrEqual(EXPLAIN_BUDGET_MS);
    const x = (out as { explanations: RunExplanations }).explanations;
    expect(x.items.map((i) => i.kind)).toEqual(["ai", "eligibility", "no_related"]);
    expect(x.items[0].breakdown!.sentence).toMatch(/^Brazing documented; startup: done by someone else/);
    expect(x.items[0].related.map((i) => i.evidenceId)).toEqual([brazing.id]);
    expect(x.items.every((i) => !("assessment" in i))).toBe(true);
  });

  it("a stale run is refused before any claim or provider call", async () => {
    const { ports, calls } = fakePorts();
    expect((await explainRun(ports, { run: run("stale"), opportunity, evidence })).kind).toBe("refused");
    expect(calls.claim + calls.search.length + calls.propose.length).toBe(0);
  });

  it("an existing explanation is returned with no provider calls", async () => {
    const existing = RunExplanations.parse({ runId: run().id, status: "completed", aiStatus: "skipped", rejectedReferences: 0, generatedAt: "x", items: [] });
    const { ports, calls } = fakePorts({ claim: async () => ({ kind: "existing", explanations: existing }) });
    expect(await explainRun(ports, { run: run(), opportunity, evidence })).toEqual({ kind: "done", explanations: existing });
    expect(calls.search.length + calls.propose.length).toBe(0);
  });

  it("model failure: deterministic breakdown, eligibility and no-related items are all kept", async () => {
    const { ports } = fakePorts({ propose: async () => Promise.reject(new Error("503")) });
    const x = ((await explainRun(ports, { run: run(), opportunity, evidence })) as { explanations: RunExplanations }).explanations;
    expect(x.aiStatus).toBe("failed");
    expect(x.items.map((i) => i.kind)).toEqual(["ai_unavailable", "eligibility", "no_related"]);
    expect(x.items[0].breakdown!.sentence).toMatch(/^Brazing documented/);
    expect(x.items[0].asks).toBeNull();
  });

  const withHook = async (hook: string) => {
    const { ports } = fakePorts({ propose: (input) => explainWithStub(input, { jobTitle: `Fictional (${hook})` }) });
    return ((await explainRun(ports, { run: run(), opportunity, evidence })) as { explanations: RunExplanations }).explanations;
  };

  it("an unknown record reference withholds that whole explanation and is counted", async () => {
    const x = await withHook("stub:bad-ref");
    expect(x.rejectedReferences).toBe(1);
    expect(x.items[0]).toMatchObject({ kind: "ai_unavailable", withheld: "unknown_reference", related: [] });
    expect(x.items[0].breakdown!.sentence).toMatch(/^Brazing documented/); // deterministic content kept
  });

  it.each([
    ["stub:claim", "fulfilment_claim"],
    ["stub:soft-claim", "worker_claim"],
  ])("%s: an ungrounded claim about the worker is withheld (%s)", async (hook, why) => {
    expect((await withHook(hook)).items[0]).toMatchObject({ kind: "ai_unavailable", withheld: why });
  });

  it("stub:contradict: AI text saying evacuation 'was performed' when no record states it is withheld", async () => {
    const x = await withHook("stub:contradict");
    expect(x.items[0]).toMatchObject({ kind: "ai_unavailable", withheld: "contradicts_records" });
    expect(x.items[0].breakdown!.sentence).toMatch(/startup: done by someone else/);
  });

  it("a clean stub answer is accepted, with quoted record text and the task limitations listed", async () => {
    const x = await withHook("plain");
    expect(x.items[0]).toMatchObject({ kind: "ai", withheld: null });
    // Quotes keep the record's own limitation wording ("by another crew").
    expect(x.items[0].related[0].documents).toBe('Work performed: "Brazed line set"; Work performed: "Startup was done by another crew" (self-reported).');
    expect(x.items[0].unclear).toContain("startup: done by someone else, according to the record");
  });

  it("repeated clicks: while one generation runs, others make no provider calls", async () => {
    const { ports, calls } = fakePorts({ claim: async () => ({ kind: "busy" }) });
    const outs = await Promise.all([1, 2, 3].map(() => explainRun(ports, { run: run(), opportunity, evidence })));
    expect(outs.every((o) => o.kind === "refused")).toBe(true);
    expect(calls.search.length + calls.propose.length).toBe(0);
  });

  it("every search failing: refused, row marked failed, no model call", async () => {
    const { ports, calls } = fakePorts({ search: async () => Promise.reject(new MemorySearchError("down")) });
    const out = await explainRun(ports, { run: run(), opportunity, evidence });
    expect(out).toMatchObject({ kind: "refused", code: "memory_unavailable" });
    expect(calls.failed).toEqual(["memory_unavailable"]);
    expect(calls.propose).toHaveLength(0);
  });

  it("one search failing is shown honestly, never as 'nothing related'", async () => {
    let k = 0;
    const { ports } = fakePorts({ search: async () => (k++ === 2 ? Promise.reject(new MemorySearchError("down")) : evidence.map((e) => ({ evidenceId: e.id, version: e.version, similarity: 0.7 }))) });
    const x = ((await explainRun(ports, { run: run(), opportunity, evidence })) as { explanations: RunExplanations }).explanations;
    expect(x.items[2].kind).toBe("ai_unavailable");
    expect(x.items[2].clarification).toMatch(/couldn't be searched/);
  });

  it("hits for records that are not the worker's, or outdated versions, are never used", async () => {
    const { ports, calls } = fakePorts({
      search: async () => [
        { evidenceId: "e0000000-0000-4000-8000-999999999999", version: 1, similarity: 0.99 },
        { evidenceId: brazing.id, version: 0, similarity: 0.99 },
      ],
    });
    const x = ((await explainRun(ports, { run: run(), opportunity, evidence })) as { explanations: RunExplanations }).explanations;
    expect(calls.propose).toHaveLength(0);
    expect(x.items.map((i) => i.kind)).toEqual(["no_related", "eligibility", "no_related"]);
  });
});

describe("reading a stored explanation (cache per run and record versions)", async () => {
  const { toExplanations } = await import("@/lib/server/explanations/store");
  const item = { requirementId: lines[1].id, kind: "ai", asks: "a", related: [{ evidenceId: brazing.id, evidenceVersion: 1, evidenceTitle: "t", documents: "d" }], unclear: [], nextStep: "n", breakdown: null, clarification: null, stale: false, withheld: null };
  const row = { match_run_id: run().id, status: "completed" as const, ai_status: "ok" as const, rejected_references: 0, items: [item], updated_at: "2026-11-15T00:00:00Z" };
  const versions = new Map(evidence.map((e) => [e.id, e.version]));

  it("current run, unchanged records → current", () => {
    const x = toExplanations(row, versions, true)!;
    expect(x.current).toBe(true);
    expect(x.items[0].stale).toBe(false);
  });
  it("a stale run is never shown as current, even if the cited record did not change", () => {
    const x = toExplanations(row, versions, false)!;
    expect(x.current).toBe(false);
    expect(x.items.every((i) => i.stale)).toBe(true);
  });
  it("a changed or deleted cited record marks it out of date", () => {
    expect(toExplanations(row, new Map([[brazing.id, 2]]), true)!.current).toBe(false);
    const gone = toExplanations(row, new Map(), true)!;
    expect(gone.current).toBe(false);
    expect(gone.items[0].related).toHaveLength(0);
  });
});
