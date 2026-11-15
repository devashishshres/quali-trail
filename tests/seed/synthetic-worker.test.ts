import { describe, expect, it } from "vitest";
import { DEMO_EVIDENCE, DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, DEMO_WORKER } from "@/supabase/seed/demo-data";
import { derivedId, planDemoWorker } from "@/supabase/seed/synthetic-worker";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("planDemoWorker", () => {
  it("without a slug is the original Alex plan with its fixed ids", () => {
    const p = planDemoWorker({});
    expect(p.isOriginal).toBe(true);
    expect(p.worker.id).toBe(DEMO_WORKER.id);
    expect(p.evidence.map((e) => e.id)).toEqual(DEMO_EVIDENCE.map((e) => e.id));
  });

  it("a slug yields a distinct worker whose every id differs from Alex's", () => {
    const p = planDemoWorker({ slug: "jordan-rivera", name: "Jordan Rivera" });
    const alex = new Set([DEMO_WORKER.id, DEMO_OPPORTUNITY.id, ...DEMO_EVIDENCE.map((e) => e.id), ...DEMO_REQUIREMENTS.map((r) => r.id)]);
    const ids = [p.worker.id, p.opportunity.id, ...p.evidence.map((e) => e.id), ...p.requirements.map((r) => r.id)];
    for (const id of ids) {
      expect(id).toMatch(UUID);
      expect(alex.has(id)).toBe(false);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.isOriginal).toBe(false);
  });

  it("is deterministic per slug and different between slugs", () => {
    expect(derivedId("a-b-c", "x")).toBe(derivedId("a-b-c", "x"));
    expect(derivedId("a-b-c", "x")).not.toBe(derivedId("a-b-d", "x"));
    expect(planDemoWorker({ slug: "rehearsal-1", name: "R" }).worker.id).not.toBe(planDemoWorker({ slug: "rehearsal-2", name: "R" }).worker.id);
  });

  it("keeps the same four historical records and four requirements, so the 2-of-4 baseline is reproduced", () => {
    const p = planDemoWorker({ slug: "rehearsal-1", name: "R" });
    expect(p.evidence.map((e) => e.title)).toEqual(DEMO_EVIDENCE.map((e) => e.title));
    expect(p.requirements.map((r) => r.originalText)).toEqual(DEMO_REQUIREMENTS.map((r) => r.originalText));
  });

  it("labels the summary as fictional by default and caps its length", () => {
    expect(planDemoWorker({ slug: "rehearsal-1", name: "R" }).worker.summary).toMatch(/Fictional/);
    expect(planDemoWorker({ slug: "rehearsal-1", name: "R", summary: "x".repeat(5000) }).worker.summary).toHaveLength(1000);
  });

  it("refuses to overwrite the existing worker and rejects bad input", () => {
    expect(() => planDemoWorker({ slug: "alex-morgan", name: "Alex" })).toThrow(/existing demo worker/);
    expect(() => planDemoWorker({ slug: "Bad Slug", name: "x" })).toThrow(/DEMO_WORKER_SLUG/);
    expect(() => planDemoWorker({ slug: "jordan-rivera" })).toThrow(/DEMO_WORKER_NAME/);
  });
});
