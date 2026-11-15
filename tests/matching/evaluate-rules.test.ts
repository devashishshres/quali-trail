/** Imported requirements: routing by rule. Seeded requirements (no rule) are covered by evaluate.test.ts. */
import { describe, expect, it } from "vitest";
import { RequirementResult, type Evidence, type Requirement } from "@/lib/types";
import { evaluateRequirement, type Candidate } from "@/lib/server/matching/evaluate";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";

const TODAY = "2026-11-14";
const AT = "2026-11-14T17:00:00.000+00:00";
let n = 500;

function ev(over: Partial<Evidence> & { data?: Partial<Evidence["structuredData"]> }): Evidence {
  const { data, ...rest } = over;
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workerId: "a0000000-0000-4000-8000-000000000001",
    type: "certification",
    title: "Record",
    date: "2025-01-01",
    issuer: "Fictional issuer",
    structuredData: { skills: [], activities: [], equipment: [], expirationDate: null, credentialNumber: null, summary: null, ...data },
    sourceKind: "seed",
    sourceAvailable: true,
    verificationStatus: "document_supplied",
    indexStatus: "indexed",
    indexError: null,
    isSynthetic: true,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...rest,
  };
}

let r = 0;
function imported(text: string, manualReview = false): Requirement {
  r += 1;
  return {
    id: `c0000000-0000-4000-8000-${String(r).padStart(12, "0")}`,
    opportunityId: "b0000000-0000-4000-8000-000000000001",
    position: r,
    originalText: text,
    mandatory: true,
    criteria: analyzeRequirement(text, { manualReview }).criteria,
    source: "Imported job posting",
    priority: "required",
    originalPriority: "required",
    displayText: null,
    category: null,
  };
}
const c = (evidence: Evidence, s: number | null = 0.8): Candidate => ({ evidence, memorySimilarity: s });
const run = (req: Requirement, cs: Candidate[]) => {
  const out = evaluateRequirement(req, cs, TODAY);
  expect(RequirementResult.safeParse(out).success).toBe(true);
  return out;
};

const universal = ev({ title: "EPA Section 608 Technician Certification — Universal" });
const typeI = ev({ title: "EPA Section 608 Technician Certification — Type I" });
const unscoped = ev({ title: "EPA 608 certification card" });
const nate = ev({ title: "NATE Core and Heat Pump Installation" });
const install = ev({ type: "work_record", title: "Heat pump installation — residential job", data: { activities: ["Installed 3-ton heat pump", "Brazed line set"] } });
const startup = ev({ type: "work_record", title: "Heat pump startup record", data: { activities: ["Started up heat pump and ran operational test"] } });
const notInstalled = ev({ type: "work_record", title: "Heat pump service visit", data: { activities: ["Did not install heat pump; inspection only"] } });

describe("supported rules", () => {
  it("EPA 608 Type II accepts a Universal card (Universal covers Type II)", () => {
    expect(run(imported("EPA 608 Type II certification"), [c(universal)]).assessment).toBe("evidence_found");
  });

  it("EPA 608 Type II does NOT accept a Type I card or an unscoped card", () => {
    const a = run(imported("EPA 608 Type II certification"), [c(typeI)]);
    expect(a.assessment).not.toBe("evidence_found");
    const b = run(imported("EPA 608 Type II certification"), [c(unscoped)]);
    expect(b.assessment).toBe("needs_review");
    expect(b.missingDocumentation.join(" ")).toMatch(/type ii/);
  });

  it("EPA 608 Universal does NOT accept a Type II-only card (no lenient legacy scope)", () => {
    const typeII = ev({ title: "EPA 608 Type II certification" });
    expect(run(imported("EPA 608 Universal certification"), [c(typeII)]).assessment).toBe("needs_review");
  });

  it("all-of: install AND startup each need their own record; one part is not the whole", () => {
    const req = imported("Experience installing and starting up heat pumps");
    const one = run(req, [c({ ...install, verificationStatus: "document_supplied" })]);
    expect(one.assessment).toBe("needs_review"); // never evidence_found from the install part alone
    expect(one.missingDocumentation.join(" ")).toMatch(/startup work: .*does not state "start up"/i);
    const both = run(req, [c(install), c(startup)]);
    expect(both.assessment).toBe("evidence_found"); // both parts documented by supplied records
    expect(both.explanation).toMatch(/2 parts/);
  });

  it("compound credentials take the weakest part", () => {
    const req = imported("EPA 608 Universal and NATE certification");
    expect(run(req, [c(universal)]).assessment).toBe("no_sufficient_evidence");
    expect(run(req, [c(universal), c(nate)]).assessment).toBe("evidence_found");
  });

  it("negated activities never satisfy a term group", () => {
    const req = imported("Heat pump installation experience");
    expect(run(req, [c({ ...notInstalled, verificationStatus: "document_supplied" })]).assessment).not.toBe("evidence_found");
  });

  it("a record links once even when it serves two parts", () => {
    const both = ev({ type: "work_record", verificationStatus: "document_supplied", title: "Heat pump install and startup", data: { activities: ["Installed heat pump", "Started up heat pump"] } });
    const out = run(imported("Heat pump installation and startup experience"), [c(both)]);
    expect(out.connections).toHaveLength(1);
    expect(out.assessment).toBe("evidence_found");
  });
});

describe("cannot_assess", () => {
  it.each(["3+ years installing heat pumps", "Valid driver's license", "EPA 608 or equivalent", "Strong communication skills"])("%s", (text) => {
    const out = run(imported(text), [c(universal), c(install)]);
    expect(out.assessment).toBe("cannot_assess");
    expect(out.missingDocumentation).toEqual([]);
    expect(out.connections.every((x) => x.role === "supporting")).toBe(true);
    expect(out.explanation).toMatch(/Not assessed automatically/);
  });

  it("partial context shows related records but does not decide", () => {
    const out = run(imported("EPA 608 Universal and 2 years of experience"), [c(universal)]);
    expect(out.assessment).toBe("cannot_assess");
    expect(out.connections.map((x) => x.evidenceId)).toEqual([universal.id]);
    expect(out.connections[0].role).toBe("supporting");
    expect(out.explanation).toMatch(/does not decide/);
  });

  it("technician's manual-review mark forces cannot_assess even for supported wording", () => {
    expect(run(imported("EPA 608 Universal certification", true), [c(universal)]).assessment).toBe("cannot_assess");
  });
});
