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

  // Regression: any "no/not/never/without" anywhere in an activity used to discard the WHOLE activity, so valid work
  // with an unrelated negation ("no leaks", "never needed a callback") stopped counting.
  describe("negation applies only to the work it negates", () => {
    const docd = (activities: string[], title = "Fictional service job") => ev({ type: "work_record", verificationStatus: "document_supplied", title, data: { activities } });

    it.each([
      ["Installed residential heat pump, no leaks found"],
      ["Installed residential heat pump with no leaks"],
      ["Installed residential heat pump without any callbacks"],
    ])("scope term still stated: %s", (activity) => {
      expect(run(imported("Residential heat pump installation experience"), [c(docd([activity]))]).assessment).toBe("evidence_found");
    });

    it("startup still documented when the same activity says a callback was never needed", () => {
      const r = docd(["Installed heat pump", "Started up heat pump, never needed a callback"], "Heat pump install and startup");
      expect(run(imported("Heat pump installation and startup experience"), [c(r)]).assessment).toBe("evidence_found");
    });

    it.each([
      ["Did not install residential heat pump; inspection only"],
      ["Didn't install the residential heat pump, inspection only"],
      ["Residential heat pump was not installed"],
      ["No residential heat pump work"],
    ])("negated work still never counts: %s", (activity) => {
      expect(run(imported("Residential heat pump installation experience"), [c(docd([activity], "Fictional visit"))]).assessment).not.toBe("evidence_found");
    });

    it("negated startup still missing even when installation is affirmed", () => {
      const r = docd(["Installed heat pump", "Startup wasn't performed, done later"], "Heat pump install");
      expect(run(imported("Heat pump installation and startup experience"), [c(r)]).assessment).not.toBe("evidence_found");
    });
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

/*
 * Regression for the install-and-startup discrepancy seen while writing these tests. The evaluator never
 * returned evidence_found for install-only evidence. One test expectation was wrong: it expected
 * no_sufficient_evidence, but a work record of the right type that lacks startup is "needs_review" (a person
 * should check). The other assertion used two document-supplied records, so evidence_found was correct there.
 * This pins the rule: install-only evidence can NEVER produce evidence_found for an install-AND-startup line.
 */
describe("regression: install-only evidence vs an installation-and-startup requirement", () => {
  const wordings = [
    "Experience installing and starting up heat pumps",
    "Documented hands-on experience installing and starting up residential heat-pump systems.",
    "Heat pump installation and startup experience",
    "Hands-on experience with heat pump installation and start-up",
  ];
  const installOnly = (status: Evidence["verificationStatus"]) =>
    ev({
      type: "work_record",
      verificationStatus: status,
      title: "Residential heat pump installation",
      data: { activities: ["Installed residential heat pump", "Mounted outdoor unit", "Brazed line set"], summary: "Installation completed; startup was done by another crew." },
    });

  it.each(wordings)("%s", (text) => {
    const r = analyzeRequirement(text).rule;
    expect(r.kind === "supported" && r.conditions.map((c) => c.id)).toEqual(expect.arrayContaining(["hp_install", "hp_startup"]));
    for (const status of ["self_reported", "document_supplied", "pending_review", "independently_confirmed"] as const) {
      for (const sim of [null, 0.99]) {
        const out = run(imported(text), [c(installOnly(status), sim)]);
        expect(out.assessment, `${status} / similarity ${sim}`).not.toBe("evidence_found");
        expect(out.missingDocumentation.join(" ")).toMatch(/start up/i);
      }
    }
  });

  it("the same record plus a separate startup record does reach evidence_found when both are documented", () => {
    const startupDoc = ev({ type: "work_record", verificationStatus: "document_supplied", title: "Residential heat pump startup", data: { activities: ["Started up residential heat pump", "Ran operational test"] } });
    expect(run(imported(wordings[1]), [c(installOnly("document_supplied")), c(startupDoc)]).assessment).toBe("evidence_found");
  });

  it("the seeded requirement (no rule, legacy path) also refuses install-only evidence", () => {
    const seeded: Requirement = {
      id: "c0000000-0000-4000-8000-000000000003",
      opportunityId: "b0000000-0000-4000-8000-000000000001",
      position: 2,
      originalText: "Documented hands-on experience installing and starting up residential heat-pump systems.",
      mandatory: true,
      criteria: { acceptedTypes: ["work_record", "checklist"], supportingTypes: ["training"], keywords: ["startup", "start-up", "install", "operational test"], retrievalQuery: "q", requiredFields: ["date"] },
      source: "Demo",
    };
    const out = run(seeded, [c(installOnly("independently_confirmed"))]);
    expect(out.assessment).not.toBe("evidence_found");
    expect(out.missingDocumentation.join(" ")).toMatch(/startup work performed/);
  });
});
