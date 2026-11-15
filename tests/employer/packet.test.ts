/**
 * The employer packet builder decides everything an employer can see. Fictional records only; no network.
 */
import { describe, expect, it } from "vitest";
import { buildPacket, PacketSelectionError, type PacketInputs } from "@/lib/server/employer/packet";
import type { Evidence, MatchRun, Opportunity, WorkerReview } from "@/lib/types";
import { EmployerPacket } from "@/lib/types/employer";

const W = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const R1 = id(1), R2 = id(2), R3 = id(3), UNLINKED = id(4);
const Q1 = id(11), Q2 = id(12);

function ev(eid: string, extra: Partial<Evidence> = {}): Evidence {
  return {
    id: eid, workerId: W, type: "work_record", title: `Fictional job ${eid.slice(-1)}`, date: "2026-10-01", issuer: "Fictional Mechanical",
    structuredData: { skills: ["Brazing"], activities: ["Brazed line set", "Pulled vacuum"], equipment: ["3-ton heat pump"], expirationDate: null,
      credentialNumber: "CRED-SECRET-123", summary: "Installed at 12 Fictional Lane for customer Pat Example, pat@example.com" },
    sourceKind: "pdf_upload", sourceAvailable: true, verificationStatus: "self_reported", indexStatus: "indexed", indexError: null,
    version: 2, createdAt: "2026-10-02T00:00:00Z", ...extra,
  } as Evidence;
}
const conn = (eid: string, role: "direct" | "supporting" = "direct") => ({
  evidenceId: eid, evidenceTitle: "t", evidenceDate: null, evidenceType: "work_record" as const, evidenceIssuer: null,
  verificationStatus: "self_reported" as const, role, contribution: "AI-ish contribution text", relevanceExplanation: "explanation text", memorySimilarity: 0.8,
});
const run: MatchRun = {
  id: id(99), workerId: W, opportunityId: id(98), status: "completed", evidenceRevision: 3, memoryWarning: null, createdAt: "2026-11-01T00:00:00Z",
  results: [
    { requirementId: Q1, originalText: "EPA 608 Universal required", mandatory: true, assessment: "evidence_found", connections: [conn(R1), conn(R2, "supporting")], explanation: "Narrative", uncertainties: ["u"], missingDocumentation: [] },
    { requirementId: Q2, originalText: "Valid driver's licence", mandatory: true, assessment: "cannot_assess", connections: [conn(R3)], explanation: "x", uncertainties: [], missingDocumentation: [] },
  ],
};
const opportunity = {
  id: id(98), title: "Fictional HVAC Installer", employer: "Fictional Air Co", description: "", sourceUrl: "https://jobs.example.com/1", isSynthetic: false,
  requirements: [
    { id: Q1, opportunityId: id(98), position: 0, originalText: "EPA 608 Universal required", mandatory: true, criteria: {}, source: "listing", priority: "required" },
    { id: Q2, opportunityId: id(98), position: 1, originalText: "Valid driver's licence", mandatory: true, criteria: {}, source: "listing", priority: null },
  ],
  importInfo: { importId: id(97), sourceKind: "listing_url", location: "Phoenix, AZ", retrievedAt: null, finalUrl: null, warnings: [], removedCount: 0, editedCount: 0 },
} as unknown as Opportunity;

function review(rid: string, eid: string, extra: Partial<WorkerReview> = {}): WorkerReview {
  return {
    id: rid, evidenceId: eid, evidenceVersion: 2, relationshipId: id(70), status: "confirmed_observed", supervisorName: "Sky Account Name",
    createdAt: "2026-10-05T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", decision: "confirm_observed", observedTasks: ["Brazed line set"],
    comment: "Private supervisor comment", reviewerName: "Sky Reviewer", reviewerOrganization: "Fictional Mech", reviewerTitle: "Lead",
    decidedAt: "2026-10-06T00:00:00Z", ...extra,
  };
}

function inputs(over: Partial<PacketInputs> = {}): PacketInputs {
  return {
    worker: { name: "Alex Test (fictional)", trade: "HVAC", isSynthetic: false },
    opportunity, run,
    evidence: [ev(R1), ev(R2, { sourceAvailable: false }), ev(R3), ev(UNLINKED)],
    customerAcks: [
      { evidenceId: R1, evidenceVersion: 2, status: "acknowledged", deliveryMode: "resend", decidedAt: "2026-10-07T00:00:00Z" },
      { evidenceId: R1, evidenceVersion: 1, status: "acknowledged", deliveryMode: "resend", decidedAt: "2026-09-01T00:00:00Z" }, // older version
      { evidenceId: R2, evidenceVersion: 2, status: "acknowledged", deliveryMode: "mock", decidedAt: null },
    ],
    reviews: [
      review(id(51), R1), // no consent
      review(id(52), R2), // consent
      review(id(53), R1, { status: "declined", decision: "decline", observedTasks: [] }),
      review(id(54), R1, { evidenceVersion: 1 }), // older version
    ],
    consentedReviewIds: new Set([id(52)]),
    now: new Date("2026-11-15T00:00:00Z"),
    ...over,
  };
}
const ALL = { recordIds: [R1, R2, R3], originalIds: [], includeConfirmations: true };

describe("employer packet", () => {
  it("never contains customer details, supervisor comments, summaries, credential numbers or AI narrative", () => {
    const p = buildPacket(inputs(), { ...ALL, originalIds: [R1] });
    expect(EmployerPacket.parse(p)).toEqual(p);
    const text = JSON.stringify(p);
    for (const leak of ["Fictional Lane", "Pat Example", "pat@example.com", "CRED-SECRET-123", "Private supervisor comment", "Sky Account Name",
      "AI-ish contribution", "explanation text", "Narrative"]) expect(text).not.toContain(leak);
  });

  it("names a supervisor only with recorded consent; customers are never named; only current-version confirmations count", () => {
    const p = buildPacket(inputs(), ALL);
    const r1 = p.records.find((r) => r.id === R1)!;
    const r2 = p.records.find((r) => r.id === R2)!;
    expect(r1.confirmations).toEqual([
      { kind: "customer", decidedAt: "2026-10-07T00:00:00Z", simulated: false },
      { kind: "supervisor", basis: "observed", observedTasks: ["Brazed line set"], decidedAt: "2026-10-06T00:00:00Z", reviewer: null },
    ]);
    expect(r2.confirmations).toEqual([
      { kind: "customer", decidedAt: null, simulated: true },
      { kind: "supervisor", basis: "observed", observedTasks: ["Brazed line set"], decidedAt: "2026-10-06T00:00:00Z", reviewer: { name: "Sky Reviewer", organization: "Fictional Mech", title: "Lead" } },
    ]);
    expect(buildPacket(inputs(), { ...ALL, includeConfirmations: false }).records.every((r) => r.confirmations.length === 0)).toBe(true);
  });

  it("unselected records are absent and counted as not shared, without their titles", () => {
    const p = buildPacket(inputs(), { recordIds: [R1], originalIds: [], includeConfirmations: true });
    expect(p.records.map((r) => r.id)).toEqual([R1]);
    expect(p.requirements[0]).toMatchObject({ assessment: "evidence_found", records: [{ ref: "R1", role: "direct" }], notSharedCount: 1, priority: "required" });
    expect(p.requirements[1]).toMatchObject({ records: [], notSharedCount: 1 });
    expect(JSON.stringify(p)).not.toContain("Fictional job 2");
    expect(JSON.stringify(p)).not.toContain(R2);
  });

  it("refuses records outside the report, originals that don't exist or weren't selected, empty selections and stale reports", () => {
    const err = (f: () => unknown) => { try { f(); } catch (e) { return (e as PacketSelectionError).reason; } return null; };
    expect(err(() => buildPacket(inputs(), { ...ALL, recordIds: [R1, UNLINKED] }))).toBe("not_in_report");
    expect(err(() => buildPacket(inputs(), { ...ALL, originalIds: [R2] }))).toBe("no_original"); // R2 has no file
    expect(err(() => buildPacket(inputs(), { recordIds: [R1], originalIds: [R3], includeConfirmations: true }))).toBe("no_original"); // not selected
    expect(err(() => buildPacket(inputs(), { ...ALL, recordIds: [] }))).toBe("no_records");
    expect(err(() => buildPacket(inputs({ run: { ...run, status: "stale" } }), ALL))).toBe("no_report");
  });

  it("is deterministic for the same inputs (preview equals what is stored)", () => {
    expect(buildPacket(inputs(), ALL)).toEqual(buildPacket(inputs(), ALL));
    const p = buildPacket(inputs(), { ...ALL, originalIds: [R1] });
    expect(p.records.map((r) => [r.ref, r.originalShared])).toEqual([["R1", true], ["R2", false], ["R3", false]]);
    expect(p.opportunity).toEqual({ title: "Fictional HVAC Installer", employer: "Fictional Air Co", location: "Phoenix, AZ", sourceUrl: "https://jobs.example.com/1", sourceKind: "listing_url" });
  });
});
