/** Planning, minimal model input and output validation. Fictional data. */
import { describe, expect, it } from "vitest";
import type { Evidence, Requirement } from "@/lib/types";
import { RequirementExplanation } from "@/lib/types/explanations";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";
import { buildModelInput, CLARIFICATION_MAX, CONTEXT_ONLY_NOTE, ELIGIBILITY_TEXT, joinClarification, MORE_CONDITIONS, plan, redact, SEARCH_FAILED_NOTE, stubSimilarity, validateModelItems, type ModelItem } from "@/lib/server/explanations/analysis";

let n = 0;
function rec(title: string, activities: string[], over: Partial<Evidence> & { summary?: string } = {}): Evidence {
  const { summary = null, ...rest } = over;
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workerId: "a0000000-0000-4000-8000-000000000001",
    type: "work_record",
    title,
    date: "2025-03-14",
    issuer: "Fictional Air Co.",
    structuredData: { skills: [], activities, equipment: [], expirationDate: null, credentialNumber: "SECRET-CRED-123", summary },
    sourceKind: "seed",
    sourceAvailable: true,
    verificationStatus: "self_reported",
    indexStatus: "indexed",
    indexError: null,
    isSynthetic: true,
    version: 2,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    ...rest,
  };
}
let r = 0;
function req(text: string): Requirement {
  r += 1;
  return { id: `c0000000-0000-4000-8000-${String(r).padStart(12, "0")}`, opportunityId: "b0000000-0000-4000-8000-000000000001", position: r, originalText: text, mandatory: true, criteria: analyzeRequirement(text).criteria, source: "Imported job posting", priority: "required", originalPriority: "required", displayText: null, category: null };
}
const cand = (e: Evidence, s = 0.8) => ({ evidence: e, memorySimilarity: s });

const brazing = rec("Fictional line set job", ["Brazed line set", "Did not evacuate; reused lines"], { summary: "Customer Jane Roe, 12 Oak Street, jane@example.com" });
const unrelated = rec("Thermostat swap", ["Replaced thermostat"]);

describe("plan", () => {
  it.each(["3+ years of residential HVAC installation experience", "Valid driver's license with an acceptable driving record", "Comfortable working in attics and crawl spaces", "Must be authorized to work in the US"])(
    "eligibility line is never sent to the model: %s",
    (text) => {
      const p = plan(req(text), [cand(brazing), cand(unrelated)]);
      expect(p.mode).toBe("eligibility");
      expect(p.clarification).toBeTruthy();
      expect(p.clarification).not.toMatch(/\byou (?:are|meet|qualify)\b|\beligible\b(?! to)/i);
      expect(buildModelInput([p]).input.requirements).toHaveLength(0);
    },
  );

  it("duration line with a task keeps only task records, as context", () => {
    const p = plan(req("3+ years of residential HVAC installation experience"), [cand(rec("Install", ["Installed heat pump"])), cand(unrelated)]);
    expect(p.records.map((e) => e.title)).toEqual(["Install"]);
    expect(p.clarification).toMatch(/context only; they do not establish this condition/);
  });

  it("no related records → no_related, nothing positive", () => {
    expect(plan(req("Ability to read wiring diagrams"), []).mode).toBe("no_related");
    expect(plan(req("Ability to read wiring diagrams"), [cand(unrelated, 0.2)]).mode).toBe("no_related"); // weak hit, no task
  });

  it("related records → ai, with the deterministic breakdown", () => {
    const p = plan(req("Proficiency with brazing, pressure testing and evacuation"), [cand(brazing, 0.3), cand(unrelated, 0.2)]);
    expect(p.mode).toBe("ai");
    expect(p.records).toEqual([brazing]); // related by task wording despite low similarity; unrelated excluded
    expect(p.breakdown!.sentence).toMatch(/^Brazing documented; evacuation: the record says it was not done; pressure testing not established\.$/);
  });
});

describe("local stub search (isolated tests only)", () => {
  it("scores by distinctive shared wording, ignoring generic words", () => {
    expect(stubSimilarity("Proficiency with brazing and pressure testing", brazing)).toBe(0.6);
    expect(stubSimilarity("Ability to read blueprints and schematics", brazing)).toBe(0.2);
    expect(stubSimilarity("Residential HVAC experience required", unrelated)).toBe(0.2);
  });
});

describe("minimal, redacted model input", () => {
  const p = plan(req("Proficiency with brazing, pressure testing and evacuation"), [cand(rec("Call 480-555-0199 job", ["Brazed at 42 Elm Street for bob@example.com"], { summary: "private summary" }))]);
  const { input } = buildModelInput([p]);
  const sent = JSON.stringify(input);

  it("never sends summaries, credential numbers, ids, versions or worker details", () => {
    expect(sent).not.toMatch(/private summary|SECRET-CRED|credential|summary|e0000000|a0000000|version|workerId|Jane/i);
  });
  it("sends only the minimum record fields: type, title, skills, work performed, equipment, status", () => {
    expect(Object.keys(input.records[0]).sort()).toEqual(["equipment", "ref", "skills", "status", "title", "type", "workPerformed"]);
    expect(sent).not.toMatch(/Fictional Air Co|2025-03|issuer|date/);
  });
  it("redacts emails, phone numbers and street addresses", () => {
    expect(sent).not.toMatch(/480-555-0199|42 Elm Street|bob@example\.com/);
    expect(redact("Call (480) 555-0199 or x@y.co at 7 Main St")).toBe("Call [phone removed] or [email removed] at [address removed]");
  });
  it("uses opaque references and the requirement's own wording", () => {
    expect(input.requirements[0]).toMatchObject({ ref: "Q1", text: "Proficiency with brazing, pressure testing and evacuation", recordRefs: ["E1"] });
    expect(input.records[0].ref).toBe("E1");
    expect(input.requirements[0].taskCheck!.parts.find((x) => x.task === "brazing")).toEqual({ task: "brazing", status: "documented", recordRefs: ["E1"] });
  });
});

describe("validating model output", () => {
  const a = plan(req("Proficiency with brazing and pressure testing"), [cand(brazing)]);
  const b = plan(req("Experience with ductwork or line sets"), [cand(rec("Duct job", ["Installed ductwork"]))]);
  const { refs } = buildModelInput([a, b]); // a: Q1 → E1 ; b: Q2 → E2
  const ok = (over: Partial<ModelItem> = {}): ModelItem => ({ ref: "Q1", noRelatedEvidence: false, related: ["E1"], unclear: ["Pressure testing is not stated"], nextStep: "Add pressure testing to the record if you did it.", ...over });
  const run = (items: ModelItem[]) => validateModelItems(items, refs);
  const first = (items: ModelItem[]) => run(items).explanations.find((x) => x.requirementId === a.requirement.id)!;

  it("accepts supplied references; record descriptions are QUOTED from the record, not AI-written", () => {
    const { explanations, rejectedReferences } = run([ok()]);
    expect(rejectedReferences).toBe(0);
    expect(explanations[0]).toMatchObject({ kind: "ai", withheld: null, related: [{ evidenceId: brazing.id, evidenceVersion: 2, evidenceTitle: brazing.title, documents: 'Work performed: "Brazed line set" (self-reported).' }] });
    expect(explanations[0].breakdown!.parts.map((p) => p.status)).toEqual(["documented", "not_found"]);
    expect(explanations.every((x) => RequirementExplanation.safeParse(x).success)).toBe(true);
  });

  it("the task check's limitations are always listed, whatever the AI wrote under unclear", () => {
    expect(first([ok({ unclear: [] })]).unclear).toEqual(["pressure testing: not stated in any related record"]);
  });

  it.each([
    ["an unknown record", ["E1", "E99"]],
    ["a record supplied for ANOTHER line", ["E1", "E2"]],
  ])("citing %s withholds the WHOLE explanation, not just the reference", (_n, related) => {
    const { explanations, rejectedReferences } = run([ok({ related })]);
    expect(rejectedReferences).toBe(1);
    expect(explanations[0]).toMatchObject({ kind: "ai_unavailable", withheld: "unknown_reference", related: [] });
    expect(explanations[0].nextStep).not.toMatch(/pressure testing to the record/); // the AI's text is gone too
    expect(explanations[0].breakdown).not.toBeNull();
  });

  it("a duplicate of a valid reference is simply merged", () => {
    expect(first([ok({ related: ["E1", "E1"] })]).related).toHaveLength(1);
  });

  it.each([
    ["You satisfy this requirement.", "fulfilment_claim"],
    ["You meet it.", "fulfilment_claim"],
    ["This requirement is satisfied by the line set job.", "fulfilment_claim"],
    ["Your records show you can do this work.", "worker_claim"],
    ["You have brazed and pressure tested many systems.", "worker_claim"],
    ["You are an experienced installer.", "worker_claim"],
    ["You are not experienced with pressure testing.", "worker_claim"], // negative ability judgement
    ["Upload a document, since you are clearly qualified.", "fulfilment_claim"],
    ["Pressure testing was performed on the job.", "contradicts_records"],
    ["Add E1 to your profile.", "reference_in_text"],
  ])("ungrounded next step %j withholds the explanation (%s)", (nextStep, why) => {
    expect(first([ok({ nextStep })])).toMatchObject({ kind: "ai_unavailable", withheld: why });
  });

  it("the same checks apply to every unclear item", () => {
    expect(first([ok({ unclear: ["You did the pressure testing"] })]).withheld).toBe("worker_claim");
    expect(first([ok({ unclear: ["Pressure testing was done on the line set job"] })]).withheld).toBe("contradicts_records");
  });

  it("AI explanations never carry an AI restatement of the requirement", () => {
    expect(first([ok()]).asks).toBeNull();
  });

  it("allows hedged, instructional and negative wording", () => {
    for (const nextStep of [
      "Ask the employer whether brazing alone counts.",
      "Ask the employer to confirm what they accept.",
      "If you did pressure testing, add it to the record's work performed.",
      "Upload a document you already hold, or ask the employer what they accept.",
    ]) expect(first([ok({ nextStep })]).withheld, nextStep).toBeNull();
    expect(first([ok({ unclear: ["It is unclear whether the records show pressure testing", "Pressure testing is not verified"] })]).withheld).toBeNull();
  });

  it("noRelatedEvidence → no_related; contradictory or missing items → deterministic", () => {
    const { explanations } = run([ok({ ref: "Q2", noRelatedEvidence: true, related: [], nextStep: "Ask the employer what they accept." }), ok({ ref: "Q7" })]);
    expect(explanations.find((x) => x.requirementId === b.requirement.id)!.kind).toBe("no_related");
    expect(explanations.find((x) => x.requirementId === a.requirement.id)!).toMatchObject({ kind: "ai_unavailable", withheld: "missing" });
    expect(first([ok({ noRelatedEvidence: true })]).withheld).toBe("inconsistent");
    expect(first([ok({ related: [] })]).withheld).toBe("inconsistent");
    expect(run(null as unknown as ModelItem[]).explanations.every((x) => x.kind === "ai_unavailable")).toBe(true);
  });
});

describe("joinClarification (stored limit)", () => {
  const all = Object.values(ELIGIBILITY_TEXT) as string[];
  it("short text is unchanged", () => {
    expect(joinClarification([all[0], all[0]], [CONTEXT_ONLY_NOTE])).toBe(`${all[0]} ${CONTEXT_ONLY_NOTE}`);
    expect(joinClarification([], [])).toBeNull();
  });
  it("every condition plus both notes still fits; whole sentences only, in order; notes always kept", () => {
    expect(all.join(" ").length).toBeGreaterThan(CLARIFICATION_MAX); // the case that used to fail
    const out = joinClarification(all, [CONTEXT_ONLY_NOTE, SEARCH_FAILED_NOTE])!;
    expect(out.length).toBeLessThanOrEqual(CLARIFICATION_MAX);
    expect(out.endsWith(`${MORE_CONDITIONS} ${CONTEXT_ONLY_NOTE} ${SEARCH_FAILED_NOTE}`)).toBe(true);
    const kept = all.filter((t) => out.includes(t));
    expect(kept.length).toBeGreaterThan(0);
    expect(out.startsWith(kept.join(" "))).toBe(true);
    expect(RequirementExplanation.shape.clarification.safeParse(out).success).toBe(true);
  });
});
