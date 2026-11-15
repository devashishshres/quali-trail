/**
 * Regression fixtures for the accuracy problems found in the first live test. SYNTHETIC records shaped like the
 * fictional test technician's (no real data, no stored AI text): rejected AI wording is never retained, so these
 * cases rebuild the failure from the requirement wording and record shape only.
 */
import { describe, expect, it } from "vitest";
import type { Evidence, Requirement } from "@/lib/types";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";
import { buildModelInput, dedupeUnclear, plan, validateModelItems, type ModelItem } from "@/lib/server/explanations/analysis";
import { groundingProblem, quoteRecord, relevantExcerpts } from "@/lib/server/explanations/grounding";
import { recordTaskStatus, taskBreakdown, TASK_TERMS } from "@/lib/server/explanations/tasks";

let n = 0;
function rec(title: string, d: { activities?: string[]; skills?: string[]; equipment?: string[]; summary?: string | null }, over: Partial<Evidence> = {}): Evidence {
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workerId: "a0000000-0000-4000-8000-000000000001",
    type: "work_record",
    title,
    date: "2025-03-01",
    issuer: null,
    structuredData: { skills: d.skills ?? [], activities: d.activities ?? [], equipment: d.equipment ?? [], expirationDate: null, credentialNumber: null, summary: d.summary ?? null },
    sourceKind: "seed",
    sourceAvailable: true,
    verificationStatus: "self_reported",
    indexStatus: "indexed",
    indexError: null,
    isSynthetic: true,
    version: 1,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    ...over,
  };
}
let r = 0;
function req(text: string): Requirement {
  r += 1;
  return { id: `c0000000-0000-4000-8000-${String(r).padStart(12, "0")}`, opportunityId: "b0000000-0000-4000-8000-000000000001", position: r, originalText: text, mandatory: false, criteria: analyzeRequirement(text).criteria, source: "Imported job posting", priority: "unspecified", originalPriority: "unspecified", displayText: null, category: null };
}
const term = (id: string) => TASK_TERMS.find((t) => t.id === id)!;

// Shaped like the live records: a commissioning record whose charge was VERIFIED, and an install record.
const commissioning = rec("Synthetic heat pump commissioning visit", {
  skills: ["Heat pump commissioning"],
  activities: ["Verified refrigerant charge by superheat/subcooling", "Checked airflow and static pressure"],
  summary: "Synthetic summary with customer details",
});
const install = rec(
  "Synthetic heat pump install",
  { skills: ["Heat pump installation", "Brazing"], activities: ["Brazed line set", "Pressure tested with nitrogen", "Evacuated to 500 microns", "Started up the system"] },
  { verificationStatus: "document_supplied" },
);
const both = [commissioning, install];
const cands = both.map((e) => ({ evidence: e, memorySimilarity: 0.9 })); // memory similarity is HIGH for everything

const LIVE = {
  diagrams: "Ability to read wiring diagrams, equipment specifications, and installation instructions",
  team: "Ability to work independently and as part of an installation team",
  diagnose: "Ability to diagnose and solve installation-related issues independently",
  serviceTitan: "ServiceTitan knowledge preferred",
  electrical: "Solid understanding of HVAC electrical systems, controls, and low-voltage wiring",
  mechanical: "Strong mechanical ability and attention to detail",
  tasks: "Proficiency with brazing, pressure testing, evacuation, refrigerant charging, and system start-up",
};

describe("charging: a verified or checked charge is not charging performed", () => {
  it.each([
    [["Verified refrigerant charge by superheat/subcooling"], "checked_only"],
    [["Checked the refrigerant charge"], "checked_only"],
    [["Measured refrigerant charge at startup"], "checked_only"],
    [["Refrigerant charge was verified"], "checked_only"],
    [["Refrigerant charge check after repair"], "checked_only"],
    [["Charged the system with refrigerant"], "documented"],
    [["Recharged refrigerant after leak repair"], "documented"],
    [["Assisted with refrigerant charging"], "assisted"],
    [["Observed refrigerant charging"], "assisted"],
    [["Did not charge refrigerant on this visit"], "negated"],
    [["Refrigerant charging was done by another crew"], "by_others"],
  ])("%j → %s", (activities, status) => expect(recordTaskStatus(term("refrigerant_charging"), rec("x", { activities }))).toBe(status));

  it("the live task line states the limitation and does not count charging as documented", () => {
    const b = taskBreakdown(LIVE.tasks, both)!;
    const charging = b.parts.find((p) => p.id === "refrigerant_charging")!;
    expect(charging.status).toBe("checked_only");
    expect(b.sentence).toMatch(/refrigerant charging: the record mentions checking or verifying it, not performing it/);
    expect(b.parts.filter((p) => p.status === "documented").map((p) => p.id)).toEqual(["brazing", "pressure_testing", "evacuation", "startup"]);
  });

  it("AI text saying charging was done is rejected; naming the check limitation is allowed", () => {
    expect(groundingProblem("Refrigerant charging was carried out on the commissioning visit", both, LIVE.tasks)).toBe("contradicts_records");
    expect(groundingProblem("Refrigerant charging is listed as checked or verified only", both, LIVE.tasks)).toBeNull();
    expect(groundingProblem("Refrigerant charging is described as checking or verifying it, not performing it", both, LIVE.tasks)).toBeNull();
    // A sentence whose subject is the records stays a claim about them (strict by design).
    expect(groundingProblem("The record mentions checking the charge", both, LIVE.tasks)).toBe("worker_claim");
  });

  it("masking the limitation wording does not let fulfilment claims through", () => {
    expect(groundingProblem("Brazing is confirmed by the install", both, LIVE.tasks)).toBe("fulfilment_claim");
    expect(groundingProblem("This line is verified", both, LIVE.tasks)).toBe("fulfilment_claim");
    expect(groundingProblem("Only verified work counts here and it is satisfied", both, LIVE.tasks)).toBe("fulfilment_claim");
  });
});

describe("relevance comes from the record's own permitted fields, never from memory similarity or a title alone", () => {
  it.each([LIVE.serviceTitan, LIVE.electrical, LIVE.mechanical])("%s: nothing relates despite high similarity", (text) => {
    expect(both.flatMap((e) => relevantExcerpts(e, text))).toEqual([]);
    expect(plan(req(text), cands).mode).toBe("no_related");
  });

  it.each([LIVE.team, LIVE.diagrams, LIVE.diagnose])("%s: 'installation' used as a modifier does not relate an install record", (text) => {
    expect(quoteRecord(install, text)).toBeNull();
    expect(plan(req(text), cands).records).not.toContain(install);
  });

  it("the task line relates both records through their own wording, quoted with the field name", () => {
    const p = plan(req(LIVE.tasks), cands);
    expect(p.records.map((e) => e.id).sort()).toEqual([commissioning.id, install.id].sort());
    expect(quoteRecord(install, LIVE.tasks)).toMatch(/^Work performed: "Brazed line set"; Work performed: "Pressure tested with nitrogen"; Work performed: "Evacuated to 500 microns" \(document supplied by you\)\.$/);
    expect(quoteRecord(commissioning, LIVE.tasks)).not.toMatch(/summary|customer/i);
  });
});

describe("repeating the employer's wording is not an ability judgement; judging ability still is", () => {
  it.each([
    [LIVE.diagrams, "Ability to read wiring diagrams is not stated in these records"],
    [LIVE.team, "Ability to work independently is not stated"],
    [LIVE.diagnose, "It is unclear whether the records describe diagnosing installation-related issues"],
    [LIVE.mechanical, "Strong mechanical ability and attention to detail are not described in the records"],
  ])("%s: %j is allowed", (requirementText, text) => expect(groundingProblem(text, both, requirementText)).toBeNull());

  it.each([
    [LIVE.mechanical, "Strong mechanical ability is evident from the install record"],
    [LIVE.diagrams, "You are able to read wiring diagrams"],
    [LIVE.team, "The technician is experienced working on an installation team"],
    [LIVE.electrical, "You lack low-voltage wiring experience"],
  ])("%s: %j is still withheld", (requirementText, text) => expect(groundingProblem(text, both, requirementText)).not.toBeNull());
});

describe("unclear points are not duplicated", () => {
  const p = plan(req(LIVE.tasks), cands);
  const base = ["refrigerant charging: the record mentions checking or verifying it, not performing it"];

  it("drops AI points that repeat a task the check lists, repeat each other, or repeat the next step", () => {
    const next = "Add refrigerant charging to the record if you did it";
    const out = dedupeUnclear(p, base, ["Refrigerant charging is listed as checked only", "Line set length is not stated", "line set length is not stated.", "Add refrigerant charging to the record if you did it."], next);
    expect(out).toEqual([...base, "Line set length is not stated"]);
  });

  it("validated output keeps the check's limitation once, first", () => {
    const { refs } = buildModelInput([p]);
    const item: ModelItem = { ref: "Q1", noRelatedEvidence: false, related: ["E2"], unclear: ["Refrigerant charging is listed as checked or verified only"], nextStep: "Add refrigerant charging to the record if you did it." };
    const x = validateModelItems([item], refs).explanations[0];
    expect(x.withheld).toBeNull();
    expect(x.unclear.filter((u) => /charging/i.test(u))).toHaveLength(1);
    expect(x.unclear[0]).toBe(base[0]);
  });
});
