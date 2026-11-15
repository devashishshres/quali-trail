import { describe, expect, it } from "vitest";
import type { Evidence, Opportunity, RequirementResult } from "@/lib/types";
import { resolveCandidates } from "@/lib/server/matching/candidates";
import { computeChanges } from "@/lib/server/matching/changes";
import { buildRunPayload } from "@/lib/server/matching/payload";
import { executeMatch, type MatchPorts } from "@/lib/server/matching/run";
import { MemorySearchError, memoryHit } from "./helpers";
import { DEMO_EVIDENCE, DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, DEMO_WORKER, REQUIREMENT_SOURCE } from "@/supabase/seed/demo-data";

const AT = "2026-11-14T17:00:00.000+00:00";
const opportunity: Opportunity = {
  ...DEMO_OPPORTUNITY,
  isSynthetic: true,
  requirements: DEMO_REQUIREMENTS.map((r) => ({ ...r, opportunityId: DEMO_OPPORTUNITY.id, source: REQUIREMENT_SOURCE })),
};
const evidence: Evidence[] = DEMO_EVIDENCE.map((d) => ({
  id: d.id, workerId: DEMO_WORKER.id, type: d.type, title: d.title, date: d.date, issuer: d.issuer,
  structuredData: d.structuredData, sourceKind: d.sourceKind, sourceAvailable: false,
  verificationStatus: d.verificationStatus, indexStatus: "indexed", indexError: null, isSynthetic: true,
  version: 1, createdAt: AT, updatedAt: AT,
}));
const [E1, E2, E3] = evidence;

describe("resolveCandidates", () => {
  const map = new Map(evidence.map((e) => [e.id, e]));

  it("keeps current, indexed, worker-owned records and dedupes by best similarity", () => {
    const r = resolveCandidates([memoryHit(E3.id, 0.4), memoryHit(E3.id, 0.9), memoryHit(E1.id, 0.7)], map);
    expect(r.candidates.map((c) => [c.evidence.id, c.memorySimilarity])).toEqual([[E3.id, 0.9], [E1.id, 0.7]]);
  });

  it("rejects foreign, deleted or invented ids", () => {
    const r = resolveCandidates([memoryHit("f0000000-0000-4000-8000-000000000009", 0.99)], map);
    expect(r.candidates).toHaveLength(0);
    expect(r.rejected[0].reason).toBe("not_found_for_worker");
  });

  it("rejects records whose memory copy is outdated (not indexed after an edit)", () => {
    const edited = new Map(map).set(E2.id, { ...E2, indexStatus: "pending" });
    expect(resolveCandidates([memoryHit(E2.id, 0.8)], edited).rejected[0].reason).toBe("not_indexed");
  });

  it("rejects a hit claiming a newer version than the database has", () => {
    expect(resolveCandidates([memoryHit(E1.id, 0.8, 5)], map).rejected[0].reason).toBe("version_from_future");
  });

  it("an outdated older-version copy is rejected and can never shadow the current one", () => {
    const v2 = new Map(map).set(E1.id, { ...E1, version: 2 });
    const onlyOld = resolveCandidates([memoryHit(E1.id, 0.99, 1)], v2);
    expect(onlyOld.candidates).toHaveLength(0);
    expect(onlyOld.rejected[0].reason).toBe("outdated_version");
    const both = resolveCandidates([memoryHit(E1.id, 0.99, 1), memoryHit(E1.id, 0.6, 2)], v2);
    expect(both.candidates).toHaveLength(1);
    expect(both.candidates[0].memorySimilarity).toBe(0.6); // the current version's score, not the stale 0.99
  });
});

describe("buildRunPayload", () => {
  it("search failure is needs_review with an honest note, never no_sufficient_evidence", () => {
    const outcomes = opportunity.requirements.map((_, i) => (i === 0 ? { ok: false as const } : { ok: true as const, hits: [] }));
    const p = buildRunPayload(opportunity.requirements, outcomes, evidence, "2026-11-14");
    expect(p.results[0].assessment).toBe("needs_review");
    expect(p.results[0].explanation).toMatch(/not a finding that evidence is missing/);
    expect(p.results[1].assessment).toBe("no_sufficient_evidence"); // searched fine, found nothing
    expect(p.memoryWarning).toMatch(/failed for 1 of 4/);
  });

  it("warns about records that are not searchable yet", () => {
    const pending = evidence.map((e, i) => (i === 0 ? { ...e, indexStatus: "pending" as const } : e));
    const p = buildRunPayload(opportunity.requirements, opportunity.requirements.map(() => ({ ok: true as const, hits: [] })), pending, "2026-11-14");
    expect(p.memoryWarning).toMatch(/1 of 4 records are not searchable/);
  });

  it("grounds every connection in database rows, not memory text", () => {
    const outcomes = opportunity.requirements.map((_, i) => ({ ok: true as const, hits: i === 0 ? [memoryHit(E3.id, 0.88)] : [] }));
    const p = buildRunPayload(opportunity.requirements, outcomes, evidence, "2026-11-14");
    expect(p.results[0].connections[0]).toMatchObject({ evidenceId: E3.id, evidenceTitle: E3.title, memorySimilarity: 0.88 });
  });
});

function fakePorts(over: Partial<MatchPorts> & { statuses?: ("completed" | "stale")[] } = {}) {
  const calls: string[] = [];
  const statuses = [...(over.statuses ?? ["completed"])];
  const ports: MatchPorts = {
    today: () => "2026-11-14",
    startRun: async () => (calls.push("start"), { runId: `run-${calls.length}` }),
    loadEvidence: async () => (calls.push("load"), evidence),
    search: async () => (calls.push("search"), []),
    finalize: async () => (calls.push("finalize"), statuses.shift() ?? "completed"),
    fail: async (_id, err) => void calls.push(`fail:${err}`),
    ...over,
  };
  return { ports, calls };
}

describe("executeMatch", () => {
  it("starts the run BEFORE loading evidence, searches per requirement, then finalizes", async () => {
    const { ports, calls } = fakePorts();
    const out = await executeMatch(ports, DEMO_WORKER.id, opportunity);
    expect(out).toMatchObject({ status: "completed" });
    expect(calls.slice(0, 2)).toEqual(["start", "load"]);
    expect(calls.filter((c) => c === "search")).toHaveLength(4);
    expect(calls.at(-1)).toBe("finalize");
  });

  it("every search failing marks the run failed (not 'no evidence') and never finalizes", async () => {
    const { ports, calls } = fakePorts({ search: async () => { throw new MemorySearchError("down"); } });
    const out = await executeMatch(ports, DEMO_WORKER.id, opportunity);
    expect(out).toMatchObject({ status: "failed", reason: "memory_unavailable" });
    expect(calls).not.toContain("finalize");
    expect(calls.some((c) => c.startsWith("fail:"))).toBe(true);
  });

  it("a partial provider failure still completes, with a warning and needs_review", async () => {
    let n = 0;
    let saved: RequirementResult[] = [];
    let warning: string | null = null;
    const { ports } = fakePorts({
      search: async () => { if (n++ === 0) throw new MemorySearchError("blip"); return []; },
      finalize: async (_id, db, w) => { warning = w; saved = db.results.map((r) => ({ requirementId: r.requirement_id, assessment: r.assessment }) as RequirementResult); return "completed"; },
    });
    const out = await executeMatch(ports, DEMO_WORKER.id, opportunity);
    expect(out.status).toBe("completed");
    expect(saved[0].assessment).toBe("needs_review");
    expect(warning).toMatch(/failed for 1 of 4/);
  });

  it("evidence changing mid-run: stale first, then one automatic retry completes", async () => {
    const { ports, calls } = fakePorts({ statuses: ["stale", "completed"] });
    const out = await executeMatch(ports, DEMO_WORKER.id, opportunity);
    expect(out.status).toBe("completed");
    expect(calls.filter((c) => c === "start")).toHaveLength(2);
  });

  it("evidence still changing after the retry is reported as stale, never completed", async () => {
    const { ports } = fakePorts({ statuses: ["stale", "stale"] });
    expect((await executeMatch(ports, DEMO_WORKER.id, opportunity)).status).toBe("stale");
  });

  it("an unexpected error fails the run and propagates (no silent success)", async () => {
    const { ports, calls } = fakePorts({ loadEvidence: async () => { throw new Error("db down"); } });
    await expect(executeMatch(ports, DEMO_WORKER.id, opportunity)).rejects.toThrow("db down");
    expect(calls.some((c) => c.startsWith("fail:"))).toBe(true);
  });
});

describe("computeChanges", () => {
  const res = (id: string, assessment: RequirementResult["assessment"], ev: string[] = []): RequirementResult => ({
    requirementId: id, originalText: "", mandatory: true, assessment, explanation: "", uncertainties: [], missingDocumentation: [],
    connections: ev.map((evidenceId) => ({ evidenceId, evidenceTitle: "t", evidenceDate: null, evidenceType: "other", verificationStatus: "self_reported", role: "direct", contribution: "", relevanceExplanation: "", memorySimilarity: null })),
  });

  it("reports only changed assessments, with the newly linked records", () => {
    const prev = [res("r1", "evidence_found", ["a"]), res("r4", "no_sufficient_evidence", ["a"])];
    const cur = [res("r1", "evidence_found", ["a", "b"]), res("r4", "evidence_found", ["a", "c"])];
    expect(computeChanges(prev, cur)).toEqual([
      { requirementId: "r4", before: "no_sufficient_evidence", after: "evidence_found", addedEvidenceIds: ["c"] },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(computeChanges([res("r1", "needs_review")], [res("r1", "needs_review", ["z"])])).toEqual([]);
  });
});
