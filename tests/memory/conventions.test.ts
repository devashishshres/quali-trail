import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryContent, memoryDate, memoryDocId, memoryMetadata, memoryNamespace, parseHitMetadata } from "@/lib/server/memory/conventions";
import { DEMO_EVIDENCE, DEMO_WORKER } from "@/supabase/seed/demo-data";
import type { Evidence } from "@/lib/types";

const d = DEMO_EVIDENCE[2];
const e: Evidence = {
  id: d.id, workerId: DEMO_WORKER.id, type: d.type, title: d.title, date: d.date, issuer: d.issuer,
  structuredData: d.structuredData, sourceKind: d.sourceKind, sourceAvailable: false, verificationStatus: "document_supplied",
  indexStatus: "pending", indexError: null, isSynthetic: true, version: 2, createdAt: "2026-11-14T17:00:00.000+00:00", updatedAt: "2026-11-14T17:00:00.000+00:00",
};

afterEach(() => vi.unstubAllEnvs());

describe("memory convention", () => {
  it("isolates a separate app version without changing evidence IDs", () => {
    vi.stubEnv("SUPERMEMORY_NAMESPACE_PREFIX", "qualitrail_our_version_");
    expect(memoryNamespace(DEMO_WORKER.id)).toBe(`qualitrail_our_version_worker_${DEMO_WORKER.id}`);
  });
  it("matches the live Evidence Passport convention: worker_<id> namespace, <id>_v<version> documents", () => {
    expect(memoryNamespace(DEMO_WORKER.id)).toBe(`worker_${DEMO_WORKER.id}`);
    expect(memoryDocId(e.id, 2)).toBe(`${e.id}_v2`);
    expect(memoryDocId(e.id, 2)).toBe(memoryDocId(e.id, 2)); // idempotent retries
    expect(memoryDocId(e.id, 1)).not.toBe(memoryDocId(e.id, 2)); // a new version is a new document
  });

  it("metadata maps a hit back to the evidence uuid, worker and version", () => {
    expect(memoryMetadata(e)).toMatchObject({ evidenceId: e.id, evidenceVersion: 2, workerId: DEMO_WORKER.id, evidenceType: "certification", isSynthetic: true });
    expect(memoryDate(e)).toBe(e.date); // Supermemory derives temporalContext from this
    expect(memoryDate({ date: null })).toBeUndefined();
  });

  it("searchable content never claims verification", () => {
    const c = memoryContent({ ...e, verificationStatus: "independently_confirmed" });
    expect(c).toContain(e.title);
    expect(c.toLowerCase()).not.toMatch(/verified|confirmed|authentic/);
  });

  it("parses valid hit metadata and rejects malformed or foreign hits", () => {
    const ok = { evidenceId: e.id, workerId: DEMO_WORKER.id, evidenceVersion: 2, evidenceType: "x" };
    expect(parseHitMetadata(ok, DEMO_WORKER.id)).toEqual({ evidenceId: e.id, version: 2 });
    expect(parseHitMetadata({ ...ok, workerId: "b0000000-0000-4000-8000-000000000009" }, DEMO_WORKER.id)).toBeNull(); // other worker
    expect(parseHitMetadata({ ...ok, evidenceId: "not-a-uuid" }, DEMO_WORKER.id)).toBeNull();
    expect(parseHitMetadata({ ...ok, evidenceVersion: "2" }, DEMO_WORKER.id)).toBeNull();
    expect(parseHitMetadata({ evidenceId: e.id, workerId: DEMO_WORKER.id, version: 2 }, DEMO_WORKER.id)).toBeNull(); // old key name
    expect(parseHitMetadata(null, DEMO_WORKER.id)).toBeNull();
    expect(parseHitMetadata({}, DEMO_WORKER.id)).toBeNull();
  });
});
