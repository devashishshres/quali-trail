/** "Your next steps": derived from real evaluator output and from result strings saved by older runs. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Evidence, Requirement, RequirementResult } from "@/lib/types";
import { evaluateRequirement, type Candidate } from "@/lib/server/matching/evaluate";
import { analyzeRequirement } from "@/lib/server/opportunities/requirement-rules";
import { nextSteps, NO_FLOWS, type NextStep } from "@/lib/next-steps";

const TODAY = "2026-11-15";
const AT = "2026-11-15T12:00:00.000+00:00";
const ALL_ON = { customerSignoff: true, supervisorReview: true };
let n = 900;

function ev(over: Partial<Evidence> & { data?: Partial<Evidence["structuredData"]> }): Evidence {
  const { data, ...rest } = over;
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workerId: "a0000000-0000-4000-8000-000000000001",
    type: "work_record",
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
function imported(text: string): Requirement {
  r += 1;
  return {
    id: `c0000000-0000-4000-8000-${String(r).padStart(12, "0")}`,
    opportunityId: "b0000000-0000-4000-8000-000000000001",
    position: r,
    originalText: text,
    mandatory: true,
    criteria: analyzeRequirement(text).criteria,
    source: "Imported job posting",
    priority: "required",
    originalPriority: "required",
    displayText: null,
    category: null,
  };
}
const seeded: Requirement = {
  id: "c0000000-0000-4000-8000-000000000999",
  opportunityId: "b0000000-0000-4000-8000-000000000001",
  position: 1,
  originalText: "Documented hands-on experience installing and starting up residential heat-pump systems.",
  mandatory: true,
  criteria: { acceptedTypes: ["work_record", "checklist"], supportingTypes: ["training"], keywords: ["startup", "start-up", "install", "operational test"], retrievalQuery: "q", requiredFields: ["date"] },
  source: "Demo",
};
const c = (e: Evidence, s: number | null = 0.8): Candidate => ({ evidence: e, memorySimilarity: s });
const evalr = (req: Requirement, cs: Candidate[]) => evaluateRequirement(req, cs, TODAY);
const kinds = (s: NextStep[]) => s.map((x) => x.kind);

const all: NextStep[] = []; // every step produced below, for the language guard
const steps = (res: RequirementResult, flows = NO_FLOWS) => {
  const out = nextSteps(res, flows);
  all.push(...out);
  return out;
};

describe("one step per actual reason", () => {
  it("documentation found → no step", () => {
    const res = evalr(imported("EPA 608 Universal certification"), [c(ev({ type: "certification", title: "EPA 608 Universal certification" }))]);
    expect(res.assessment).toBe("evidence_found");
    expect(steps(res)).toEqual([]);
  });

  it("no record → upload one already held, linking to My Evidence", () => {
    const res = evalr(imported("NATE certification"), []);
    expect(res.assessment).toBe("no_sufficient_evidence");
    const s = steps(res);
    expect(kinds(s)).toEqual(["upload"]);
    expect(s[0].text).toMatch(/If you already hold a document/);
    expect(s[0].links).toEqual([{ href: "/evidence", label: "Go to My Evidence" }]);
  });

  it("right kind of record with work not stated → clarify, linking to that record", () => {
    const rec = ev({ title: "Heat pump install and startup job", data: { activities: [] } });
    const res = evalr(seeded, [c(rec)]);
    expect(res.assessment).toBe("needs_review");
    const s = steps(res);
    expect(s.map((x) => x.kind)).toContain("clarify");
    const step = s.find((x) => x.kind === "clarify")!;
    expect(step.text).toMatch(/^“Heat pump install and startup job” doesn't state a description of the work performed.*If you did this work, edit the record to add or clarify the work performed\.$/);
    expect(step.links).toEqual([{ href: `/evidence#evidence-${rec.id}`, label: "Open “Heat pump install and startup job”" }]);
  });

  it("appropriate but self-reported work → upload or request confirmation; nothing is sent", () => {
    const rec = ev({ verificationStatus: "self_reported", title: "Heat pump install and startup", data: { activities: ["Installed heat pump", "Started up heat pump"] } });
    const res = evalr(seeded, [c(rec)]);
    expect(res.assessment).toBe("needs_review");
    const on = steps(res, ALL_ON);
    expect(kinds(on)).toEqual(["confirm"]);
    expect(on[0].text).toMatch(/ask a supervisor to review it or ask the customer to acknowledge it from the record's page\. Nothing is sent until you fill in and submit a request there\./);
    expect(on[0].links).toEqual([{ href: `/evidence#evidence-${rec.id}`, label: "Open “Heat pump install and startup”" }]);
    // Flows switched off: the step never points at a flow that is not there.
    const off = steps(res, NO_FLOWS);
    expect(off[0].text).not.toMatch(/supervisor|customer|request/);
    expect(steps(res, { customerSignoff: false, supervisorReview: true })[0].text).toMatch(/ask a supervisor to review it from/);
  });

  it("self-reported certificate → upload only (confirmation panels exist for work records and checklists)", () => {
    const res = evalr(imported("NATE certification"), [c(ev({ type: "certification", verificationStatus: "self_reported", title: "NATE certification" }))]);
    const s = steps(res, ALL_ON);
    expect(kinds(s)).toEqual(["confirm"]);
    expect(s[0].text).not.toMatch(/supervisor|customer/);
  });

  it("terms only in the summary → clarify the work performed", () => {
    const recovery: Requirement = { ...seeded, id: "c0000000-0000-4000-8000-000000000998", originalText: "Refrigerant recovery experience", criteria: { acceptedTypes: ["work_record"], supportingTypes: [], keywords: ["recovery"], retrievalQuery: "q", requiredFields: [] } };
    const rec = ev({ title: "Residential service visit", data: { activities: ["Serviced outdoor unit"], summary: "Included refrigerant recovery." } });
    const res = evalr(recovery, [c(rec)]);
    expect(res.assessment).toBe("needs_review");
    expect(res.missingDocumentation).toEqual([]); // ambiguity is stored as an uncertainty only
    const s = steps(res);
    expect(kinds(s)).toEqual(["clarify"]);
    expect(s[0].text).toMatch(/“Residential service visit” mentions this only in its summary/);
    expect(s[0].links[0].href).toBe(`/evidence#evidence-${rec.id}`);
  });

  it("only an expired record → upload, mentioning a renewed version", () => {
    const res = evalr(imported("NATE certification"), [c(ev({ type: "certification", title: "NATE certification", data: { expirationDate: "2024-01-01" } }))]);
    expect(res.explanation).toMatch(/expired or invalid/);
    expect(steps(res)[0].text).toMatch(/renewed, upload the current version/);
  });

  it("multi-part line: each part gets its own step with its label", () => {
    const install = ev({ title: "Residential heat pump installation", data: { activities: ["Installed residential heat pump"] } });
    const res = evalr(imported("Experience installing and starting up heat pumps"), [c(install)]);
    expect(res.assessment).not.toBe("evidence_found");
    const s = steps(res);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.part !== null)).toBe(true);
    expect(s.some((x) => x.kind === "clarify" && /start up/.test(x.text))).toBe(true);
  });

  it("the same step for several parts is shown once, naming both parts", () => {
    const rec = ev({ verificationStatus: "self_reported", title: "Heat pump install and startup", data: { activities: ["Installed heat pump", "Started up heat pump"] } });
    const res = evalr(imported("Experience installing and starting up heat pumps"), [c(rec)]);
    expect(res.missingDocumentation.filter((m) => m.endsWith("independent confirmation for this record"))).toHaveLength(2);
    const s = steps(res, ALL_ON);
    expect(kinds(s)).toEqual(["confirm"]);
    expect(s[0].part?.split(", ")).toHaveLength(2);
    expect(s[0].links).toHaveLength(1);
  });

  it.each(["3+ years installing heat pumps", "Valid driver's license", "EPA 608 or equivalent"])("unsupported line %s → manual clarification quoting the stored reason", (text) => {
    const res = evalr(imported(text), [c(ev({ title: "Heat pump install", data: { activities: ["Installed heat pump"] } }))]);
    const s = steps(res, ALL_ON);
    expect(kinds(s)).toEqual(["manual_review"]);
    expect(s[0].text).toContain(res.uncertainties[0]);
    expect(s[0].text).toMatch(/ask the employer to clarify/);
    expect(s[0].links).toEqual([]);
  });
});

describe("results saved by older runs (stored strings, no codes)", () => {
  const base = { requirementId: "c0000000-0000-4000-8000-000000000001", originalText: "x", mandatory: true, connections: [], explanation: "", uncertainties: [] as string[] };

  it("older template strings map to the same steps", () => {
    const old: RequirementResult = {
      ...base,
      assessment: "needs_review",
      missingDocumentation: [
        "A record that directly documents: EPA 608 Universal certification",
        '"Old job sheet" does not state a date.',
        "A supporting document or independent confirmation for this record",
        "Heat pump startup: A record that directly documents: Heat pump startup",
      ],
    };
    expect(steps(old).map((s) => [s.kind, s.part])).toEqual([
      ["upload", null],
      ["clarify", null],
      ["confirm", null],
      ["upload", "Heat pump startup"],
    ]);
  });

  it("an unrecognised stored message is shown as written, not interpreted", () => {
    const s = steps({ ...base, assessment: "no_sufficient_evidence", missingDocumentation: ["Some older wording"] });
    expect(s[0].text).toMatch(/^Some older wording /);
  });

  it("the evaluator still writes exactly the templates older runs stored", () => {
    expect(evalr(imported("NATE certification"), []).missingDocumentation).toEqual(["A record that directly documents: NATE certification"]);
    const self = evalr(seeded, [c(ev({ verificationStatus: "self_reported", title: "T", data: { activities: ["Installed heat pump", "Started up heat pump"] } }))]);
    expect(self.missingDocumentation).toEqual(["A supporting document or independent confirmation for this record"]);
    const inc = evalr(seeded, [c(ev({ title: "Heat pump job", date: null, data: { activities: ["Installed heat pump", "Started up heat pump"] } }))]);
    expect(inc.missingDocumentation).toEqual(['"Heat pump job" does not state a date.']);
  });
});

describe("guardrails", () => {
  it("no step implies missing ability, predicts hiring or suggests courses", () => {
    expect(all.length).toBeGreaterThan(15);
    for (const s of all) {
      expect(s.text).not.toMatch(/\b(lack|lacks|lacking|unqualified|not qualified|incapable|unable|you (?:don't|do not|can't|cannot) (?:have|do))\b/i);
      expect(s.text).not.toMatch(/\b(course|class|enrol|enroll|hire|hiring|chance|likely|score|percent)\b/i);
    }
  });

  it("the guidance module makes no calls: it imports only types", () => {
    const src = readFileSync("lib/next-steps.ts", "utf8");
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(['import type { EvidenceConnection, RequirementResult } from "@/lib/types";']);
    expect(src).not.toMatch(/fetch\(|gemini|supermemory|tinyfish/i);
  });
});
