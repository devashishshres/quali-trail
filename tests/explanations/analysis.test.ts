/** Planning, minimal model input and output validation. Fictional data. */
import { describe, expect, it } from "vitest";
import type { Evidence, Requirement } from "@/lib/types";
import { RequirementExplanation } from "@/lib/types/explanations";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";
import { buildModelInput, claimsUpgrade, plan, redact, stubSimilarity, validateModelItems, type ModelItem } from "@/lib/server/explanations/analysis";

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
  const ok = (over: Partial<ModelItem> = {}): ModelItem => ({ ref: "Q1", asks: "Brazing and pressure testing work.", noRelatedEvidence: false, related: [{ evidenceRef: "E1", documents: "Lists brazing a line set." }], unclear: ["Pressure testing is not stated."], nextStep: "Add pressure testing to the record if you did it.", ...over });
  const run = (items: ModelItem[]) => validateModelItems(items, refs);

  it("accepts supplied references and keeps the deterministic breakdown alongside", () => {
    const { explanations, rejectedReferences } = run([ok()]);
    expect(rejectedReferences).toBe(0);
    expect(explanations[0]).toMatchObject({ kind: "ai", related: [{ evidenceId: brazing.id, evidenceVersion: 2, evidenceTitle: brazing.title }] });
    expect(explanations[0].breakdown!.parts.map((p) => p.status)).toEqual(["documented", "not_found"]);
    expect(explanations.every((x) => RequirementExplanation.safeParse(x).success)).toBe(true);
  });

  it("rejects unknown, cross-requirement and duplicate references and counts them", () => {
    const { explanations, rejectedReferences } = run([ok({ related: [{ evidenceRef: "E1", documents: "ok" }, { evidenceRef: "E99", documents: "invented" }, { evidenceRef: "E2", documents: "belongs to Q2" }, { evidenceRef: "E1", documents: "dup" }] })]);
    expect(rejectedReferences).toBe(3);
    expect(explanations[0].related.map((x) => x.evidenceId)).toEqual([brazing.id]);
  });

  it("an item citing nothing valid falls back to deterministic content", () => {
    const { explanations } = run([ok({ related: [{ evidenceRef: "E99", documents: "invented" }] })]);
    expect(explanations[0].kind).toBe("ai_unavailable");
    expect(explanations[0].asks).toBeNull();
    expect(explanations[0].breakdown).not.toBeNull();
  });

  it.each(["You meet this requirement.", "The technician is qualified for this.", "This is a verified record.", "You are eligible.", "This proves the skill."])("rejects upgrade claim: %s", (claim) => {
    expect(run([ok({ asks: claim })]).explanations[0].kind).toBe("ai_unavailable");
    expect(run([ok({ related: [{ evidenceRef: "E1", documents: claim }] })]).explanations[0].kind).toBe("ai_unavailable");
  });

  it("allows saying something is NOT verified", () => {
    expect(claimsUpgrade("This record is self-reported and has not been independently verified.")).toBe(false);
    expect(claimsUpgrade("It is unverified.")).toBe(false);
  });

  it("noRelatedEvidence → no_related; missing or unknown items → deterministic", () => {
    const { explanations } = run([ok({ ref: "Q2", noRelatedEvidence: true, related: [], nextStep: "Ask the employer." }), ok({ ref: "Q7" })]);
    expect(explanations.find((x) => x.requirementId === b.requirement.id)!.kind).toBe("no_related");
    expect(explanations.find((x) => x.requirementId === a.requirement.id)!.kind).toBe("ai_unavailable");
    expect(run(null as unknown as ModelItem[]).explanations.every((x) => x.kind === "ai_unavailable")).toBe(true);
  });
});
