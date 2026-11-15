import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Evidence } from "@/lib/types";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() => ({ submitEvidence: vi.fn(), readIndexState: vi.fn(), deleteMemoryDocument: vi.fn() }));
vi.mock("@/lib/server/memory/client", () => provider);
import { indexEvidence } from "@/lib/server/memory/indexing";

const record = Evidence.parse({
  id: "e0000000-0000-4000-8000-000000000001", workerId: "a0000000-0000-4000-8000-000000000001",
  type: "training", title: "Fictional heat-pump training", date: null, issuer: null,
  structuredData: {}, sourceKind: "seed", sourceAvailable: false, verificationStatus: "document_supplied",
  indexStatus: "pending", indexError: null, isSynthetic: true, version: 1,
  createdAt: "2026-11-14T17:00:00Z", updatedAt: "2026-11-14T17:00:00Z",
});
beforeEach(() => vi.resetAllMocks());

it("does not mark a newer evidence version indexed when an older submission finishes", async () => {
  const stored = { id: record.id, worker_id: record.workerId, version: 1, index_status: "pending" };
  let complete!: (status: string) => void;
  provider.submitEvidence.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const filters = new Map<string, unknown>();
  const query = {
    eq(key: string, value: unknown) { filters.set(key, value); return query; },
    then(resolve: (result: { error: null }) => void) {
      if ([...filters].every(([key, value]) => stored[key as keyof typeof stored] === value)) stored.index_status = "indexed";
      return Promise.resolve(resolve({ error: null }));
    },
  };
  const admin = { from: () => ({ update: () => query }) } as unknown as SupabaseClient;
  const pending = indexEvidence(admin, record);
  stored.version = 2; // User changes the record while the provider is working.
  complete("indexed");
  await pending;
  expect(stored.index_status).toBe("pending");
});
