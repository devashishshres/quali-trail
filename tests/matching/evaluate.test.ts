import { describe, expect, it } from "vitest";
import { RequirementResult, type Evidence, type Requirement } from "@/lib/types";
import { evaluateRequirement, type Candidate } from "@/lib/server/matching/evaluate";
import {
  DEMO_EVIDENCE,
  DEMO_OPPORTUNITY,
  DEMO_REQUIREMENTS,
  DEMO_WORKER,
  REQUIREMENT_SOURCE,
} from "@/supabase/seed/demo-data";

const TODAY = "2026-11-14";
const AT = "2026-11-14T17:00:00.000+00:00";

const reqs: Requirement[] = DEMO_REQUIREMENTS.map((r) => ({
  ...r,
  opportunityId: DEMO_OPPORTUNITY.id,
  source: REQUIREMENT_SOURCE,
}));
const [R1, R2, R3, R4] = reqs;

function fromDemo(i: number): Evidence {
  const d = DEMO_EVIDENCE[i];
  return {
    id: d.id,
    workerId: DEMO_WORKER.id,
    type: d.type,
    title: d.title,
    date: d.date,
    issuer: d.issuer,
    structuredData: d.structuredData,
    sourceKind: d.sourceKind,
    sourceAvailable: false,
    verificationStatus: d.verificationStatus,
    indexStatus: "indexed",
    indexError: null,
    isSynthetic: true,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  };
}
const [E1, E2, E3, E4] = [0, 1, 2, 3].map(fromDemo);

let n = 100;
/** Build a synthetic record for a test. Test data only. */
function ev(over: Partial<Evidence> & { data?: Partial<Evidence["structuredData"]> }): Evidence {
  const { data, ...rest } = over;
  n += 1;
  return {
    ...E3,
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ...rest,
    structuredData: { ...E3.structuredData, skills: [], activities: [], equipment: [], summary: null, credentialNumber: null, ...data },
  };
}
const cand = (evidence: Evidence, memorySimilarity: number | null = null): Candidate => ({ evidence, memorySimilarity });
const run = (r: Requirement, cs: Candidate[]) => evaluateRequirement(r, cs, TODAY);

const checklist = (over: Parameters<typeof ev>[0] = {}) =>
  ev({
    type: "checklist",
    title: "Heat-pump commissioning checklist — residential install",
    date: "2026-11-12",
    issuer: "Desert Air Mechanical (fictional employer)",
    verificationStatus: "document_supplied",
    data: { activities: ["Verified refrigerant charge by subcooling", "Confirmed airflow per ton"], equipment: ["3-ton heat pump"] },
    ...over,
  });

describe("seeded demo scenario", () => {
  it("R1 EPA 608: supplied Universal card is evidence_found", () => {
    const r = run(R1, [cand(E3, 0.88)]);
    expect(r.assessment).toBe("evidence_found");
    expect(r.connections).toHaveLength(1);
    expect(r.connections[0]).toMatchObject({ evidenceId: E3.id, role: "direct", memorySimilarity: 0.88 });
  });

  it("R2 manufacturer training is evidence_found", () => {
    expect(run(R2, [cand(E1, 0.8)]).assessment).toBe("evidence_found");
  });

  it("R3 experience: self-reported startup record is needs_review, training is only supporting", () => {
    const r = run(R3, [cand(E2, 0.79), cand(E1, 0.58)]);
    expect(r.assessment).toBe("needs_review");
    expect(r.connections.find((c) => c.evidenceId === E2.id)?.role).toBe("direct");
    expect(r.connections.find((c) => c.evidenceId === E1.id)?.role).toBe("supporting");
    expect(r.missingDocumentation.join(" ")).toMatch(/installation/i);
    expect(r.missingDocumentation.length).toBeGreaterThan(0);
  });

  it("R4 without a checklist: no_sufficient_evidence, related records only supporting", () => {
    const r = run(R4, [cand(E2, 0.71), cand(E4, 0.64)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections.every((c) => c.role === "supporting")).toBe(true);
    expect(r.missingDocumentation.length).toBeGreaterThan(0);
  });

  it("R4 after a real commissioning checklist is added: evidence_found", () => {
    const r = run(R4, [cand(checklist(), 0.9), cand(E2, 0.71), cand(E4, 0.64)]);
    expect(r.assessment).toBe("evidence_found");
    expect(r.connections[0].role).toBe("direct");
  });

  it("a commissioning checklist title mentioning install does not prove hands-on installation and startup", () => {
    const uploaded = checklist();
    const result = run(R3, [cand(E2, 0.79), cand(uploaded, 0.91)]);
    expect(result.assessment).toBe("needs_review");
    expect(result.connections.find((c) => c.evidenceId === uploaded.id)?.role).toBe("supporting");
  });

  it("startup-only supplied documentation still needs installation evidence", () => {
    const record = ev({ type: "work_record", title: "Heat pump startup", date: "2026-11-12", issuer: "Fictional employer", verificationStatus: "document_supplied", data: { activities: ["Performed heat pump startup"] } });
    const result = run(R3, [cand(record, 0.9)]);
    expect(result.assessment).toBe("needs_review");
    expect(result.missingDocumentation.join(" ")).toMatch(/installation/);
  });

  it("every result satisfies the RequirementResult contract", () => {
    for (const [req, cs] of [[R1, [cand(E3)]], [R3, [cand(E2), cand(E1)]], [R4, [cand(E2)]]] as const) {
      expect(RequirementResult.safeParse(run(req, [...cs])).success).toBe(true);
    }
  });
});

describe("relevant vs unrelated evidence", () => {
  it("an unrelated record of an accepted type is dropped, not linked", () => {
    const forklift = ev({ type: "training", title: "Forklift operator safety course", data: { skills: ["Forklift operation"] } });
    const r = run(R2, [cand(forklift)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections).toHaveLength(0);
  });

  it("a record of an unlisted type is dropped even with high similarity", () => {
    const note = ev({ type: "experience_note", title: "Heat pump training notes", data: { summary: "manufacturer heat pump course" } });
    expect(run(R2, [cand(note, 0.95)]).connections).toHaveLength(0);
  });

  it("a generic checklist never establishes the commissioning requirement", () => {
    const generic = ev({ type: "checklist", title: "Shop closing checklist", date: "2026-10-01", issuer: "Shop", data: { activities: ["Locked doors"] } });
    const r = run(R4, [cand(generic, 0.6)]);
    expect(r.assessment).not.toBe("evidence_found");
    expect(r.connections.every((c) => c.role !== "direct")).toBe(true);
  });

  it("a commissioning checklist for something other than a heat pump does not qualify", () => {
    const boiler = checklist({ title: "Boiler commissioning checklist", data: { activities: ["Checked gas pressure"], equipment: ["Boiler"] } });
    expect(run(R4, [cand(boiler, 0.7)]).assessment).not.toBe("evidence_found");
  });

  it("a checklist that never mentions commissioning is only supporting", () => {
    const c = checklist({ title: "Heat-pump installation checklist", data: { activities: ["Mounted unit"], equipment: ["heat pump"] } });
    const r = run(R4, [cand(c)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections[0].role).toBe("supporting");
  });

  it("a commissioning checklist with no described work is needs_review", () => {
    const empty = checklist({ data: { activities: [], equipment: ["heat pump"] } });
    const r = run(R4, [cand(empty)]);
    expect(r.assessment).toBe("needs_review");
    expect(r.missingDocumentation.join(" ")).toMatch(/work performed/);
  });

  it("high retrieval similarity alone cannot make an accepted-type record evidence_found", () => {
    const unrelated = ev({ type: "training", title: "Annual toolbox talk", issuer: "Employer", date: "2026-01-01", data: { summary: "General safety refresher for crews" } });
    const r = run(R2, [cand(unrelated, 0.97)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections).toHaveLength(0); // wrong subject: dropped despite the score
  });

  it("terms found only in secondary text are ambiguous: needs_review, not ignored", () => {
    const secondary = ev({ type: "training", title: "Annual toolbox talk", issuer: "Employer", date: "2026-01-01", data: { summary: "Refresher for heat pump crews" } });
    const r = run(R2, [cand(secondary, 0.7)]);
    expect(r.assessment).toBe("needs_review");
    expect(r.uncertainties.join(" ")).toMatch(/summary or secondary/);
  });

  it("clear evidence in grounded activities is recognised even when the title is vague", () => {
    const vagueTitle = ev({ type: "work_record", title: "Job 4417 service record", date: "2026-05-02", issuer: "Employer", verificationStatus: "document_supplied", data: { activities: ["Installed the residential heat pump", "Performed heat pump startup", "Ran operational test"] } });
    expect(run(R3, [cand(vagueTitle, 0.6)]).assessment).toBe("evidence_found");
  });
});

describe("credential rules", () => {
  it("self-reported credential is needs_review, never evidence_found", () => {
    const self = ev({ ...E3, verificationStatus: "self_reported" });
    expect(run(R1, [cand(self)]).assessment).toBe("needs_review");
  });

  it("expired by stated date is not counted", () => {
    const old = ev({ title: "EPA Section 608 Universal", data: { expirationDate: "2020-01-01" } });
    const r = run(R1, [cand(old)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections).toHaveLength(0);
    expect(r.uncertainties.join(" ")).toMatch(/expiry date/);
  });

  it("marked expired_or_invalid is not counted", () => {
    const bad = ev({ ...E3, verificationStatus: "expired_or_invalid" });
    const r = run(R1, [cand(bad)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections).toHaveLength(0);
  });

  it("no stated expiry is never treated as expired", () => {
    expect(run(R1, [cand(E3)]).assessment).toBe("evidence_found");
  });

  it("wrong scope (Type I) does not satisfy a Type II / Universal requirement", () => {
    const t1 = ev({ title: "EPA Section 608 Technician Certification — Type I" });
    const r = run(R1, [cand(t1)]);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.connections.every((c) => c.role === "supporting")).toBe(true);
  });

  it("Type II is accepted and is not confused with Type I", () => {
    const t2 = ev({ title: "EPA Section 608 Technician Certification — Type II" });
    expect(run(R1, [cand(t2)]).assessment).toBe("evidence_found");
  });

  it("unstated scope is needs_review", () => {
    const vague = ev({ title: "EPA Section 608 Technician Certification" });
    const r = run(R1, [cand(vague)]);
    expect(r.assessment).toBe("needs_review");
    expect(r.missingDocumentation.join(" ")).toMatch(/scope/);
  });

  it("missing issuer or date is needs_review when the requirement relies on it", () => {
    expect(run(R1, [cand(ev({ ...E3, issuer: null }))]).assessment).toBe("needs_review");
    expect(run(R2, [cand(ev({ ...E1, date: null }))]).assessment).toBe("needs_review");
  });
});

describe("verification stays separate from assessment", () => {
  it("copies verification status through unchanged and never upgrades it", () => {
    for (const status of ["self_reported", "document_supplied", "pending_review"] as const) {
      const r = run(R1, [cand(ev({ ...E3, verificationStatus: status }))]);
      expect(r.connections[0].verificationStatus).toBe(status);
    }
  });

  it("a supplied document is evidence_found yet flagged as not independently reviewed", () => {
    const r = run(R1, [cand(E3)]);
    expect(r.assessment).toBe("evidence_found");
    expect(r.uncertainties.join(" ")).toMatch(/not been independently reviewed/);
  });

  it("an independently confirmed record carries no 'not reviewed' warning", () => {
    const r = run(R1, [cand(ev({ ...E3, verificationStatus: "independently_confirmed" }))]);
    expect(r.assessment).toBe("evidence_found");
    expect(r.uncertainties.join(" ")).not.toMatch(/not been independently reviewed/);
  });
});

describe("duplicates", () => {
  it("links a record once and keeps the higher similarity", () => {
    const r = run(R1, [cand(E3, 0.4), cand(E3, 0.88), cand(E3, null)]);
    expect(r.connections).toHaveLength(1);
    expect(r.connections[0].memorySimilarity).toBe(0.88);
  });

  it("no candidates is no_sufficient_evidence with a missing-documentation note", () => {
    const r = run(R1, []);
    expect(r.assessment).toBe("no_sufficient_evidence");
    expect(r.missingDocumentation).toHaveLength(1);
  });
});
