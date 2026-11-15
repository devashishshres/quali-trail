/**
 * The employer packet builder decides everything an employer can see. Fictional records only; no network.
 */
import { describe, expect, it } from "vitest";
import { buildPacket, listCandidates, PacketSelectionError, type Candidates } from "@/lib/server/employer/packet";
import { EmployerPacket } from "@/lib/types/employer";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [JOB_OK, JOB_NAMED, JOB_NONE, CERT, CERT2] = [id(1), id(2), id(3), id(4), id(5)];
const NOW = new Date("2026-11-15T00:00:00Z");

const cands = (): Candidates => ({
  worker: { name: "Alex Test (fictional)", trade: "HVAC", isSynthetic: true },
  work: [
    { id: JOB_OK, version: 2, type: "work_record", title: "Heat-pump install", date: "2026-10-01",
      supervisor: [{ requestId: id(51), basis: "observed", observedTasks: ["Brazed line set"], decidedAt: "2026-10-06T00:00:00Z", reviewer: null }],
      customer: [{ requestId: id(61), decidedAt: "2026-10-07T00:00:00Z", simulated: false, acknowledgedActivities: ["Replaced contactor"] }], withheldCount: 1 },
    { id: JOB_NAMED, version: 1, type: "checklist", title: "Commissioning checklist", date: null,
      supervisor: [{ requestId: id(52), basis: "documents", observedTasks: ["should not appear"], decidedAt: null, reviewer: { name: "Sky Reviewer", organization: "Fictional Mech", title: "Lead" } }],
      customer: [], withheldCount: 0 },
    { id: JOB_NONE, version: 1, type: "work_record", title: "Unconfirmed job", date: null, supervisor: [], customer: [], withheldCount: 2 },
  ],
  certifications: [
    { id: CERT, version: 1, title: "EPA 608 Universal", issuer: "Fictional Institute", date: "2025-01-01", expirationDate: null, verificationStatus: "document_supplied" },
    { id: CERT2, version: 1, title: "NATE Heat Pump", issuer: null, date: null, expirationDate: "2027-01-01", verificationStatus: "independently_confirmed" },
  ],
});
const err = (f: () => unknown) => { try { f(); } catch (e) { return (e as PacketSelectionError).reason; } return null; };

describe("employer packet (confirmed work + certifications only)", () => {
  it("contains only the selected items and only allowed fields", () => {
    const p = buildPacket(cands(), { workIds: [JOB_OK], certificationIds: [CERT], originalIds: [CERT] }, NOW);
    expect(EmployerPacket.parse(p)).toEqual(p);
    expect(Object.keys(p).sort()).toEqual(["certifications", "format", "generatedAt", "isSynthetic", "technician", "work"]);
    expect(p.work.map((w) => w.id)).toEqual([JOB_OK]);
    expect(p.certifications.map((c) => c.id)).toEqual([CERT]);
    expect(Object.keys(p.work[0]).sort()).toEqual(["confirmations", "date", "id", "title", "type", "version"]);
    expect(Object.keys(p.certifications[0]).sort()).toEqual(["date", "expirationDate", "id", "issuer", "originalShared", "title", "verificationStatus", "version"]);
    const text = JSON.stringify(p);
    for (const absent of [JOB_NAMED, JOB_NONE, CERT2, "Commissioning", "NATE", "Unconfirmed job", "requestId"]) expect(text).not.toContain(absent);
  });

  it("names a supervisor only when they allowed it; documents-basis never lists tasks", () => {
    const p = buildPacket(cands(), { workIds: [JOB_OK, JOB_NAMED], certificationIds: [], originalIds: [] }, NOW);
    expect(p.work[0].confirmations).toEqual([
      { kind: "customer", decidedAt: "2026-10-07T00:00:00Z", acknowledgedActivities: ["Replaced contactor"], simulated: false },
      { kind: "supervisor", basis: "observed", observedTasks: ["Brazed line set"], decidedAt: "2026-10-06T00:00:00Z", reviewer: null },
    ]);
    expect(p.work[1].confirmations).toEqual([
      { kind: "supervisor", basis: "documents", observedTasks: [], decidedAt: null, reviewer: { name: "Sky Reviewer", organization: "Fictional Mech", title: "Lead" } },
    ]);
  });

  it("refuses unconfirmed work, unknown items, work originals, originals for unselected certificates, and empty selections", () => {
    expect(err(() => buildPacket(cands(), { workIds: [JOB_NONE], certificationIds: [], originalIds: [] }, NOW))).toBe("not_eligible");
    expect(err(() => buildPacket(cands(), { workIds: [id(99)], certificationIds: [], originalIds: [] }, NOW))).toBe("not_eligible");
    expect(err(() => buildPacket(cands(), { workIds: [], certificationIds: [JOB_OK], originalIds: [] }, NOW))).toBe("not_eligible"); // work passed as a certificate
    expect(err(() => buildPacket(cands(), { workIds: [JOB_OK], certificationIds: [], originalIds: [JOB_OK] }, NOW))).toBe("no_original"); // never a work document
    expect(err(() => buildPacket(cands(), { workIds: [], certificationIds: [CERT], originalIds: [CERT2] }, NOW))).toBe("no_original");
    expect(err(() => buildPacket(cands(), { workIds: [], certificationIds: [], originalIds: [] }, NOW))).toBe("no_items");
  });

  it("certificate originals are off unless separately authorized", () => {
    const p = buildPacket(cands(), { workIds: [], certificationIds: [CERT, CERT2], originalIds: [CERT2] }, NOW);
    expect(p.certifications.map((c) => [c.title, c.originalShared, c.verificationStatus])).toEqual([
      ["EPA 608 Universal", false, "document_supplied"], ["NATE Heat Pump", true, "independently_confirmed"],
    ]);
  });

  it("an extra field from the data layer can't slip into a packet (strict schema)", () => {
    const c = cands();
    (c.certifications[0] as Record<string, unknown>).credentialNumber = "SECRET-123";
    (c.work[0].supervisor[0] as Record<string, unknown>).comment = "private";
    const p = buildPacket(c, { workIds: [JOB_OK], certificationIds: [CERT], originalIds: [] }, NOW);
    expect(JSON.stringify(p)).not.toMatch(/SECRET-123|private/);
    expect(() => EmployerPacket.parse({ ...p, report: {} })).toThrow();
  });

  it("lists candidates with honest counts", () => {
    expect(listCandidates(cands()).work).toEqual([
      { id: JOB_OK, title: "Heat-pump install", date: "2026-10-01", eligible: true, shareableCount: 2, withheldCount: 1 },
      { id: JOB_NAMED, title: "Commissioning checklist", date: null, eligible: true, shareableCount: 1, withheldCount: 0 },
      { id: JOB_NONE, title: "Unconfirmed job", date: null, eligible: false, shareableCount: 0, withheldCount: 2 },
    ]);
  });
});
